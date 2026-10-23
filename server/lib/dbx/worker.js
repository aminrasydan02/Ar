'use strict';
// Runs in a worker thread: talks to the database with its own (asynchronous) driver,
// while the main thread waits on a shared flag. See bridge.js.
const { workerData } = require('node:worker_threads');

const { url, dialect, sab, port } = workerData;
const flag = new Int32Array(sab);

function need(name) {
  try { return require(name); } catch (e) {
    throw new Error(`The ${dialect} driver is not installed. Run: npm install ${name}`);
  }
}

// Every driver reports duplicates and missing links its own way; the app expects SQLite's words.
function normalise(err) {
  const codes = [err.code, err.errno, err.errorNum, err.number, err.originalError && err.originalError.info && err.originalError.info.number].filter((x) => x !== undefined).map(String);
  const has = (...list) => list.some((c) => codes.includes(c));
  const msg = String(err.message || err);
  const e = new Error(msg);
  if (has('23505', 'ER_DUP_ENTRY', '1062', '2627', '2601') || /ORA-00001/.test(msg) || /UNIQUE constraint failed/i.test(msg)) e.message = `UNIQUE constraint failed: ${msg}`;
  else if (has('23503', 'ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED_2', '1451', '1452', '547') || /ORA-0229[12]/.test(msg) || /FOREIGN KEY constraint failed/i.test(msg)) e.message = `FOREIGN KEY constraint failed: ${msg}`;
  e.code = codes[0] || '';
  return e;
}

