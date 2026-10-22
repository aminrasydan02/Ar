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
  const dup = await call(planner, 'POST', `/api/drawings/upload?filename=${encodeURIComponent('606118901_PART_1 Rev C.pdf')}`, Buffer.from('%PDF-1.4 x'));
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
  // 30 days x 465 net min = 13,950 min available.
  assert.equal(d.availability, Math.round(((13950 - 180) / 13950) * 1000) / 10);
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

test('everyone logs daily work under their own process; only the writer or Admin can change it', async () => {
  const bad = await call(admin, 'POST', '/api/users', { username: 'x1', role: 'viewer', process: 'Chef', password: 'password123' });
  assert.equal(bad.status, 400);
  const op = await call(admin, 'POST', '/api/users', { username: 'op1', role: 'viewer', process: 'Operator', password: 'password123' });
  assert.equal(op.status, 201);
  assert.equal(op.data.process, 'Operator');
  const tech = await call(admin, 'POST', '/api/users', { username: 'tech1', role: 'viewer', password: 'password123' });
  assert.equal((await call(admin, 'PUT', `/api/users/${tech.data.id}`, { process: 'Technician' })).data.process, 'Technician');
  const opS = await login('op1', 'password123');
  const techS = await login('tech1', 'password123');
  assert.equal((await call(opS, 'GET', '/api/me')).data.user.process, 'Operator');

  const log = await call(opS, 'POST', '/api/daily_logs', { activity: 'Bending BRK-1, 20 pcs', hours: 4, handover_to: 'Supervisor', logged_by: 'someone-else' });
  assert.equal(log.status, 201);
  assert.equal(log.data.process, 'Operator');
  assert.equal(log.data.logged_by, 'op1');
  assert.match(log.data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(log.data.status, 'In progress');

  assert.equal((await call(opS, 'PUT', `/api/daily_logs/${log.data.id}`, { status: 'Done' })).data.status, 'Done');
  assert.equal((await call(techS, 'PUT', `/api/daily_logs/${log.data.id}`, { status: 'Blocked' })).status, 403);
  assert.equal((await call(planner, 'PUT', `/api/daily_logs/${log.data.id}`, { status: 'Blocked' })).status, 403);
  assert.equal((await call(admin, 'PUT', `/api/daily_logs/${log.data.id}`, { hours: 5 })).data.hours, 5);
  assert.equal((await call(opS, 'DELETE', `/api/daily_logs/${log.data.id}`)).status, 403);

  const today = await call(techS, 'GET', `/api/daily_logs?date=${log.data.date}`);
  assert.ok(today.data.some((l) => l.id === log.data.id));
  assert.ok(today.data.some((l) => l.process === 'Designer'), 'demo day is on the board');

  // Admin without a process must pick one.
  assert.equal((await call(admin, 'POST', '/api/daily_logs', { activity: 'x' })).status, 400);
});

test('issues pass a problem between processes, with numbering, discussion and resolved date', async () => {
  const opS = await login('op1', 'password123');
  const techS = await login('tech1', 'password123');
  const year = new Date().getFullYear();
  const iss = await call(opS, 'POST', '/api/issues', { title: 'Press brake angle off by 2°', to_process: 'Technician', priority: 'Urgent' });
  assert.equal(iss.status, 201);
  assert.equal(iss.data.issue_no, `ISS-${year}-0002`);
  assert.equal(iss.data.from_process, 'Operator');
  assert.equal(iss.data.raised_by, 'op1');
  assert.equal(iss.data.status, 'Open');
  assert.ok(iss.data.opened);

  const id = iss.data.id;
  assert.equal((await call(techS, 'POST', `/api/issues/${id}/replies`, { message: '  ' })).status, 400);
  const rep = await call(techS, 'POST', `/api/issues/${id}/replies`, { message: 'Recalibrating the back gauge now.' });
  assert.equal(rep.status, 201);
  assert.equal(rep.data.process, 'Technician');
  await call(opS, 'POST', `/api/issues/${id}/replies`, { message: 'Thanks, holding the batch.' });
  const thread = await call(planner, 'GET', `/api/issues/${id}/replies`);
  assert.deepEqual(thread.data.map((r) => r.username), ['tech1', 'op1']);
  assert.equal((await call(techS, 'GET', '/api/issues/99999/replies')).status, 404);

  let d = await call(admin, 'GET', '/api/dashboard');
  assert.equal(d.data.kpi.open_issues, 2);
  assert.equal(d.data.issues[0].priority, 'Urgent');
  assert.ok(d.data.kpi.logs_today >= 5);

  const fixed = await call(techS, 'PUT', `/api/issues/${id}`, { status: 'Resolved', resolution: 'Back gauge recalibrated.' });
  assert.equal(fixed.status, 200);
  assert.match(fixed.data.resolved, /^\d{4}-\d{2}-\d{2}$/);
  d = await call(admin, 'GET', '/api/dashboard');
  assert.equal(d.data.kpi.open_issues, 1);
  assert.equal((await call(techS, 'DELETE', `/api/issues/${id}`)).status, 403);
  assert.equal((await call(admin, 'DELETE', `/api/issues/${id}`)).status, 204);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM issue_replies WHERE issue_id = ?').get(id).n, 0);
});

test('an older database gets the process column and discussion table', () => {
  const file = path.join(tmp, 'old.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, full_name TEXT,
    role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.close();
  const upgraded = db.open(file);
  const cols = upgraded.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('process'));
  assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'issue_replies'").get());
  upgraded.close();
});

test('NEWAYS shop processes are there and Admin can add another one', async () => {
  const list = await call(planner, 'GET', '/api/shop_processes');
  assert.deepEqual(list.data.map((p) => p.code).sort(), ['BEND', 'CLINCH', 'LASER', 'POLISH']);
  assert.equal((await call(planner, 'POST', '/api/shop_processes', { code: 'WELD', name: 'Welding' })).status, 403);
  const w = await call(admin, 'POST', '/api/shop_processes', { code: 'WELD', name: 'Welding', seq: 50, extra_fields: 'Wire size' });
  assert.equal(w.status, 201);
  assert.equal(w.data.active, 'Yes');
});

// Same columns as the Fact_Production table in the combined production dashboard.
const FACT_CSV = [
  'Record_ID,Machine_Cell,Stage_Order,Master_Part_No,Material_Type,Thickness_mm,Physical_Order_Qty,Process_Target_Pcs,Cycle_Time_Min,Live_Actual_Good_Pcs',
  'FACT-01,Polishing,Stage 1,JT-TEST_PART_1,Aluminium,1.5,375,375,1.33333,355',
  'FACT-07,Bending,Stage 2,JT-TEST_PART_1,Aluminium,1.5,375,375,2.5,24',
  'FACT-11,Self-Clinching,Stage 3,JT-TEST_PART_1,Aluminium,1.5,375,375,2.91667,0',
  'FACT-03,Polishing,Stage 1,JT-TEST_PART_2,Stainless Steel,1.5,182,182,0.83333,0',
  'TOTAL,All 3 Machine Cells,3 Stages,4 Routing Operations,Alu & SUS304,1.5,1114,1114,,379',
].join('\r\n');

test('Job Traveller import: preview first, then one traveller per part with its routing', async () => {
  const url = '/api/job_travellers/import?filename=combined.csv';
  assert.equal((await call(viewer, 'POST', url, Buffer.from(FACT_CSV))).status, 401); // viewer1 was disabled earlier
  const preview = await call(planner, 'POST', url, Buffer.from(FACT_CSV));
  assert.equal(preview.status, 200);
  assert.equal(preview.data.lines.length, 4);
  assert.deepEqual(preview.data.lines.map((l) => l.process), ['Polishing', 'Bending', 'Clinching', 'Polishing']);
  assert.equal((await call(planner, 'GET', '/api/job_travellers?part_no=JT-TEST_PART_1')).data.length, 0, 'preview saves nothing');

  const done = await call(planner, 'POST', `${url}&commit=1`, Buffer.from(FACT_CSV));
  assert.equal(done.status, 200);
  const jts = (await call(planner, 'GET', '/api/job_travellers')).data.filter((j) => j.part_no.startsWith('JT-TEST'));
  assert.equal(jts.length, 2);
  const jt1 = jts.find((j) => j.part_no === 'JT-TEST_PART_1');
  assert.match(jt1.jt_no, /^JT-\d{4}-\d{4}$/);
  assert.equal(jt1.material, 'Aluminium');
  const prog = (await call(planner, 'GET', `/api/job_travellers/${jt1.id}/progress`)).data;
  assert.deepEqual(prog.map((s) => [s.process, s.target_qty, s.good]), [['Polishing', 375, 355], ['Bending', 375, 24], ['Clinching', 375, 0]]);

  // Importing again updates the same travellers and does not double the recorded output.
  await call(planner, 'POST', `${url}&commit=1`, Buffer.from(FACT_CSV));
  const again = (await call(planner, 'GET', '/api/job_travellers')).data.filter((j) => j.part_no.startsWith('JT-TEST'));
  assert.equal(again.length, 2);
  assert.equal((await call(planner, 'GET', `/api/job_travellers/${jt1.id}/progress`)).data[0].good, 355);

  const bad = await call(planner, 'POST', '/api/job_travellers/import?filename=x.csv', Buffer.from('a,b\n1,2'));
  assert.equal(bad.status, 400);
  assert.equal((await call(planner, 'POST', '/api/job_travellers/import?filename=x.pdf', Buffer.from('x'))).status, 400);
});

test('one Operator form records output for any process; only the operator or Admin edits it', async () => {
  const opS = await login('op1', 'password123');
  const techS = await login('tech1', 'password123');
  const jt = (await call(opS, 'GET', '/api/job_travellers?part_no=JT-TEST_PART_1')).data[0];
  const bend = (await call(opS, 'GET', '/api/shop_processes?code=BEND')).data[0];
  const out = await call(opS, 'POST', '/api/operator_outputs', {
    process_id: bend.id, job_traveller_id: jt.id, good_qty: 40, reject_qty: 1, run_min: 100, extra: { 'No. of bends': '4' }, operator: 'x' });
  assert.equal(out.status, 201);
  assert.equal(out.data.operator, 'op1');
  assert.equal(JSON.parse(out.data.extra)['No. of bends'], '4');
  assert.ok(out.data.date);
  assert.equal((await call(opS, 'POST', '/api/operator_outputs', { process_id: bend.id, job_traveller_id: jt.id, good_qty: 1, extra: [1] })).status, 400);
  assert.equal((await call(techS, 'PUT', `/api/operator_outputs/${out.data.id}`, { good_qty: 400 })).status, 403);
  assert.equal((await call(opS, 'PUT', `/api/operator_outputs/${out.data.id}`, { good_qty: 41 })).data.good_qty, 41);
  const prog = (await call(opS, 'GET', `/api/job_travellers/${jt.id}/progress`)).data;
  assert.equal(prog.find((s) => s.process === 'Bending').good, 24 + 41);
  assert.equal((await call(planner, 'POST', '/api/job_travellers', { part_no: 'MANUAL-1', qty: 10 })).data.jt_no.startsWith('JT-'), true);
  assert.equal((await call(opS, 'POST', '/api/job_travellers', { part_no: 'X', qty: 1 })).status, 403);
});

test('NEWAYS demo Job Travellers carry the report routing; dashboard shows work per process', async () => {
  const jt = (await call(planner, 'GET', '/api/job_travellers?part_no=606072702_PART_1')).data[0];
  assert.equal(jt.drawing_no, '4022-472-84231-v8');
  const steps = (await call(planner, 'GET', `/api/job_travellers/${jt.id}/progress`)).data;
  assert.deepEqual(steps.map((s) => [s.process, s.cycle_min]), [['Laser Cutting', null], ['Polishing', 1.333], ['Bending', 2.5], ['Clinching', 2.917]]);
  const codes = (await call(planner, 'GET', '/api/reason_codes?kind=Reject')).data;
  assert.equal(codes.length, 5);
  const d = (await call(admin, 'GET', '/api/dashboard')).data;
  assert.equal(d.minutesPerDay, 465);
  const bend = d.processes.find((p) => p.name === 'Bending');
  assert.ok(bend.target >= 757);
  assert.equal(d.processes.filter((p) => p.bottleneck).length, 1);
  assert.equal(d.production.target, d.processes.reduce((n, p) => n + p.target, 0));
});

test('Excel template: download, fill, check, import; Excel export', async () => {
  const t = await fetch(`${base}/api/job_travellers/template.xlsx`, { headers: { cookie: planner } });
  assert.equal(t.status, 200);
  assert.match(t.headers.get('content-type'), /spreadsheetml/);
  const { readXlsx, writeXlsx } = require('../server/lib/xlsx');
  const sheets = readXlsx(Buffer.from(await t.arrayBuffer()));
  assert.deepEqual(sheets.map((s) => s.name), ['Data', 'Guide']);
  const head = sheets[0].rows[1];
  assert.ok(head.includes('Part number *') && head.includes('Project') && !head.includes('Status *'));
  assert.ok(sheets[1].rows.some((r) => r && r[0] === 'Material' && /Aluminium/.test(r[3])));

  // Fill the template the way a planner would in Excel: dates as DD/MM/YYYY, project by its code.
  const filled = writeXlsx([{ name: 'Data', title: 'x', rows: [head,
    head.map((h) => ({ 'Part number *': 'TPL-001', 'Required qty (pcs) *': 50, Project: 'NEWAYS', 'Due date': '30/11/2026', Material: 'SS' }[h] ?? null)),
    head.map((h) => ({ 'Part number *': 'TPL-002', 'Required qty (pcs) *': 20, Project: 'NOPE' }[h] ?? null)),
  ] }]);
  const url = '/api/job_travellers/import-template?filename=jt.xlsx';
  const check = await call(planner, 'POST', url, filled);
  assert.equal(check.status, 200);
  assert.equal(check.data.ok, 1);
  assert.match(check.data.errors[0].error, /Project "NOPE" not found/);
  assert.equal((await call(planner, 'POST', `${url}&commit=1`, filled)).status, 400, 'nothing saved while a row is wrong');
  assert.equal((await call(planner, 'GET', '/api/job_travellers?part_no=TPL-001')).data.length, 0);

  const good = writeXlsx([{ name: 'Data', rows: [head, head.map((h) => ({ 'Part number *': 'TPL-001', 'Required qty (pcs) *': 50, Project: 'neways', 'Due date': '30/11/2026' }[h] ?? null))] }]);
  const done = await call(planner, 'POST', `${url}&commit=1`, good);
  assert.equal(done.status, 200);
  const jt = (await call(planner, 'GET', '/api/job_travellers?part_no=TPL-001')).data[0];
  assert.equal(jt.due_date, '2026-11-30');
  assert.equal(jt.project_id__label, 'NEWAYS');
  assert.match(jt.jt_no, /^JT-/);

  const csv = 'Part number,Required qty (pcs)\nTPL-003,7\n';
  assert.equal((await call(planner, 'POST', '/api/job_travellers/import-template?filename=x.csv&commit=1', Buffer.from(csv))).status, 200);
  assert.equal((await call(planner, 'POST', '/api/machines/import-template?filename=x.csv', Buffer.from(csv))).status, 403);
  assert.equal((await call(admin, 'POST', '/api/drawings/import-template?filename=x.csv', Buffer.from(csv))).status, 400);

  const ex = await fetch(`${base}/api/job_travellers/export.xlsx`, { headers: { cookie: planner } });
  const out = readXlsx(Buffer.from(await ex.arrayBuffer()))[0];
  assert.equal(out.rows[1][0], 'ID');
  assert.ok(out.rows.some((r) => r && r.includes('TPL-001') && r.includes('30/11/2026')));
});

test('planner creates a project with mother and child parts, and Job Travellers', async () => {
  const procs = (await call(admin, 'GET', '/api/shop_processes')).data;
  const laser = procs.find((p) => p.code === 'LASER').id;
  const r = await call(planner, 'POST', '/api/projects/tree', {
    project: { code: 'TREE1', name: 'Cabinet', customer: 'ACME', due_date: '2026-12-01' }, sets: 10, create_jts: true,
    parts: [
      { key: 'm', part_no: 'CAB-ASSY', description: 'Cabinet assembly' },
      { key: 'c1', parent_key: 'm', part_no: 'CAB-SIDE', qty_per_parent: 2, material: 'SPCC', thickness: 1.2, process_ids: [laser] },
      { key: 'c2', parent_key: 'c1', part_no: 'CAB-BRKT', qty_per_parent: 3 },
    ],
  });
  assert.equal(r.status, 201);
  const [m, side, brkt] = r.data.parts;
  assert.equal(m.qty_per_set, 1);
  assert.equal(side.parent_no, 'CAB-ASSY');
  assert.equal(brkt.qty_per_set, 6);
  const infoR = await call(planner, 'GET', `/api/job_travellers/${side.jt_id}/info`);
  assert.equal(infoR.status, 200, JSON.stringify(infoR.data));
  const info = infoR.data;
  assert.equal(info.jt.qty, 20);
  assert.equal(info.parent.part_no, 'CAB-ASSY');
  assert.equal(info.children[0].part_no, 'CAB-BRKT');
  assert.equal(info.steps[0].state, 'Pending');
  assert.equal(info.current, 'Laser Cutting');
  // A bad line undoes the whole project.
  const bad = await call(planner, 'POST', '/api/projects/tree', { project: { code: 'TREE2', name: 'x' }, parts: [{ part_no: 'A1' }, { part_no: 'A2', parent_key: 'zz' }] });
  assert.equal(bad.status, 400);
  assert.equal((await call(admin, 'GET', '/api/projects?code=TREE2')).data.length, 0);
});

test('no code can be saved, and uploads must be real drawing files', async () => {
  let r = await call(planner, 'POST', '/api/projects', { code: 'XSS', name: '<script>alert(1)</script>' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not allowed/);
  r = await call(planner, 'POST', '/api/projects', { code: 'XSS2', name: 'Bracket qty < 5 and > 2' });
  assert.equal(r.status, 201);
  r = await call(planner, 'POST', '/api/drawings/upload?filename=x.pdf', Buffer.from('<html><script>alert(1)</script></html>'));
  assert.equal(r.status, 400);
  r = await call(planner, 'POST', '/api/drawings/upload?filename=PANEL-9%20Rev%20A.step', Buffer.from('ISO-10303-21;\nHEADER;'));
  assert.equal(r.status, 201);
  assert.equal(r.data.kind, '3D model');
});

test('each process edits only its own data; Manager reads all and approves Job Travellers', async () => {
  const mk = async (username, process) => {
    await call(admin, 'POST', '/api/users', { username, role: 'planner', process, password: 'password123' });
    return login(username, 'password123');
  };
  const tech = await mk('tech9', 'Technician');
  const mgr = await mk('mgr9', 'Manager');
  const r = await call(tech, 'GET', '/api/me');
  assert.equal(r.data.rights.machines.create, true);
  assert.equal(r.data.rights.job_travellers.create, false);
  assert.equal((await call(tech, 'POST', '/api/job_travellers', { part_no: 'P', qty: 1 })).status, 403);
  assert.equal((await call(tech, 'POST', '/api/machines', { code: 'M-T9', name: 'Press', machine_type: 'Press brake' })).status, 201);
  assert.equal((await call(mgr, 'POST', '/api/machines', { code: 'M-M9', name: 'Press', machine_type: 'Press brake' })).status, 403);
  assert.equal((await call(mgr, 'GET', '/api/machines')).status, 200);
  assert.equal((await call(tech, 'POST', '/api/job_travellers/1/approve')).status, 403);
  const ok = await call(mgr, 'POST', '/api/job_travellers/1/approve');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.approved_by, 'mgr9');
  assert.equal((await call(mgr, 'POST', '/api/me/theme', { theme: 'dark' })).status, 200);
  assert.equal((await call(mgr, 'GET', '/api/me')).data.user.theme, 'dark');
  assert.equal((await call(mgr, 'POST', '/api/me/theme', { theme: 'pink' })).status, 400);
});

test('inventory: stock moves update qty on hand, low stock shows, no negative stock', async () => {
  const machine = (await call(admin, 'GET', '/api/machines')).data[0];
  let r = await call(admin, 'POST', '/api/inventory_items', { code: 'T-GLV', name: 'Cut-resistant gloves', item_group: 'Operator tools', unit: 'pair', qty_on_hand: 20, min_qty: 10 });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'OK');
  const glove = r.data;
  const op = await login('op1', 'password123');
  r = await call(op, 'POST', '/api/inventory_moves', { date: '2026-10-22', item_id: glove.id, move: 'Issue / use', qty: 12 });
  assert.equal(r.status, 201);
  assert.equal(r.data.process, 'Operator');
  let item = (await call(op, 'GET', `/api/inventory_items/${glove.id}`)).data;
  assert.equal(item.qty_on_hand, 8);
  assert.equal(item.status, 'Low');
  r = await call(op, 'POST', '/api/inventory_moves', { date: '2026-10-22', item_id: glove.id, move: 'Issue / use', qty: 9 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Not enough stock/);
  assert.equal((await call(op, 'POST', '/api/inventory_items', { code: 'X', name: 'x', item_group: 'Equipment' })).status, 403);
  const spare = (await call(admin, 'POST', '/api/inventory_items', { code: 'T-BRG', name: 'Bearing 6204', item_group: 'Maintenance spares', qty_on_hand: 2, min_qty: 1 })).data;
  const wo = (await call(admin, 'POST', '/api/maint_orders', { machine_id: machine.id, kind: 'Breakdown', title: 'Spindle noise' })).data;
  r = await call(admin, 'POST', '/api/inventory_moves', { date: '2026-10-22', item_id: spare.id, move: 'Issue / use', qty: 2, maint_order_id: wo.id, machine_id: machine.id });
  assert.equal(r.status, 201);
  item = (await call(admin, 'GET', `/api/inventory_items/${spare.id}`)).data;
  assert.equal(item.status, 'Out');
  assert.equal((await call(admin, 'PUT', `/api/inventory_moves/${r.data.id}`, { qty: 1 })).status, 400);
  const dash = (await call(admin, 'GET', '/api/dashboard')).data;
  assert.ok(['T-BRG', 'T-GLV'].every((c) => dash.lowItems.some((i) => i.code === c)));
  item = (await call(admin, 'PUT', `/api/inventory_items/${glove.id}`, { qty_on_hand: 30 })).data;
  assert.equal(item.status, 'OK');
  const log = (await call(admin, 'GET', `/api/inventory_moves?item_id=${glove.id}`)).data;
  assert.deepEqual(log.map((m) => m.move), ['Adjust', 'Issue / use', 'Receive']);
});

test('shop-floor layout: starter layout, saved versions, live machine data, no code', async () => {
  const op = await login('op1', 'password123');
  let r = await call(op, 'GET', '/api/layout');
  assert.equal(r.status, 200);
  assert.equal(r.data.version, null);
  assert.ok(r.data.items.some((i) => i.type === 'machine'));
  const layout = { floor: r.data.floor, items: r.data.items };
  assert.equal((await call(op, 'POST', '/api/layout', layout)).status, 403);
  r = await call(planner, 'POST', '/api/layout', { ...layout, note: 'First layout' });
  assert.equal(r.status, 201);
  assert.equal(r.data.version, 1);
  layout.items[0].x += 3;
  r = await call(admin, 'POST', '/api/layout', { ...layout, note: 'Moved laser' });
  assert.equal(r.data.version, 2);
  assert.equal(r.data.items[0].x, layout.items[0].x);
  assert.ok(r.data.machines[0].code);
  assert.equal((await call(admin, 'GET', '/api/layout/versions')).data.length, 2);
  assert.equal((await call(admin, 'GET', '/api/layout/versions/1')).data.items[0].x, layout.items[0].x - 3);
  r = await call(admin, 'POST', '/api/layout', { floor: layout.floor, items: [{ type: 'label', label: '<img src=x onerror=alert(1)>', x: 1, y: 1, w: 2, h: 1 }] });
  assert.equal(r.status, 400);
  r = await call(admin, 'POST', '/api/layout', { floor: layout.floor, items: [{ type: 'script', x: 1, y: 1, w: 2, h: 1 }] });
  assert.equal(r.status, 400);
});

test('Admin appoints full-edit users and changes process rights at any time; changes are audited', async () => {
  const u = (await call(admin, 'POST', '/api/users', { username: 'des9', role: 'planner', process: 'Designer', password: 'password123' })).data;
  const des = await login('des9', 'password123');
  assert.equal((await call(des, 'POST', '/api/machines', { code: 'M-D9', name: 'x', machine_type: 'Press brake' })).status, 403);
  await call(admin, 'PUT', `/api/users/${u.id}`, { full_edit: true });
  assert.equal((await call(des, 'POST', '/api/machines', { code: 'M-D9', name: 'x', machine_type: 'Press brake' })).status, 201);
  assert.equal((await call(des, 'GET', '/api/me')).data.rights.job_travellers.approve, true);
  await call(admin, 'PUT', `/api/users/${u.id}`, { full_edit: false, extra_processes: ['Technician'] });
  assert.equal((await call(des, 'POST', '/api/plates', { material: 'SS', thickness: 2, qty: 1 })).status !== 403, true);
  await call(admin, 'PUT', `/api/users/${u.id}`, { extra_processes: [] });
  // Rights table: give Designer the machines module, then take it away again.
  const rights = (await call(admin, 'GET', '/api/rights')).data;
  assert.equal((await call(des, 'PUT', '/api/rights', { rights })).status, 403);
  await call(admin, 'PUT', '/api/rights', { rights: [...rights, { process: 'Designer', resource: 'machines' }] });
  assert.equal((await call(des, 'POST', '/api/machines', { code: 'M-D10', name: 'x', machine_type: 'Press brake' })).status, 201);
  await call(admin, 'PUT', '/api/rights', { rights });
  assert.equal((await call(des, 'POST', '/api/machines', { code: 'M-D11', name: 'x', machine_type: 'Press brake' })).status, 403);
  const log = (await call(admin, 'GET', '/api/audit')).data;
  const change = log.find((a) => a.resource === 'users' && a.record_id === u.id && a.action === 'update' && JSON.parse(a.after).full_edit === true);
  assert.equal(JSON.parse(change.before).full_edit, false);
  assert.ok(log.some((a) => a.resource === 'access_rights'));
});
