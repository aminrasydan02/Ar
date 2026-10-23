'use strict';
// Long-term backups: a checked, compressed copy of the whole database (and the drawing files) kept in
// the data folder and, when set up, in Amazon S3 or Cloudflare R2. Old copies are thinned out:
// every backup for BACKUP_KEEP_DAYS days, then one per month for BACKUP_KEEP_MONTHS months (0 = keep forever).
const fs = require('node:fs');
const path = require('node:path');
const transfer = require('./dbx/transfer');
const { schema, SCHEMA_VERSION } = require('./db');

const NAME = /^smm-(\d{8})-(\d{6})\.json\.gz$/;
const stampName = (d = new Date()) => `smm-${d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.json.gz`;

// Which backup names to delete under the keep rules. Names sort by date.
function toPrune(names, { keepDays = 30, keepMonths = 120, now = new Date() } = {}) {
  const dated = names.filter((n) => NAME.test(n)).sort();
  const dayMs = 86400000;
  const seenMonth = new Set();
  const drop = [];
  for (const n of dated) {
    const [, d] = NAME.exec(n);
    const when = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
    const ageDays = (now.getTime() - when) / dayMs;
    const month = d.slice(0, 6);
    const firstOfMonth = !seenMonth.has(month);
    seenMonth.add(month);
    if (ageDays <= keepDays) continue;
    if (firstOfMonth && (!keepMonths || ageDays <= keepMonths * 31)) continue;
    drop.push(n);
  }
  return drop;
}

function keepRules(env = process.env) {
  return { keepDays: Number(env.BACKUP_KEEP_DAYS || 30), keepMonths: Number(env.BACKUP_KEEP_MONTHS ?? 120) };
}

// Makes one backup now. Returns what was written and uploaded.
async function runBackup({ db, dataDir, store, drawingsDir, app, log = () => {} }) {
  const backup = transfer.dump(db, schema(), { schemaVersion: SCHEMA_VERSION, app });
  const file = stampName();
  const buf = transfer.gzip(backup);
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  const result = { file, size: buf.length, rows: Object.values(backup.counts).reduce((a, b) => a + b, 0), sha256: backup.sha256, uploaded: false, drawings: 0 };
  const rules = keepRules();
  for (const n of toPrune(fs.readdirSync(dir), rules)) fs.rmSync(path.join(dir, n), { force: true });
  if (store) {
    await store.put(`db/${file}`, buf, 'application/gzip');
    result.uploaded = true;
    // Drawing files are only added: a file already in the bucket is not sent again.
    if (drawingsDir && fs.existsSync(drawingsDir)) {
      const have = new Set((await store.list()).map((x) => x.key));
      for (const f of fs.readdirSync(drawingsDir)) {
        const full = path.join(drawingsDir, f);
        if (!fs.statSync(full).isFile() || have.has(`drawings/${f}`)) continue;
        await store.put(`drawings/${f}`, fs.readFileSync(full));
        result.drawings++;
      }
    }
    const remote = (await store.list()).filter((x) => x.key.startsWith('db/')).map((x) => x.key.slice(3));
    for (const n of toPrune(remote, rules)) await store.remove(`db/${n}`);
  }
  log(`Backup ${file}: ${result.rows} rows, ${(buf.length / 1024).toFixed(0)} KB${result.uploaded ? `, uploaded to ${store.name}` : ''}${result.drawings ? `, ${result.drawings} new drawing files` : ''}`);
  return result;
}

// Backups in the data folder and in the bucket, newest first.
async function listBackups({ dataDir, store }) {
  const dir = path.join(dataDir, 'backups');
  const local = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => NAME.test(n)).map((n) => ({ file: n, size: fs.statSync(path.join(dir, n)).size, where: 'local' })) : [];
  const remote = store ? (await store.list()).filter((x) => x.key.startsWith('db/')).map((x) => ({ file: x.key.slice(3), size: x.size, where: store.name })) : [];
  return [...local, ...remote].sort((a, b) => b.file.localeCompare(a.file));
}

module.exports = { runBackup, listBackups, toPrune, stampName };
