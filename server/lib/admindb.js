'use strict';
// Admin → Database & backup: which database is in use, row counts, downloads (backup and a SQL script
// for any database type), a backup now (to the data folder and S3/R2) and an export to BigQuery.
const transfer = require('./dbx/transfer');
const { schema, createScript, SCHEMA_VERSION } = require('./db');
const backup = require('./backup');
const bigquery = require('./bigquery');

const DIALECTS = { sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', mssql: 'SQL Server', oracle: 'Oracle', d1: 'Cloudflare D1', libsql: 'Turso / libSQL' };
const SQL_TARGETS = ['postgres', 'mysql', 'mssql', 'oracle', 'sqlite'];

function createDatabaseAdmin({ db, dataDir, drawingsDir, store, bigQuery, version, audit, HttpError, send }) {
  const stamp = () => new Date().toISOString().slice(0, 10);
  let last = { backup: null, bigquery: null };

  return async function handle(req, res, method, parts, user) {
    if (user.role !== 'admin') throw new HttpError(403, 'Only Admin can manage the database');
    const what = parts[1] || '';
    if (!what && method === 'GET') {
      const counts = schema().map((t) => ({ table: t.name, rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() || {}).n || 0) }));
      let backups = [];
      try { backups = await backup.listBackups({ dataDir, store }); } catch (err) { backups = [{ error: err.message }]; }
      return send(res, 200, {
        dialect: db.dialect, name: DIALECTS[db.dialect] || db.dialect, schema_version: SCHEMA_VERSION, counts,
        storage: store ? `${store.name} (${store.bucket})` : null, bigquery: bigQuery ? `${bigQuery.project}.${bigQuery.dataset}` : null,
        schedule: { backup_hours: Number(process.env.BACKUP_EVERY_HOURS ?? 24), bigquery_hours: Number(process.env.BIGQUERY_EVERY_HOURS || 0),
          keep_days: Number(process.env.BACKUP_KEEP_DAYS || 30), keep_months: Number(process.env.BACKUP_KEEP_MONTHS ?? 120) },
        last, backups: backups.slice(0, 30), sql_targets: SQL_TARGETS.map((d) => ({ id: d, name: DIALECTS[d] })),
      });
    }
    if (what === 'backup.json.gz' && method === 'GET') {
      const b = transfer.dump(db, schema(), { schemaVersion: SCHEMA_VERSION, app: version });
      audit(user, 'export', 'database', null, null, { format: 'backup', rows: Object.values(b.counts).reduce((a, c) => a + c, 0) });
      return send(res, 200, transfer.gzip(b), { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="smm-backup-${stamp()}.json.gz"` });
    }
    if (what === 'export.sql' && method === 'GET') {
      const d = new URL(req.url, 'http://x').searchParams.get('dialect') || 'postgres';
      if (!SQL_TARGETS.includes(d)) throw new HttpError(400, `Choose one of: ${SQL_TARGETS.join(', ')}`);
      const b = transfer.dump(db, schema(), { schemaVersion: SCHEMA_VERSION, app: version });
      audit(user, 'export', 'database', null, null, { format: `sql:${d}` });
      return send(res, 200, transfer.sqlScript(d, b, schema(), createScript(d)), { 'Content-Type': 'application/sql; charset=utf-8', 'Content-Disposition': `attachment; filename="smm-${d}-${stamp()}.sql"` });
    }
    if (what === 'backup' && method === 'POST') {
      const r = await backup.runBackup({ db, dataDir, store, drawingsDir, app: version });
      last.backup = { at: new Date().toISOString(), ...r };
      audit(user, 'backup', 'database', null, null, r);
      return send(res, 201, r);
    }
    if (what === 'bigquery' && method === 'POST') {
      if (!bigQuery) throw new HttpError(400, 'BigQuery is not set up (BIGQUERY_PROJECT and a service account key)');
      const b = transfer.dump(db, schema());
      const r = await bigquery.exportToBigQuery(bigQuery, schema(), b.tables);
      last.bigquery = { at: new Date().toISOString(), tables: Object.keys(r).length };
      audit(user, 'export', 'database', null, null, { format: 'bigquery', tables: Object.keys(r).length });
      return send(res, 201, { tables: r });
    }
    throw new HttpError(404, 'Not found');
  };
}

module.exports = { createDatabaseAdmin, DIALECTS };
