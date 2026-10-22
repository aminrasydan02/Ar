'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { resources, columnType } = require('./resources');
const { hashPassword } = require('./auth');

const SCHEMA_VERSION = 2;

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_replies (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      username TEXT, process TEXT, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_issue_replies_issue ON issue_replies(issue_id);
  `);
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
