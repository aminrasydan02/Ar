'use strict';
// Sheet Metal Manager web server.
//   node server/server.js                      start the server
//   node server/server.js seed-demo            add the NEWAYS demo project
//   node server/server.js reset-password <user> <new password>
//
// Database and backups (see docs/PANDUAN-DATABASE.md):
//   DATABASE_URL picks the database: SQLite file by default, or postgres://, mysql://, mssql://, oracle://, d1://, libsql://
//   node server/server.js backup-now                     backup to data/backups (and S3 / R2 when set up)
//   node server/server.js export-backup <file.json.gz>   whole database to one backup file
//   node server/server.js import-backup <file> [--replace]   load a backup into the current database
//   node server/server.js export-sql <postgres|mysql|mssql|oracle|sqlite> <file.sql>
//   node server/server.js copy-to <DATABASE_URL> [--replace]  copy everything to another database and check it
//   node server/server.js verify-backup <file>           compare a backup with the current database
//   node server/server.js export-bigquery                copy every table to Google BigQuery
//
// Settings come from environment variables or config.json next to package.json:
//   PORT (default 8080), HOST (default 0.0.0.0), DATA_DIR (default ./data),
//   SECURE_COOKIES=1 when served over HTTPS, ADMIN_PASSWORD for the first admin,
//   COMPANY (name printed on Job Travellers and reports).
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const db = require('./lib/db');
const { createApp, VERSION } = require('./lib/app');
const { hashPassword } = require('./lib/auth');
const { seedDemo } = require('./seed');
const dbx = require('./lib/dbx');
const transfer = require('./lib/dbx/transfer');
const backup = require('./lib/backup');
const { storageFromEnv } = require('./lib/objstore');
const bigquery = require('./lib/bigquery');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const fromFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const env = process.env;
  return {
    port: Number(env.PORT || fromFile.port || 8080),
    host: env.HOST || fromFile.host || '0.0.0.0',
    dataDir: path.resolve(ROOT, env.DATA_DIR || fromFile.dataDir || 'data'),
    secureCookies: (env.SECURE_COOKIES || String(fromFile.secureCookies || '')) === '1' || fromFile.secureCookies === true,
    adminPassword: env.ADMIN_PASSWORD || fromFile.adminPassword,
    company: env.COMPANY || fromFile.company || 'NEWBILLION Precision Metal Sdn Bhd',
    // Where the data lives. Never put a password in config.json that is committed; use the environment.
    databaseUrl: env.DATABASE_URL || fromFile.databaseUrl || '',
    // Public address when published, e.g. PUBLIC_URL=https://smm.example.com (Cloudflare Tunnel).
    publicHosts: String(env.PUBLIC_URL || fromFile.publicUrl || '').split(',').map((u) => { try { return new URL(u.trim()).host; } catch { return ''; } }).filter(Boolean),
  };
}

