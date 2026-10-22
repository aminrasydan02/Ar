'use strict';
// One way to open any supported database. SQLite (built into Node) is the default and needs nothing
// extra. Other databases are reached through their driver in a worker thread, so the app keeps its
// simple synchronous db.prepare(sql).all/get/run calls everywhere.
//
//   DATABASE_URL examples
//     (not set)                                        SQLite file data/smm.sqlite
//     sqlite:/var/lib/smm/smm.sqlite                   SQLite file
//     postgres://user:pass@host:5432/smm?sslmode=require   PostgreSQL, Supabase, Neon, RDS, Azure, Cloud SQL
//     mysql://user:pass@host:3306/smm                  MySQL, MariaDB, PlanetScale, TiDB, Aurora
//     mssql://user:pass@host:1433/smm                  SQL Server, Azure SQL
//     oracle://user:pass@host:1521/FREEPDB1            Oracle Database (service name after the slash)
//     d1://<account id>/<database id>                  Cloudflare D1 (CLOUDFLARE_API_TOKEN)
//     libsql://<db>-<org>.turso.io                     Turso / libSQL (LIBSQL_AUTH_TOKEN)
const fs = require('node:fs');
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { translate, splitStatements, mapCode } = require('./dialects');

const SCHEMES = {
  postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', mssql: 'mssql', sqlserver: 'mssql',
  oracle: 'oracle', d1: 'd1', libsql: 'libsql', turso: 'libsql', sqlite: 'sqlite', file: 'sqlite',
};
const DRIVERS = { postgres: 'pg', mysql: 'mysql2', mssql: 'mssql', oracle: 'oracledb' };

function parseTarget(target) {
  const t = String(target || '');
  const m = /^([a-z0-9]+):/i.exec(t);
  if (!m || !SCHEMES[m[1].toLowerCase()] || /^[a-z]:[\\/]/i.test(t)) return { dialect: 'sqlite', file: t };
  const dialect = SCHEMES[m[1].toLowerCase()];
  if (dialect === 'sqlite') return { dialect, file: t.replace(/^(sqlite|file):(\/\/)?/i, '') || ':memory:' };
  const url = new URL(t);
  if (dialect === 'mysql' && url.protocol === 'mariadb:') url.protocol = 'mysql:';
  if (dialect === 'postgres') url.protocol = 'postgres:';
  return { dialect, url: url.toString() };
}

// ---- SQLite ---------------------------------------------------------------------
function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.dialect = 'sqlite';
  db.columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  db.indexNames = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  db.constraintNames = () => new Set();
  db.useSchema = () => {};
  return db;
}

// ---- every other database ------------------------------------------------------
const CATALOG = {
  postgres: {
    columns: 'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
    indexes: 'SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()',
    constraints: "SELECT c.conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema()",
  },
  mysql: {
    columns: 'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
    indexes: 'SELECT DISTINCT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE()',
    constraints: 'SELECT constraint_name AS name FROM information_schema.table_constraints WHERE table_schema = DATABASE()',
  },
  mssql: {
    columns: 'SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)',
    indexes: 'SELECT name FROM sys.indexes WHERE name IS NOT NULL',
    constraints: 'SELECT name FROM sys.foreign_keys',
  },
  oracle: {
    columns: 'SELECT LOWER(column_name) AS name FROM user_tab_columns WHERE LOWER(table_name) = ?',
    indexes: 'SELECT LOWER(index_name) AS name FROM user_indexes',
    constraints: 'SELECT LOWER(constraint_name) AS name FROM user_constraints',
  },
};
CATALOG.d1 = CATALOG.libsql = {
  columns: "SELECT name FROM pragma_table_info(?)",
  indexes: "SELECT name FROM sqlite_master WHERE type = 'index'",
  constraints: "SELECT name FROM sqlite_master WHERE 0",
};

