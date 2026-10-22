'use strict';
const { resources } = require('./resources');
const { hashPassword } = require('./auth');
const dbx = require('./dbx');
const { TYPES, NOW_DEFAULT, QUOTE, RESERVED } = require('./dbx/dialects');

const SCHEMA_VERSION = 5;

// Opens the database named by a file path or a DATABASE_URL (see dbx/index.js) and brings its tables up to date.
function open(target, options) {
  const db = dbx.connect(target, options);
  db.useSchema(schema());
  migrate(db);
  return db;
}

// Every table, in database-neutral types: id, int, real, key (short, indexed text), text, long.
const now = 'now';
function schema() {
  const tables = [
    { name: 'meta', cols: [{ name: 'key', type: 'key', pk: true }, { name: 'value', type: 'text' }] },
    { name: 'users', cols: [
      { name: 'id', type: 'id' },
      { name: 'username', type: 'key', notNull: true, unique: true, nocase: true },
      { name: 'full_name', type: 'text' },
      { name: 'role', type: 'key', notNull: true, check: "role IN ('admin','planner','viewer')" },
      { name: 'password_hash', type: 'text', notNull: true },
      { name: 'active', type: 'int', notNull: true, default: 1 },
      { name: 'created_at', type: 'key', notNull: true, default: now },
      { name: 'process', type: 'text' }, { name: 'theme', type: 'text' },
      // Appointed by Admin: may change any data. Extra processes: edit rights of other processes too.
      { name: 'full_edit', type: 'int', notNull: true, default: 0 },
      { name: 'extra_processes', type: 'text' }] },
    { name: 'sessions', cols: [{ name: 'token', type: 'key', pk: true }, { name: 'user_id', type: 'int', notNull: true, ref: 'users', onDelete: 'CASCADE' }, { name: 'expires', type: 'key', notNull: true }] },
    { name: 'audit', cols: [{ name: 'id', type: 'id' }, { name: 'at', type: 'key', notNull: true, default: now }, { name: 'username', type: 'text' }, { name: 'action', type: 'text' },
      { name: 'resource', type: 'text' }, { name: 'record_id', type: 'int' }, { name: 'before', type: 'long' }, { name: 'after', type: 'long' }] },
  ];
  for (const [name, res] of Object.entries(resources)) {
    tables.push({ name, cols: [
      { name: 'id', type: 'id' },
      ...res.fields.map((f) => ({
        name: f.name,
        type: f.type === 'ref' ? 'int' : f.type === 'number' ? 'real' : f.unique ? 'key' : ['textarea', 'json'].includes(f.type) ? 'long' : 'text',
        ...(f.type === 'ref' ? { ref: f.ref, onDelete: f.required ? 'CASCADE' : 'SET NULL' } : {}),
      })),
      { name: 'created_at', type: 'key', notNull: true, default: now },
      { name: 'updated_at', type: 'key', notNull: true, default: now }],
    indexes: [
      ...res.fields.filter((f) => f.unique).map((f) => ({ name: `ux_${name}_${f.name}`, cols: [f.name], unique: true })),
      ...res.fields.filter((f) => f.type === 'ref').map((f) => ({ name: `ix_${name}_${f.name}`, cols: [f.name] }))] });
  }
  // Which process may change which module. Admin changes it on the Access rights page.
  tables.push({ name: 'process_rights', cols: [{ name: 'process', type: 'key', notNull: true }, { name: 'resource', type: 'key', notNull: true }], pk: ['process', 'resource'] });
  tables.push({ name: 'issue_replies', cols: [{ name: 'id', type: 'id' }, { name: 'issue_id', type: 'int', notNull: true, ref: 'issues', onDelete: 'CASCADE' },
    { name: 'at', type: 'key', notNull: true, default: now }, { name: 'username', type: 'text' }, { name: 'process', type: 'text' }, { name: 'message', type: 'long', notNull: true }],
  indexes: [{ name: 'ix_issue_replies_issue', cols: ['issue_id'] }] });
  // Shop-floor layout: every save is a new version, so older layouts can be viewed or restored.
  tables.push({ name: 'floor_layouts', cols: [{ name: 'id', type: 'id' }, { name: 'version', type: 'int', notNull: true, unique: true }, { name: 'data', type: 'long', notNull: true },
    { name: 'note', type: 'text' }, { name: 'saved_by', type: 'text' }, { name: 'created_at', type: 'key', notNull: true, default: now }] });
  return tables;
}

// Column definition in the database's own words.
function columnSql(d, c, inline) {
  const q = (w) => (d !== 'sqlite' && RESERVED[d] && RESERVED[d].includes(w) ? QUOTE[d](w) : w);
  if (c.type === 'id') return `${q(c.name)} ${TYPES[d].id}`;
  let sql = `${q(c.name)} ${TYPES[d][c.type]}`;
  if (c.nocase && d === 'sqlite') sql += ' COLLATE NOCASE';
  if (c.default !== undefined) sql += ` DEFAULT ${c.default === now ? NOW_DEFAULT[d] : c.default}`;
  if (c.notNull || c.pk) sql += ' NOT NULL';
  if (c.unique && inline) sql += ' UNIQUE';
  if (c.pk && inline) sql += ' PRIMARY KEY';
  if (c.check) sql += ` CHECK (${c.check})`;
  if (c.ref && d === 'sqlite') sql += ` REFERENCES ${c.ref}(id) ON DELETE ${c.onDelete}`;
  return sql;
}

