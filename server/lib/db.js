'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { resources, columnType } = require('./resources');
const { hashPassword } = require('./auth');

const SCHEMA_VERSION = 4;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT,
      role TEXT NOT NULL CHECK (role IN ('admin','planner','viewer')),
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      username TEXT, action TEXT, resource TEXT, record_id INTEGER
    );
  `);

  for (const [name, res] of Object.entries(resources)) {
    const cols = res.fields.map((f) => {
      let col = `${f.name} ${columnType(f)}`;
      if (f.type === 'ref') col += ` REFERENCES ${f.ref}(id) ON DELETE ${f.required ? 'CASCADE' : 'SET NULL'}`;
      return col;
    });
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (
      id INTEGER PRIMARY KEY,
      ${cols.join(',\n      ')},
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Columns added to a module after its table was first created.
    const existing = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
    for (const f of res.fields) {
      if (!existing.has(f.name)) db.exec(`ALTER TABLE ${name} ADD COLUMN ${f.name} ${columnType(f)}`);
    }
    for (const f of res.fields.filter((x) => x.unique)) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${name}_${f.name} ON ${name}(${f.name})`);
    }
    for (const f of res.fields.filter((x) => x.type === 'ref')) {
      db.exec(`CREATE INDEX IF NOT EXISTS ix_${name}_${f.name} ON ${name}(${f.name})`);
    }
  }
  // Version 2: each user has a job process, and issues have a discussion thread.
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userCols.has('process')) db.exec('ALTER TABLE users ADD COLUMN process TEXT');
  if (!userCols.has('theme')) db.exec('ALTER TABLE users ADD COLUMN theme TEXT'); // colour theme chosen by the user
  // Appointed by Admin: may change any data. Extra processes: edit rights of other processes too.
  if (!userCols.has('full_edit')) db.exec('ALTER TABLE users ADD COLUMN full_edit INTEGER NOT NULL DEFAULT 0');
  if (!userCols.has('extra_processes')) db.exec('ALTER TABLE users ADD COLUMN extra_processes TEXT');
  const auditCols = new Set(db.prepare('PRAGMA table_info(audit)').all().map((c) => c.name));
  if (!auditCols.has('before')) db.exec('ALTER TABLE audit ADD COLUMN before TEXT');
  if (!auditCols.has('after')) db.exec('ALTER TABLE audit ADD COLUMN after TEXT');
  // Which process may change which module. Admin changes it on the Access rights page.
  db.exec('CREATE TABLE IF NOT EXISTS process_rights (process TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY (process, resource))');
  // Default rights for each module the first time it appears; after that Admin's choice is kept.
  const seen = new Set(String((db.prepare("SELECT value FROM meta WHERE key = 'process_rights_modules'").get() || {}).value || '').split(',').filter(Boolean));
  const ins = db.prepare('INSERT OR IGNORE INTO process_rights (process, resource) VALUES (?, ?)');
  for (const [name, res] of Object.entries(resources)) {
    if (!seen.has(name)) { for (const p of res.processes || []) ins.run(p, name); seen.add(name); }
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('process_rights_modules', ?)").run([...seen].join(','));
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_replies (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      username TEXT, process TEXT, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_issue_replies_issue ON issue_replies(issue_id);
    -- Shop-floor layout: every save is a new version, so older layouts can be viewed or restored.
    CREATE TABLE IF NOT EXISTS floor_layouts (
      id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL UNIQUE,
      data TEXT NOT NULL,
      note TEXT, saved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // The four NEWAYS shop processes, added once. Admin can add more later.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'shop_processes_seeded'").get()) {
    const ins = db.prepare("INSERT OR IGNORE INTO shop_processes (code, name, seq, unit, extra_fields, active) VALUES (?, ?, ?, ?, ?, 'Yes')");
    // Order as in the combined dashboard: Polishing -> Bending -> Clinching after laser cutting.
    ins.run('LASER', 'Laser Cutting', 10, 'Sheet', 'Program / nesting ID, Sheets cut');
    ins.run('POLISH', 'Polishing', 20, 'Piece', 'Sand disc grit');
    ins.run('BEND', 'Bending', 30, 'Piece', 'No. of bends');
    ins.run('CLINCH', 'Clinching', 40, 'Piece', 'Clinch type');
    db.prepare("INSERT INTO meta (key, value) VALUES ('shop_processes_seeded', '1')").run();
  }
  // Standard reason codes from the Polishing report. Admin can add codes for other processes.
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'reason_codes_seeded'").get()) {
    const pol = db.prepare("SELECT id FROM shop_processes WHERE code = 'POLISH'").get();
    const ins = db.prepare('INSERT OR IGNORE INTO reason_codes (code, kind, description, process_id) VALUES (?, ?, ?, ?)');
    [
      ['DT-01', 'Downtime', 'Sand disc replacement (80G / 120G wear)'],
      ['DT-02', 'Downtime', 'Polishing head / belt tension adjustment'],
      ['DT-03', 'Downtime', 'Part fixture changeover & calibration'],
      ['DT-04', 'Downtime', 'First-piece QA inspection hold'],
      ['DT-05', 'Downtime', 'Dust extraction / vacuum cleaning stop'],
      ['RJ-01', 'Reject', 'Deep grit scratch / surface gouge'],
      ['RJ-02', 'Reject', 'Incomplete / under-polished surface'],
      ['RJ-03', 'Reject', 'Edge rounding / burr defect'],
      ['RJ-04', 'Reject', 'Raw material surface pitting'],
      ['RJ-05', 'Reject', 'Handling dent / post-polish mark'],
    ].forEach(([code, kind, text]) => ins.run(code, kind, text, pol ? pol.id : null));
    db.prepare("INSERT INTO meta (key, value) VALUES ('reason_codes_seeded', '1')").run();
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
}

// Creates the first admin account when the database has no users.
// Returns the generated password so it can be shown once on the console.
function ensureAdmin(db, password) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const pw = password || require('node:crypto').randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run('admin', 'Administrator', 'admin', hashPassword(pw));
  return pw;
}

module.exports = { open, ensureAdmin, SCHEMA_VERSION };