function openRemote(dialect, url, { timeoutMs = 60000 } = {}) {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { url, dialect, sab, port: port2 }, transferList: [port2] });
  worker.unref();
  port1.unref();
  let closed = false;

  // Sends one request and waits for the answer (the worker wakes us through the shared flag).
  function call(msg) {
    if (closed) throw new Error('The database connection is closed');
    Atomics.store(flag, 0, 0);
    port1.postMessage(msg);
    if (Atomics.wait(flag, 0, 0, timeoutMs) === 'timed-out') throw new Error(`The ${dialect} database did not answer within ${timeoutMs / 1000} s`);
    const got = receiveMessageOnPort(port1);
    if (!got) throw new Error('No answer from the database worker');
    if (got.message.error) throw Object.assign(new Error(got.message.error.message), { code: got.message.error.code });
    return got.message.result;
  }

  const db = { dialect, idents: new Set(), idTables: new Set(), refsTo: {} };
  db.useSchema = (tables) => {
    for (const t of tables) {
      for (const c of t.cols.filter((x) => x.ref)) (db.refsTo[c.ref] = db.refsTo[c.ref] || []).push({ table: t.name, col: c.name, onDelete: c.onDelete });
      db.idents.add(t.name);
      for (const c of t.cols) db.idents.add(c.name);
      if (t.cols.some((c) => c.name === 'id' && c.type === 'id')) db.idTables.add(t.name);
    }
  };
  const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : typeof v === 'bigint' ? Number(v) : v));
  const native = new Set(['d1', 'libsql']); // SQLite over HTTP: no translation needed

  // SQL Server cannot cascade deletes along several paths, so linked rows are removed (or unlinked) here first.
  function cascade(table, where, params) {
    const sub = `SELECT id FROM ${table}${where ? ` WHERE ${where}` : ''}`;
    for (const r of db.refsTo[table] || []) {
      if (r.onDelete === 'CASCADE') { cascade(r.table, `${r.col} IN (${sub})`, params); query(`DELETE FROM ${r.table} WHERE ${r.col} IN (${sub})`, params, true, true); }
      else query(`UPDATE ${r.table} SET ${r.col} = NULL WHERE ${r.col} IN (${sub})`, params, true, true);
    }
  }

  function query(sql, params, isRun, cascaded) {
    const del = dialect === 'mssql' && !cascaded && /^\s*DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]*))?$/i.exec(sql);
    if (del && db.refsTo[del[1]]) cascade(del[1], del[2] && del[2].trim(), params);
    let args = clean(params);
    // Oracle cannot tell the type of an empty bind value (COALESCE(?, number column) fails), so it is written as NULL.
    if (dialect === 'oracle' && args.includes(null)) {
      let i = 0;
      const keep = [];
      sql = mapCode(sql, (code) => code.replace(/\?/g, () => { const v = args[i++]; if (v === null) return 'NULL'; keep.push(v); return '?'; }));
      args = keep;
    }
    const t = native.has(dialect) ? { sql } : translate(sql, dialect, db.idents);
    let text = t.sql;
    const ins = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(text);
    const returnId = Boolean(isRun && ins && db.idTables.has(ins[1]) && ['postgres', 'mssql', 'oracle'].includes(dialect) && !/\)\s*SELECT\b/i.test(text));
    if (t.orReplace) {
      if (dialect === 'mysql') text = text.replace(/^\s*INSERT\s+INTO/i, 'REPLACE INTO');
      else if (dialect === 'postgres') {
        const [first, ...rest] = t.orReplace.cols;
        const q = (c) => translate(c, dialect, db.idents).sql;
        text += ` ON CONFLICT (${q(first)}) DO ${rest.length ? `UPDATE SET ${rest.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}` : 'NOTHING'}`;
      } else {
        // Remove the row with the same key first; the key is either the first ? or a quoted value.
        const first = /\bVALUES\s*\(\s*('(?:[^']|'')*'|\?)/i.exec(sql);
        const literal = first && first[1] !== '?';
        query(`DELETE FROM ${t.orReplace.table} WHERE ${t.orReplace.cols[0]} = ${literal ? first[1] : '?'}`, literal ? [] : [args[0]], true);
      }
    }
    if (t.orIgnore && dialect === 'postgres') text += ' ON CONFLICT DO NOTHING';
    if (t.orIgnore && dialect === 'mysql') text = text.replace(/^\s*INSERT\s+INTO/i, 'INSERT IGNORE INTO');
    try {
      return call({ op: 'query', sql: text, params: args, opts: { returnId } });
    } catch (err) {
      if (t.orIgnore && /UNIQUE constraint failed/.test(err.message)) return { rows: [], changes: 0 };
      if (process.env.DBX_DEBUG) console.error(`[dbx] ${err.message}\n${text}`);
      throw err;
    }
  }

  db.prepare = (sql) => ({
    all: (...p) => query(sql, p).rows,
    get: (...p) => query(sql, p).rows[0],
    run: (...p) => { const r = query(sql, p, true); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; },
  });
  db.exec = (sql) => {
    for (const stmt of splitStatements(sql)) {
      if (/^(BEGIN|START)(\s+TRANSACTION)?$/i.test(stmt)) call({ op: 'begin' });
      else if (/^(COMMIT|END)(\s+TRANSACTION)?$/i.test(stmt)) call({ op: 'commit' });
      else if (/^ROLLBACK(\s+TRANSACTION)?$/i.test(stmt)) call({ op: 'rollback' });
      else if (/^PRAGMA\b/i.test(stmt)) continue;
      else query(stmt, [], true);
    }
  };
  const cat = CATALOG[dialect];
  // Catalog queries are already in the database's own words, so they skip translation.
  const raw = (sql, params = []) => {
    let n = 0;
    const text = dialect === 'postgres' ? sql.replace(/\?/g, () => `$${++n}`) : dialect === 'mssql' ? sql.replace(/\?/g, () => `@p${++n}`) : dialect === 'oracle' ? sql.replace(/\?/g, () => `:${++n}`) : sql;
    return call({ op: 'query', sql: text, params, opts: {} }).rows;
  };
  db.raw = raw;
  db.columns = (table) => raw(cat.columns, [table]).map((r) => String(r.name).toLowerCase());
  db.indexNames = () => new Set(raw(cat.indexes).map((r) => String(r.name).toLowerCase()));
  db.constraintNames = () => new Set(raw(cat.constraints).map((r) => String(r.name).toLowerCase()));
  db.close = () => { if (closed) return; try { call({ op: 'close' }); } finally { closed = true; worker.terminate(); } };
  call({ op: 'connect' });
  return db;
}