// CREATE statements for a new, empty database of the given type (used by the SQL export).
function createScript(d) {
  const q = (w) => (d !== 'sqlite' && RESERVED[d].includes(w) ? QUOTE[d](w) : w);
  const out = [];
  const tables = schema();
  for (const t of tables) {
    const cols = t.cols.map((c) => columnSql(d, c, true));
    if (t.pk) cols.push(`PRIMARY KEY (${t.pk.map(q).join(', ')})`);
    out.push(`CREATE TABLE ${q(t.name)} (\n  ${cols.join(',\n  ')}\n)`);
  }
  for (const t of tables) out.push(...(t.indexes || []).map((ix) => indexSql(d, t, ix)));
  if (d !== 'sqlite') for (const t of tables) out.push(...t.cols.filter((c) => c.ref).map((c) => foreignKeySql(d, t, c)));
  return out;
}
function indexSql(d, t, ix) {
  const q = (w) => (d !== 'sqlite' && RESERVED[d].includes(w) ? QUOTE[d](w) : w);
  // SQL Server allows only one empty value in a unique index unless empty values are left out.
  const where = d === 'mssql' && ix.unique ? ` WHERE ${ix.cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ')}` : '';
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ix.name} ON ${q(t.name)} (${ix.cols.map(q).join(', ')})${where}`;
}
function foreignKeySql(d, t, c) {
  const q = (w) => (RESERVED[d].includes(w) ? QUOTE[d](w) : w);
  // SQL Server refuses chains of cascading deletes; the adapter removes linked rows itself there.
  const onDelete = d === 'mssql' ? '' : ` ON DELETE ${c.onDelete}`;
  return `ALTER TABLE ${q(t.name)} ADD CONSTRAINT fk_${t.name}_${c.name} FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.ref)} (id)${onDelete}`;
}

function migrate(db) {
  const d = db.dialect === 'd1' || db.dialect === 'libsql' ? 'sqlite' : db.dialect;
  const q = (w) => (d !== 'sqlite' && RESERVED[d].includes(w) ? QUOTE[d](w) : w);
  const tables = schema();
  // Table definitions are already written for this database, so they skip SQL translation.
  const ddl = (sql) => (db.raw ? db.raw(sql) : db.exec(sql));
  // Tables first (links are added afterwards on servers, because a table may link to one made later).
  for (const t of tables) {
    const have = new Set(db.columns(t.name));
    if (!have.size) {
      const cols = t.cols.map((c) => columnSql(d, c, true));
      if (t.pk) cols.push(`PRIMARY KEY (${t.pk.map(q).join(', ')})`);
      ddl(`CREATE TABLE ${d === 'sqlite' ? 'IF NOT EXISTS ' : ''}${q(t.name)} (\n  ${cols.join(',\n  ')}\n)`);
      continue;
    }
    // Columns added to a module after its table was first created.
    for (const c of t.cols.filter((x) => !have.has(x.name))) {
      const col = columnSql(d, { ...c, unique: false }, false);
      ddl(d === 'mssql' ? `ALTER TABLE ${q(t.name)} ADD ${col}` : d === 'oracle' ? `ALTER TABLE ${q(t.name)} ADD (${col})` : `ALTER TABLE ${q(t.name)} ADD COLUMN ${col}`);
    }
  }
  const indexes = db.indexNames();
  for (const t of tables) {
    for (const ix of t.indexes || []) {
      if (!indexes.has(ix.name)) ddl(indexSql(d, t, ix));
    }
  }
  if (d !== 'sqlite') {
    const fks = db.constraintNames();
    for (const t of tables) {
      for (const c of t.cols.filter((x) => x.ref)) {
        if (!fks.has(`fk_${t.name}_${c.name}`)) ddl(foreignKeySql(d, t, c));
      }
    }
  }
  // Default rights for each module the first time it appears; after that Admin's choice is kept.
  const seen = new Set(String((db.prepare("SELECT value FROM meta WHERE key = 'process_rights_modules'").get() || {}).value || '').split(',').filter(Boolean));
  const ins = db.prepare('INSERT OR IGNORE INTO process_rights (process, resource) VALUES (?, ?)');
  for (const [name, res] of Object.entries(resources)) {
    if (!seen.has(name)) { for (const p of res.processes || []) ins.run(p, name); seen.add(name); }
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('process_rights_modules', ?)").run([...seen].join(','));
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

module.exports = { open, ensureAdmin, schema, createScript, SCHEMA_VERSION };
