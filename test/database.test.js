'use strict';
// Backup, restore, SQL scripts, retention rules and S3/R2 upload. Runs on SQLite only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const db = require('../server/lib/db');
const transfer = require('../server/lib/dbx/transfer');
const backup = require('../server/lib/backup');
const { createStore, storageFromEnv } = require('../server/lib/objstore');
const { seedDemo } = require('../server/seed');

let tmp, source, s3, s3url;
const objects = new Map();

// A small S3 stand-in that refuses any request whose Signature V4 does not check out.
function s3Mock(secret, region) {
  const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const m = /Credential=[^/]+\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(req.headers.authorization || '');
      const fail = () => { res.writeHead(403); res.end('<Code>SignatureDoesNotMatch</Code>'); };
      if (!m || m[2] !== region || sha(body) !== req.headers['x-amz-content-sha256']) return fail();
      const [, day, , signed, sig] = m;
      const query = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const canon = [req.method, u.pathname, query, signed.split(';').map((n) => `${n}:${String(req.headers[n]).trim()}\n`).join(''), signed, req.headers['x-amz-content-sha256']].join('\n');
      const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
      const want = crypto.createHmac('sha256', key).update(['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/${region}/s3/aws4_request`, sha(canon)].join('\n')).digest('hex');
      if (want !== sig) return fail();
      const p = decodeURIComponent(u.pathname);
      if (req.method === 'PUT') { objects.set(p, body); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(p); res.writeHead(204); return res.end(); }
      if (u.searchParams.get('list-type') === '2') {
        const pre = `${p}/${u.searchParams.get('prefix') || ''}`;
        const items = [...objects].filter(([n]) => n.startsWith(pre))
          .map(([n, b]) => `<Contents><Key>${n.slice(p.length + 1).replace(/&/g, '&amp;')}</Key><Size>${b.length}</Size></Contents>`);
        res.writeHead(200);
        return res.end(`<ListBucketResult>${items.join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      if (!objects.has(p)) { res.writeHead(404); return res.end('<Code>NoSuchKey</Code>'); }
      res.writeHead(200);
      res.end(objects.get(p));
    });
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smm-db-'));
  source = db.open(path.join(tmp, 'source.sqlite'));
  db.ensureAdmin(source, 'adminpass1');
  seedDemo(source);
  s3 = s3Mock('test-secret', 'auto');
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  s3url = `http://127.0.0.1:${s3.address().port}`;
});

after(() => {
  source.close();
  s3.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a backup loads into an empty database with the same rows, and new ids carry on', () => {
  const b = transfer.dump(source, db.schema(), { schemaVersion: db.SCHEMA_VERSION });
  assert.ok(b.counts.projects > 0 && b.counts.job_travellers > 0);
  const back = transfer.readBackup(transfer.gzip(b));
  assert.equal(back.sha256, b.sha256);
  const copy = db.open(path.join(tmp, 'copy.sqlite'));
  try {
    assert.throws(() => transfer.load(copy, db.schema(), back), /already has data/);
    transfer.load(copy, db.schema(), back, { replace: true });
    assert.deepEqual(transfer.verify(copy, db.schema(), back), []);
    const max = copy.prepare('SELECT MAX(id) AS m FROM projects').get().m;
    const r = copy.prepare("INSERT INTO projects (code, name, customer) VALUES ('P-NEW', 'New', 'NEWAYS')").run();
    assert.ok(Number(r.lastInsertRowid) > max);
  } finally { copy.close(); }
});

test('a damaged or foreign backup file is refused', () => {
  const b = transfer.dump(source, db.schema());
  const bad = JSON.parse(JSON.stringify(b));
  bad.tables.projects[0].name = 'changed';
  assert.throws(() => transfer.readBackup(Buffer.from(JSON.stringify(bad))), /checksum/);
  assert.throws(() => transfer.readBackup(Buffer.from('{"format":"other"}')), /not a Sheet Metal Manager backup/);
});

test('SQL script for SQLite rebuilds the database; other databases get their own syntax', () => {
  const b = transfer.dump(source, db.schema());
  const sql = transfer.sqlScript('sqlite', b, db.schema(), db.createScript('sqlite'));
  const { DatabaseSync } = require('node:sqlite');
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(sql);
  assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM job_travellers').get().n, b.counts.job_travellers);
  fresh.close();
  assert.match(transfer.sqlScript('mssql', b, db.schema(), db.createScript('mssql')), /SET IDENTITY_INSERT \w+ ON\nGO/);
  assert.match(transfer.sqlScript('oracle', b, db.schema(), db.createScript('oracle')), /GENERATED BY DEFAULT ON NULL AS IDENTITY/);
  assert.match(transfer.sqlScript('postgres', b, db.schema(), db.createScript('postgres')), /setval\(pg_get_serial_sequence/);
  assert.match(transfer.sqlScript('mysql', b, db.schema(), db.createScript('mysql')), /FOREIGN_KEY_CHECKS = 0/);
});

test('keep rules: every backup for 30 days, then the first of each month', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const names = ['smm-20261020-010000.json.gz', 'smm-20260901-010000.json.gz', 'smm-20260915-010000.json.gz',
    'smm-20260803-010000.json.gz', 'smm-20260810-010000.json.gz', 'smm-20150101-010000.json.gz', 'notes.txt'];
  assert.deepEqual(backup.toPrune(names, { keepDays: 30, keepMonths: 120, now }).sort(),
    ['smm-20150101-010000.json.gz', 'smm-20260810-010000.json.gz', 'smm-20260915-010000.json.gz']);
  assert.deepEqual(backup.toPrune(names, { keepDays: 30, keepMonths: 0, now }).sort(),
    ['smm-20260810-010000.json.gz', 'smm-20260915-010000.json.gz']);
});

test('backup now writes a local copy and uploads it and the drawings to S3/R2 with signed requests', async () => {
  const store = createStore({ name: 'Cloudflare R2', endpoint: s3url, region: 'auto', bucket: 'smm', accessKeyId: 'key', secretAccessKey: 'test-secret', prefix: 'smm-backups/', pathStyle: true });
  const drawings = path.join(tmp, 'drawings');
  fs.mkdirSync(drawings, { recursive: true });
  fs.writeFileSync(path.join(drawings, 'NW-100 rev A (1).pdf'), '%PDF-1.4 test');
  const r = await backup.runBackup({ db: source, dataDir: tmp, store, drawingsDir: drawings });
  assert.equal(r.uploaded, true);
  assert.equal(r.drawings, 1);
  assert.ok(fs.existsSync(path.join(tmp, 'backups', r.file)));
  const got = transfer.readBackup(await store.get(`db/${r.file}`));
  assert.equal(got.sha256, r.sha256);
  assert.equal((await backup.runBackup({ db: source, dataDir: tmp, store, drawingsDir: drawings })).drawings, 0);
  const list = await backup.listBackups({ dataDir: tmp, store });
  assert.ok(list.some((x) => x.where === 'Cloudflare R2') && list.some((x) => x.where === 'local'));
  const wrong = createStore({ name: 'R2', endpoint: s3url, region: 'auto', bucket: 'smm', accessKeyId: 'key', secretAccessKey: 'wrong', prefix: '', pathStyle: true });
  await assert.rejects(wrong.put('x', 'y'), /403 SignatureDoesNotMatch/);
});

test('storage settings come from the environment and name what is missing', () => {
  assert.equal(storageFromEnv({}), null);
  assert.throws(() => storageFromEnv({ BACKUP_STORAGE: 'r2', R2_BUCKET: 'b' }), /R2_ACCOUNT_ID/);
  const s = storageFromEnv({ BACKUP_STORAGE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's', S3_REGION: 'ap-southeast-1' });
  assert.equal(s.name, 'Amazon S3');
  assert.equal(s.prefix, 'smm-backups/');
});