// Opens a database from a file path or a DATABASE_URL.
function connect(target, options) {
  const t = parseTarget(target);
  return t.dialect === 'sqlite' ? openSqlite(t.file) : openRemote(t.dialect, t.url, options);
}

module.exports = { connect, parseTarget, DRIVERS };

// Removes the app's tables (used by tests and by the copy tool's --replace). Never called by the server.
function dropTables(db, names) {
  const d = db.dialect;
  if (d === 'sqlite' || d === 'd1' || d === 'libsql') {
    for (const n of [...names].reverse()) db.exec(`DROP TABLE IF EXISTS ${n}`);
    return;
  }
  const { QUOTE } = require('./dialects');
  const q = QUOTE[d];
  if (d === 'mssql') {
    for (const fk of db.raw('SELECT name, OBJECT_NAME(parent_object_id) AS t FROM sys.foreign_keys')) {
      if (names.includes(fk.t)) db.raw(`ALTER TABLE ${q(fk.t)} DROP CONSTRAINT ${q(fk.name)}`);
    }
  }
  for (const n of [...names].reverse()) {
    if (d === 'postgres') db.raw(`DROP TABLE IF EXISTS ${q(n)} CASCADE`);
    else if (d === 'mysql') { db.raw('SET FOREIGN_KEY_CHECKS = 0'); db.raw(`DROP TABLE IF EXISTS ${q(n)}`); db.raw('SET FOREIGN_KEY_CHECKS = 1'); }
    else if (d === 'mssql') db.raw(`DROP TABLE IF EXISTS ${q(n)}`);
    else if (d === 'oracle') for (const name of [n, q(n)]) { try { db.raw(`DROP TABLE ${name} CASCADE CONSTRAINTS PURGE`); } catch { /* not there */ } }
  }
}

module.exports.dropTables = dropTables;