// ---- drivers ----------------------------------------------------------------
async function makeDriver() {
  const u = new URL(url);
  const user = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const tls = u.searchParams.get('ssl') || u.searchParams.get('sslmode');

  if (dialect === 'postgres') {
    const pg = need('pg');
    // Whole numbers and sums come back as numbers, as in SQLite.
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    const client = new pg.Client({ connectionString: url, ssl: tls && tls !== 'disable' ? { rejectUnauthorized: tls === 'verify-full' } : undefined });
    await client.connect();
    return {
      async query(sql, params, opts) {
        const r = await client.query(opts.returnId ? `${sql} RETURNING id` : sql, params);
        return { rows: r.rows, changes: r.rowCount || 0, lastInsertRowid: opts.returnId && r.rows[0] ? r.rows[0].id : undefined };
      },
      begin: () => client.query('BEGIN'), commit: () => client.query('COMMIT'), rollback: () => client.query('ROLLBACK'),
      close: () => client.end(),
    };
  }

  if (dialect === 'mysql') {
    const mysql = need('mysql2/promise');
    const conn = await mysql.createConnection({
      host: u.hostname, port: Number(u.port || 3306), user, password, database,
      decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false, dateStrings: true, multipleStatements: false,
      ssl: tls && tls !== 'disable' && tls !== 'false' ? { rejectUnauthorized: tls === 'verify-full' } : undefined,
    });
    await conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')");
    return {
      async query(sql, params) {
        const [r] = await conn.query(sql, params);
        if (Array.isArray(r)) return { rows: r, changes: 0 };
        return { rows: [], changes: r.affectedRows || 0, lastInsertRowid: r.insertId || undefined };
      },
      begin: () => conn.query('START TRANSACTION'), commit: () => conn.query('COMMIT'), rollback: () => conn.query('ROLLBACK'),
      close: () => conn.end(),
    };
  }

  if (dialect === 'mssql') {
    const sql = need('mssql');
    // One connection, so a transaction started with BEGIN stays on it.
    const pool = await new sql.ConnectionPool({
      server: u.hostname, port: Number(u.port || 1433), user, password, database,
      options: { encrypt: tls !== 'disable' && tls !== 'false', trustServerCertificate: u.searchParams.get('trustServerCertificate') === 'true' },
      pool: { max: 1, min: 1 },
    }).connect();
    let tx = null;
    const run = async (text, params = []) => {
      const req = tx ? new sql.Request(tx) : pool.request();
      params.forEach((v, i) => req.input(`p${i + 1}`, v));
      // Without values the text runs as a plain batch, so SET options (e.g. IDENTITY_INSERT) stay on.
      return params.length ? req.query(text) : req.batch(text);
    };
    return {
      async query(text, params, opts) {
        const r = await run(opts.returnId ? `${text}; SELECT CAST(SCOPE_IDENTITY() AS INT) AS id` : text, params);
        const sets = r.recordsets || [];
        const last = opts.returnId ? sets[sets.length - 1] : null;
        return { rows: opts.returnId ? [] : (r.recordset || []), changes: (r.rowsAffected || []).reduce((a, b) => a + b, 0), lastInsertRowid: last && last[0] ? last[0].id : undefined };
      },
      begin: async () => { tx = new sql.Transaction(pool); await tx.begin(); },
      commit: async () => { const t = tx; tx = null; if (t) await t.commit(); },
      rollback: async () => { const t = tx; tx = null; if (t) { try { await t.rollback(); } catch { /* already rolled back */ } } },
      close: () => pool.close(),
    };
  }

  if (dialect === 'oracle') {
    const oracledb = need('oracledb');
    oracledb.fetchAsString = [oracledb.CLOB];
    const conn = await oracledb.getConnection({ user, password, connectString: `${u.hostname}:${u.port || 1521}/${database}` });
    let inTx = false;
    const lower = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      async query(text, params, opts) {
        const binds = [...params];
        if (opts.returnId) binds.push({ dir: oracledb.BIND_OUT, type: oracledb.NUMBER });
        const r = await conn.execute(opts.returnId ? `${text} RETURNING id INTO :${binds.length}` : text, binds,
          { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: !inTx });
        const id = opts.returnId && r.outBinds ? [].concat(r.outBinds[r.outBinds.length - 1])[0] : undefined;
        return { rows: (r.rows || []).map(lower), changes: r.rowsAffected || 0, lastInsertRowid: id };
      },
      begin: async () => { inTx = true; }, commit: async () => { inTx = false; await conn.commit(); }, rollback: async () => { inTx = false; await conn.rollback(); },
      close: () => conn.close(),
    };
  }

  // Cloudflare D1 and Turso / libSQL speak SQLite over HTTPS, so no driver is needed.
  if (dialect === 'd1') {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN for Cloudflare D1');
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${u.hostname}/d1/database/${database}/query`;
    const send = async (text, params) => {
      const res = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql: text, params }) });
      const body = await res.json();
      if (!body.success) throw new Error((body.errors || []).map((x) => x.message).join('; ') || `D1 error ${res.status}`);
      const r = body.result[0] || {};
      return { rows: r.results || [], changes: (r.meta && r.meta.changes) || 0, lastInsertRowid: r.meta && r.meta.last_row_id };
    };
    // The D1 HTTP API runs each statement on its own: BEGIN/COMMIT cannot group them.
    const none = async () => {};
    return { query: send, begin: none, commit: none, rollback: none, close: none };
  }

  if (dialect === 'libsql') {
    const token = process.env.LIBSQL_AUTH_TOKEN || u.searchParams.get('authToken');
    const endpoint = `https://${u.host}/v2/pipeline`;
    let baton = null;
    const arg = (v) => (v === null || v === undefined ? { type: 'null' } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }) : { type: 'text', value: String(v) });
    const val = (c) => (c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.type === 'float' ? Number(c.value) : c.value);
    const send = async (text, params) => {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ baton, requests: [{ type: 'execute', stmt: { sql: text, args: (params || []).map(arg) } }] }) });
      const body = await res.json();
      baton = body.baton || null;
      const r = body.results && body.results[0];
      if (!r || r.type === 'error') throw new Error((r && r.error && r.error.message) || `libSQL error ${res.status}`);
      const x = r.response.result;
      return { rows: x.rows.map((row) => Object.fromEntries(x.cols.map((c, i) => [c.name, val(row[i])]))), changes: x.affected_row_count, lastInsertRowid: x.last_insert_rowid ? Number(x.last_insert_rowid) : undefined };
    };
    return { query: send, begin: () => send('BEGIN'), commit: () => send('COMMIT'), rollback: () => send('ROLLBACK'), close: async () => {} };
  }

  throw new Error(`Unknown database type: ${dialect}`);
}

// ---- message loop -------------------------------------------------------------
let driver = null;
port.on('message', async (msg) => {
  let reply;
  try {
    if (!driver) driver = await makeDriver();
    let result;
    if (msg.op === 'query') result = await driver.query(msg.sql, msg.params || [], msg.opts || {});
    else if (msg.op === 'begin' || msg.op === 'commit' || msg.op === 'rollback') { await driver[msg.op](); result = {}; }
    else if (msg.op === 'connect') result = {};
    else if (msg.op === 'close') { await driver.close(); driver = null; result = {}; }
    reply = { result };
  } catch (err) {
    const e = normalise(err);
    reply = { error: { message: e.message, code: e.code } };
  }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
