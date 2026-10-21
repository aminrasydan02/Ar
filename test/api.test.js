'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const db = require('../server/lib/db');
const { createApp } = require('../server/lib/app');
const { seedDemo } = require('../server/seed');

let server, base, tmp, database;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smm-'));
  database = db.open(path.join(tmp, 'smm.sqlite'));
  db.ensureAdmin(database, 'adminpass1');
  seedDemo(database);
  server = http.createServer(createApp({ db: database, drawingsDir: path.join(tmp, 'drawings') }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  database.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(cookie, method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (Buffer.isBuffer(body)) { payload = body; headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

async function login(username, password) {
  const r = await call(null, 'POST', '/api/login', { username, password });
  assert.equal(r.status, 200, `login ${username}`);
  return r.headers.get('set-cookie').split(';')[0];
}

let admin, planner, viewer;

test('health check reports version', async () => {
  const r = await call(null, 'GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('login rejects a wrong password and data needs a session', async () => {
  assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await call(null, 'GET', '/api/projects')).status, 401);
  admin = await login('admin', 'adminpass1');
});

test('admin creates planner and viewer accounts', async () => {
  for (const [u, role] of [['planner1', 'planner'], ['viewer1', 'viewer']]) {
    const r = await call(admin, 'POST', '/api/users', { username: u, role, password: 'password123', full_name: u });
    assert.equal(r.status, 201);
    assert.equal(r.data.role, role);
    assert.equal(r.data.password_hash, undefined);
  }
  planner = await login('planner1', 'password123');
  viewer = await login('viewer1', 'password123');
  assert.equal((await call(planner, 'GET', '/api/users')).status, 403);
});

test('NEWAYS demo totals 1,339 pieces', async () => {
  const d = await call(admin, 'GET', '/api/dashboard');
  assert.equal(d.data.kpi.parts, 6);
  assert.equal(d.data.kpi.total_pcs, 1339);
  assert.equal(d.data.load.length, 4);
});

test('planner can create and update planning data but not delete', async () => {
  const p = await call(planner, 'POST', '/api/projects', { code: 'P-100', name: 'Bracket job', due_date: '2026-11-30' });
  assert.equal(p.status, 201);
  assert.equal(p.data.status, 'Planned');
  const part = await call(planner, 'POST', '/api/parts', { project_id: p.data.id, part_no: 'BRK-1', material: 'SS', thickness: 2, sets: 10, qty_per_set: 2 });
  assert.equal(part.status, 201);
  assert.equal(part.data.project_id__label, 'P-100');
  const upd = await call(planner, 'PUT', `/api/parts/${part.data.id}`, { sets: 12 });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.sets, 12);
  assert.equal((await call(planner, 'DELETE', `/api/parts/${part.data.id}`)).status, 403);
  assert.equal((await call(planner, 'POST', '/api/machines', { code: 'X', name: 'X', machine_type: 'General' })).status, 403);
  assert.equal((await call(planner, 'POST', '/api/ncrs', { date: '2026-10-21', defect: 'x' })).status, 403);
  assert.equal((await call(planner, 'PUT', '/api/plates/1', { qty: 1 })).status, 403);
});

test('viewer can read and export but not write', async () => {
  assert.equal((await call(viewer, 'GET', '/api/parts')).status, 200);
  const csv = await call(viewer, 'GET', '/api/parts/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /606118901_PART_2/);
  assert.equal((await call(viewer, 'POST', '/api/projects', { code: 'V', name: 'V' })).status, 403);
  assert.equal((await call(viewer, 'POST', '/api/drawings/upload?filename=a.pdf', Buffer.from('%PDF'))).status, 403);
});

test('validation rejects bad input', async () => {
  let r = await call(admin, 'POST', '/api/projects', { name: 'No code' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Project code is required/);
  r = await call(admin, 'POST', '/api/projects', { code: 'NEWAYS', name: 'dup' });
  assert.equal(r.status, 409);
  r = await call(admin, 'POST', '/api/machines', { code: 'M9', name: 'M', machine_type: 'Spaceship' });
  assert.equal(r.status, 400);
  r = await call(admin, 'POST', '/api/projects', { code: 'D1', name: 'd', due_date: '21/10/2026' });
  assert.equal(r.status, 400);
  r = await call(admin, 'POST', '/api/projects', { code: 'X', name: 'x' }, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('drawing upload reads part number and revision, supersedes older revision', async () => {
  const a = await call(planner, 'POST', `/api/drawings/upload?filename=${encodeURIComponent('606118901_PART_1 Rev B.pdf')}`, Buffer.from('%PDF-1.4 B'));
  assert.equal(a.status, 201);
  assert.equal(a.data.part_no, '606118901_PART_1');
  assert.equal(a.data.rev, 'B');
  assert.equal(a.data.stored_name, undefined);
  const b = await call(planner, 'POST', `/api/drawings/upload?filename=${encodeURIComponent('606118901_PART_1 Rev C.pdf')}`, Buffer.from('%PDF-1.4 C'));
  assert.equal(b.status, 201);
  const old = await call(viewer, 'GET', `/api/drawings/${a.data.id}`);
  assert.equal(old.data.status, 'Superseded');
  const dup = await call(planner, 'POST', `/api/drawings/upload?filename=${encodeURIComponent('606118901_PART_1 Rev C.pdf')}`, Buffer.from('x'));
  assert.equal(dup.status, 409);
  const bad = await call(planner, 'POST', '/api/drawings/upload?filename=evil.exe', Buffer.from('x'));
  assert.equal(bad.status, 400);
  const file = await call(viewer, 'GET', `/api/drawings/${b.data.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.data, '%PDF-1.4 C');
  assert.equal((await call(planner, 'DELETE', `/api/drawings/${b.data.id}`)).status, 403);
});

test('NCR numbers run per year', async () => {
  const a = await call(admin, 'POST', '/api/ncrs', { date: '2026-10-21', defect: 'Burr on edge', part_no: 'BRK-1' });
  const b = await call(admin, 'POST', '/api/ncrs', { date: '2026-10-22', defect: 'Wrong bend angle', ncr_no: 'HACK' });
  assert.equal(a.data.ncr_no, 'NCR-2026-0001');
  assert.equal(b.data.ncr_no, 'NCR-2026-0002');
  assert.equal(a.data.status, 'Open');
});

test('workflow is built from routing and shows on the dashboard', async () => {
  const parts = (await call(admin, 'GET', '/api/parts?part_no=606072702_PART_1')).data;
  const partId = parts[0].id;
  const lc = (await call(admin, 'GET', '/api/machines?code=LC-01')).data[0];
  await call(planner, 'POST', '/api/routings', { part_id: partId, seq: 10, operation: 'Laser cutting', machine_id: lc.id, setup_min: 15, cycle_min: 1 });
  await call(planner, 'POST', '/api/routings', { part_id: partId, seq: 20, operation: 'Bending' });
  const wf = await call(planner, 'POST', `/api/parts/${partId}/workflow`);
  assert.equal(wf.status, 201);
  assert.deepEqual(wf.data.sort((x, y) => x.seq - y.seq).map((s) => s.step),
    ['Drawing review', 'Programming', 'Laser cutting', 'Bending', 'QC', 'Packing', 'Delivery']);
  assert.equal((await call(planner, 'POST', `/api/parts/${partId}/workflow`)).status, 409);
  // Planner cannot change workflow status; admin can.
  const step = wf.data.find((s) => s.step === 'Drawing review');
  assert.equal((await call(planner, 'PUT', `/api/wf_steps/${step.id}`, { status: 'Done' })).status, 403);
  assert.equal((await call(admin, 'PUT', `/api/wf_steps/${step.id}`, { status: 'Done' })).status, 200);
  const d = (await call(viewer, 'GET', '/api/dashboard')).data;
  const row = d.workflow.find((w) => w.part_no === '606072702_PART_1');
  assert.equal(row.current, 'Programming');
  const laser = d.load.find((m) => m.code === 'LC-01');
  assert.equal(laser.load_min, 15 + 375);
});

test('maintenance breakdowns give availability, MTBF and MTTR', async () => {
  const cl = (await call(admin, 'GET', '/api/machines?code=CL-01')).data[0];
  const today = new Date().toISOString().slice(0, 10);
  await call(admin, 'POST', '/api/maint_orders', { machine_id: cl.id, kind: 'Breakdown', title: 'Die crack', opened: today, downtime_min: 120 });
  await call(admin, 'POST', '/api/maint_orders', { machine_id: cl.id, kind: 'Breakdown', title: 'Sensor', opened: today, downtime_min: 60 });
  const d = (await call(admin, 'GET', '/api/dashboard')).data.downtime.find((m) => m.code === 'CL-01');
  assert.equal(d.breakdowns, 2);
  assert.equal(d.downtime_min, 180);
  assert.equal(d.mttr_min, 90);
  assert.equal(d.availability, Math.round(((14400 - 180) / 14400) * 1000) / 10);
});

test('disabled users are signed out and admin cannot lock themselves out', async () => {
  const users = (await call(admin, 'GET', '/api/users')).data;
  const v = users.find((u) => u.username === 'viewer1');
  const me = users.find((u) => u.username === 'admin');
  assert.equal((await call(admin, 'PUT', `/api/users/${v.id}`, { active: false })).status, 200);
  assert.equal((await call(viewer, 'GET', '/api/parts')).status, 401);
  assert.equal((await call(admin, 'PUT', `/api/users/${me.id}`, { role: 'viewer' })).status, 400);
  assert.equal((await call(admin, 'DELETE', `/api/users/${me.id}`)).status, 400);
});

test('static files are served and path traversal is refused', async () => {
  const r = await call(null, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.data, /Sheet Metal Manager/);
  const t = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(t.status, 404);
});