async function main() {
  const cfg = loadConfig();
  const database = db.open(cfg.databaseUrl || path.join(cfg.dataDir, 'smm.sqlite'));
  const [cmd, ...args] = process.argv.slice(2);
  const store = storageFromEnv();
  const bq = bigquery.configFromEnv();
  const replace = args.includes('--replace');
  const fileArg = args.find((a) => !a.startsWith('--'));
  const drawingsDir = path.join(cfg.dataDir, 'drawings');

  if (cmd === 'backup-now') {
    await backup.runBackup({ db: database, dataDir: cfg.dataDir, store, drawingsDir, app: VERSION, log: console.log });
    return database.close();
  }
  if (cmd === 'export-backup') {
    const file = fileArg || path.join(cfg.dataDir, 'backups', backup.stampName());
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const b = transfer.dump(database, db.schema(), { schemaVersion: db.SCHEMA_VERSION, app: VERSION });
    fs.writeFileSync(file, transfer.gzip(b));
    console.log(`Backup written: ${file} (${Object.values(b.counts).reduce((a, c) => a + c, 0)} rows from ${database.dialect})`);
    return database.close();
  }
  if (cmd === 'import-backup' || cmd === 'verify-backup') {
    if (!fileArg) throw new Error(`Usage: ${cmd} <backup file>${cmd === 'import-backup' ? ' [--replace]' : ''}`);
    const b = transfer.readBackup(fs.readFileSync(fileArg));
    if (cmd === 'import-backup') {
      const loaded = transfer.load(database, db.schema(), b, { replace });
      console.log(`Loaded ${Object.values(loaded).reduce((a, c) => a + c, 0)} rows into ${database.dialect}.`);
    }
    const diff = transfer.verify(database, db.schema(), b);
    console.log(diff.length ? `Differences:\n${diff.map((x) => `  ${x.table}: backup ${x.backup}, database ${x.database}`).join('\n')}` : 'Check passed: every table has the same number of rows as the backup.');
    if (diff.length) process.exitCode = 1;
    return database.close();
  }
  if (cmd === 'export-sql') {
    const [dialect, file] = args;
    if (!['postgres', 'mysql', 'mssql', 'oracle', 'sqlite'].includes(dialect) || !file) throw new Error('Usage: export-sql <postgres|mysql|mssql|oracle|sqlite> <file.sql>');
    const b = transfer.dump(database, db.schema(), { schemaVersion: db.SCHEMA_VERSION, app: VERSION });
    fs.writeFileSync(file, transfer.sqlScript(dialect, b, db.schema(), db.createScript(dialect)));
    console.log(`SQL script for ${dialect} written: ${file}`);
    return database.close();
  }
  if (cmd === 'copy-to') {
    if (!fileArg) throw new Error('Usage: copy-to <DATABASE_URL or sqlite file> [--replace]');
    const b = transfer.dump(database, db.schema(), { schemaVersion: db.SCHEMA_VERSION, app: VERSION });
    const target = db.open(fileArg);
    const loaded = transfer.load(target, db.schema(), b, { replace });
    const diff = transfer.verify(target, db.schema(), b);
    console.log(`Copied ${Object.values(loaded).reduce((a, c) => a + c, 0)} rows from ${database.dialect} to ${target.dialect}.`);
    console.log(diff.length ? `Check FAILED: ${JSON.stringify(diff)}` : 'Check passed: every table has the same number of rows.');
    if (diff.length) process.exitCode = 1;
    target.close();
    return database.close();
  }
  if (cmd === 'export-bigquery') {
    if (!bq) throw new Error('Set BIGQUERY_PROJECT and GOOGLE_APPLICATION_CREDENTIALS first');
    const b = transfer.dump(database, db.schema());
    await bigquery.exportToBigQuery(bq, db.schema(), b.tables, { log: console.log });
    console.log(`Exported to BigQuery dataset ${bq.project}.${bq.dataset}.`);
    return database.close();
  }

  if (cmd === 'seed-demo') {
    db.ensureAdmin(database, cfg.adminPassword);
    console.log(seedDemo(database) ? 'NEWAYS demo project added.' : 'NEWAYS project already exists.');
    return;
  }
  if (cmd === 'reset-password') {
    const [username, password] = args;
    if (!username || !password || password.length < 8) {
      console.error('Usage: reset-password <username> <new password (8+ characters)>');
      process.exitCode = 1;
      return;
    }
    const r = database.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE username = ?').run(hashPassword(password), username);
    console.log(r.changes ? `Password changed for ${username}.` : `No user called ${username}.`);
    return;
  }

  const firstPassword = db.ensureAdmin(database, cfg.adminPassword);
  if (firstPassword && !cfg.adminPassword) {
    console.log(`First start: sign in as "admin" with password: ${firstPassword}`);
    console.log('Change it under My account after signing in.');
  }

  const server = http.createServer(createApp({
    db: database,
    dataDir: cfg.dataDir,
    store,
    bigQuery: bq,
    drawingsDir,
    secureCookies: cfg.secureCookies,
    company: cfg.company,
    publicHosts: cfg.publicHosts,
  }));
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Sheet Metal Manager ${VERSION} running at http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    console.log(`Data folder: ${cfg.dataDir} (back this up, including drawings/)`);
    console.log(`Database: ${database.dialect}${store ? ` · backups to ${store.name}` : ''}${bq ? ` · BigQuery ${bq.project}.${bq.dataset}` : ''}`);
  });

  // Automatic backups (default once a day) and BigQuery exports (off unless BIGQUERY_EVERY_HOURS is set).
  const every = (hours, job) => { if (hours > 0) setInterval(() => job().catch((e) => console.error(e.message)), hours * 3600000).unref(); };
  every(Number(process.env.BACKUP_EVERY_HOURS ?? 24), () => backup.runBackup({ db: database, dataDir: cfg.dataDir, store, drawingsDir, app: VERSION, log: console.log }));
  if (bq) every(Number(process.env.BIGQUERY_EVERY_HOURS || 0), async () => { await bigquery.exportToBigQuery(bq, db.schema(), transfer.dump(database, db.schema()).tables); console.log('BigQuery export done.'); });
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
