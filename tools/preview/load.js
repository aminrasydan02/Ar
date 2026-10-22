'use strict';
// Builds a database filled with the department's saved data, through the website's own API,
// so every record passes the same checks as a user's entry. Duplicates are merged and every
// difference between sources is written to a report.
//
//   node tools/preview/load.js <out-dir> <neways-reports-dir> <maintenance-bom-dir>
//
// Result: <out-dir>/smm.sqlite and <out-dir>/data-check.md
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const db = require('../../server/lib/db');
const { createApp } = require('../../server/lib/app');
const { seedDemo } = require('../../server/seed');
const { readXlsx } = require('../../server/lib/xlsx');

const [outDir, reportsDir, bomDir] = process.argv.slice(2);
if (!outDir || !reportsDir || !bomDir) {
  console.error('Usage: node tools/preview/load.js <out-dir> <neways-reports-dir> <maintenance-bom-dir>');
  process.exit(1);
}
const PASSWORD = process.env.ADMIN_PASSWORD || 'preview-admin-1';
const merged = [];    // duplicates found and merged
const conflicts = []; // same thing, different values in two sources: which one was kept
const notes = [];

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const database = db.open(path.join(outDir, 'smm.sqlite'));
  db.ensureAdmin(database, PASSWORD);
  seedDemo(database); // NEWAYS project, parts, Job Travellers, daily logs, inventory
  database.prepare("UPDATE users SET full_name = 'Administrator' WHERE username = 'admin'").run();
  const server = http.createServer(createApp({ db: database, drawingsDir: path.join(outDir, 'drawings') }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(method, url, body) {
    const headers = { cookie };
    let payload;
    if (Buffer.isBuffer(body)) { payload = body; headers['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers, body: payload });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url}: ${(data && data.error) || res.status}`);
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return data;
  }
  await api('POST', '/api/login', { username: 'admin', password: PASSWORD });
  try {
    await loadUsers(api);
    await loadSchedules(api, database);
    await loadMaintenance(api);
    await loadBom(api);
    await loadLayout(api);
  } finally {
    server.close();
    database.close();
  }
  fs.writeFileSync(path.join(outDir, 'data-check.md'), report());
  console.log(`Loaded. ${merged.length} duplicates merged, ${conflicts.length} differences settled. See ${path.join(outDir, 'data-check.md')}`);
}

// One demo account per process, so the daily board and rights can be seen.
async function loadUsers(api) {
  const people = [['designer1', 'Designer'], ['planner1', 'Planner'], ['engineer1', 'Engineer'], ['technician1', 'Technician'],
    ['supervisor1', 'Supervisor'], ['operator1', 'Operator'], ['manager1', 'Manager']];
  for (const [username, process] of people) {
    await api('POST', '/api/users', { username, full_name: `${process} (demo)`, role: process === 'Operator' ? 'viewer' : 'planner', process, password: `${PASSWORD}-${username}` });
  }
}

// The 4 NEWAYS schedule reports and the master combined dashboard. Each part + process
// becomes one Job Traveller step; the same step found in several files is merged.
async function loadSchedules(api, database) {
  const project = (await api('GET', '/api/projects')).find((p) => p.code === 'NEWAYS');
  const files = ['LASER_CUTTING', 'POLISHING', 'BENDING', 'CLINCHING'].map((p) => `${p}_SCHEDULE_REPORT_NEWAYS.xlsx`)
    .concat('MASTER_COMBINED_PRODUCTION_DASHBOARD.xlsx'); // master last: it is the reconciled plan
  const seenFrom = new Map(); // part|process -> { file, qty, cycle }
  for (const file of files) {
    const full = path.join(reportsDir, file);
    if (!fs.existsSync(full)) { notes.push(`Not found: ${file}`); continue; }
    const buf = fs.readFileSync(full);
    const url = `/api/job_travellers/import?filename=${encodeURIComponent(file)}&project_id=${project.id}`;
    const plan = await api('POST', url, buf);
    for (const l of plan.lines) {
      const partNo = l.jt_no ? (await api('GET', `/api/job_travellers/${l.jt_id}`)).part_no : l.part_no;
      if (partNo !== l.part_no) merged.push(`${file}: part "${l.part_no}" is ${partNo} (${l.jt_no}); same item, short part number`);
      const key = `${partNo}|${l.process}`;
      const prev = seenFrom.get(key);
      if (prev) {
        merged.push(`${partNo} ${l.process}: in ${prev.file} and ${file}, merged into one step`);
        if (prev.qty !== l.qty) conflicts.push(`${partNo} ${l.process}: qty ${prev.qty} (${prev.file}) vs ${l.qty} (${file}); kept ${l.qty}`);
        if (prev.cycle != null && l.cycle_min != null && Math.abs(prev.cycle - l.cycle_min) > 0.001) {
          conflicts.push(`${partNo} ${l.process}: cycle ${prev.cycle} vs ${l.cycle_min} min/pc (${file}); kept ${l.cycle_min}`);
        }
      }
      seenFrom.set(key, { file, qty: l.qty, cycle: l.cycle_min ?? (prev && prev.cycle) });
    }
    await api('POST', `${url}&commit=1`, buf);
  }
  // One step per process, in the shop's process order (Laser 10, Polishing 20, Bending 30, Clinching 40).
  // The master dashboard numbers stages 1, 2, 3 without Laser; the order is the same.
  notes.push('Stage order 1-2-3 in the master dashboard (no Laser) was renumbered to the shop order: Laser 10, Polishing 20, Bending 30, Clinching 40.');
  database.exec(`UPDATE jt_steps SET seq = (SELECT seq FROM shop_processes p WHERE p.id = jt_steps.process_id)`);
  const dup = database.prepare('SELECT job_traveller_id, process_id, COUNT(*) AS n FROM jt_steps GROUP BY 1, 2 HAVING n > 1').all();
  if (dup.length) throw new Error(`Duplicate Job Traveller steps left: ${JSON.stringify(dup)}`);
  const drawings = database.prepare(`SELECT drawing_no, GROUP_CONCAT(part_no, ', ') AS parts, COUNT(DISTINCT substr(part_no, 1, 9)) AS families
    FROM job_travellers WHERE COALESCE(drawing_no, '') != '' GROUP BY substr(drawing_no, 1, 14) HAVING families > 1`).all();
  for (const d of drawings) conflicts.push(`Drawing ${d.drawing_no.slice(0, 14)} is used by different part families (${d.parts}). Kept as in the Laser report; please check with Design`);
  notes.push('Machine "CLINCH-01" in the Clinching report is the same machine as CL-01 (not added twice).');
}

const MACHINE_OF = [[/laser/i, 'LC-01'], [/press_brake|bending/i, 'BD-01'], [/clinch/i, 'CL-01']];
const FREQ = [[/semi/i, 'Semi-Annual'], [/daily/i, 'Daily'], [/weekly/i, 'Weekly'], [/monthly/i, 'Monthly'], [/quarter/i, 'Quarterly'], [/annual|yearly/i, 'Annual']];
const txt = (v) => String(v ?? '').trim();
const excelDate = (v) => (typeof v === 'number' ? new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}/.test(txt(v)) ? txt(v).slice(0, 10) : null);

// Maintenance checklists (improved versions) -> PM checklist tasks and work order log per machine.
async function loadMaintenance(api) {
  const machines = await api('GET', '/api/machines');
  const dir = path.join(bomDir, 'improved');
  const seenTask = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => /maintenance/i.test(f))) {
    const code = (MACHINE_OF.find(([re]) => re.test(file)) || [])[1];
    const machine = machines.find((m) => m.code === code);
    if (!machine) { notes.push(`No machine for ${file}`); continue; }
    let tasks = 0, logs = 0;
    for (const sheet of readXlsx(fs.readFileSync(path.join(dir, file)))) {
      sheet.rows.forEach((row, ri) => {
        if (!row) return;
        const head = Array.from(row, (v) => txt(v).toLowerCase());
        const at = (re) => head.findIndex((h) => re.test(h));
        if (at(/^frequency/) >= 0 && at(/task id|item no/) >= 0) {
          const c = { id: at(/task id|item no/), task: at(/maintenance item|subsystem|task description/), proc: at(/procedure|action required/),
            area: at(/component/), std: at(/standard|spec/), freq: at(/^frequency/), status: at(/^status/), date: at(/date (checked|completed)/),
            by: at(/checked by|technician/), rem: at(/remarks|notes/) };
          for (const r of sheet.rows.slice(ri + 1)) {
            if (!r || !txt(r[c.id]) || !txt(r[c.freq])) continue;
            const key = `${code}|${txt(r[c.id])}|${txt(r[c.task])}`;
            if (seenTask.has(key)) { merged.push(`${code} PM task ${txt(r[c.id])} listed twice in ${file}`); continue; }
            seenTask.add(key);
            const task = c.area >= 0 ? `${txt(r[c.area])}: ${txt(r[c.task])}` : txt(r[c.task]);
            const status = ['Pass', 'Fail', 'Pending', 'N/A'].find((s) => s.toLowerCase() === txt(r[c.status]).toLowerCase()) || 'Pending';
            tasks++;
            pending.push(api('POST', '/api/pm_tasks', {
              machine_id: machine.id, item_no: txt(r[c.id]), task: task.slice(0, 200), procedure: c.proc >= 0 ? txt(r[c.proc]) : '',
              standard: c.std >= 0 ? txt(r[c.std]) : '', frequency: (FREQ.find(([re]) => re.test(txt(r[c.freq]))) || [0, 'Monthly'])[1],
              status, checked_on: c.date >= 0 ? excelDate(r[c.date]) : null, checked_by: c.by >= 0 ? txt(r[c.by]) : '', remarks: c.rem >= 0 ? txt(r[c.rem]) : '',
            }));
          }
        }
        if (at(/downtime/) >= 0 && at(/^date$/) >= 0 && at(/description|issue/) >= 0) {
          const c = { date: at(/^date$/), desc: at(/description|issue/), action: at(/action taken|parts replaced/), by: at(/technician|performed by/),
            hrs: at(/downtime/), status: at(/^status/), type: at(/maintenance type/) };
          for (const r of sheet.rows.slice(ri + 1)) {
            if (!r || !txt(r[c.desc])) continue;
            const date = excelDate(r[c.date]);
            const closed = /closed/i.test(txt(r[c.status]));
            logs++;
            pending.push(api('POST', '/api/maint_orders', {
              machine_id: machine.id, kind: /calibrat|audit|annual|monthly|daily/i.test(`${txt(r[c.type])} ${txt(r[c.desc])}`) ? 'Preventive' : 'Breakdown',
              title: txt(r[c.desc]).slice(0, 120), opened: date, closed: closed ? date : null, downtime_min: Math.round((Number(r[c.hrs]) || 0) * 60),
              pic: c.by >= 0 ? txt(r[c.by]) : '', status: closed ? 'Closed' : 'Open', details: c.action >= 0 ? txt(r[c.action]) : '',
            }));
          }
        }
      });
    }
    await Promise.all(pending.splice(0));
    notes.push(`${file}: ${tasks} PM tasks and ${logs} log entries for ${code}`);
  }
  // Machine details from the Clinching checklist.
  const cl = machines.find((m) => m.code === 'CL-01');
  if (cl) await api('PUT', `/api/machines/${cl.id}`, { name: 'PEMSERTER Series 4 (PEM-SERIES-4-01)', location: 'Sheet Metal Shop - Line 2' });
}
const pending = [];

const MATERIAL = [[/spcc|mild/i, 'SPCC'], [/secc|galvan/i, 'SECC'], [/alu/i, 'Aluminium'], [/stainless|ss304|^ss/i, 'SS']];

// The Sheetmetal BOM template -> a project with its mother part (assembly) and child parts.
async function loadBom(api) {
  const file = fs.readdirSync(path.join(bomDir, 'improved')).find((f) => /bom/i.test(f));
  if (!file) return;
  const sheet = readXlsx(fs.readFileSync(path.join(bomDir, 'improved', file))).find((s) => /bom/i.test(s.name));
  const val = (label) => { for (const r of sheet.rows) { if (!r) continue; const i = r.findIndex((v) => txt(v).toLowerCase() === label); if (i >= 0) return r[i + 1]; } return null; };
  const headAt = sheet.rows.findIndex((r) => r && r.some((v) => /^part number$/i.test(txt(v))));
  const head = sheet.rows[headAt].map((v) => txt(v).toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const c = { no: col(/^part number/), name: col(/part name/), cat: col(/^category/), mat: col(/material/), thk: col(/thickness/), flat: col(/flat pattern/),
    qty: col(/qty per unit/), hw: col(/hardware/), flow: col(/process workflow/), fin: col(/finishing/), mb: col(/make/) };
  const procs = await api('GET', '/api/shop_processes');
  if (!procs.some((p) => p.code === 'WELD')) {
    procs.push(await api('POST', '/api/shop_processes', { code: 'WELD', name: 'Welding', seq: 50, unit: 'Piece', extra_fields: 'Weld type, Filler rod', active: 'Yes' }));
    notes.push('Added shop process Welding (seq 50), needed by the BOM routing "TIG Welding".');
  }
  const flowIds = (flow) => {
    const out = [];
    for (const step of String(flow || '').split(/->|→/)) {
      const t = step.trim();
      const p = /pem|insertion/i.test(t) ? procs.find((x) => x.code === 'CLINCH') : procs.find((x) => new RegExp(x.code === 'LASER' ? 'laser' : x.name, 'i').test(t));
      if (p && !out.includes(p.id)) out.push(p.id);
    }
    return out;
  };
  const assembly = txt(val('assembly ref:'));
  const parts = [{ key: 'asm', part_no: assembly, description: txt(val('project name:')), category: 'Assembly', make_buy: 'Make', drawing_no: txt(val('drawing no / rev:')) }];
  for (const r of sheet.rows.slice(headAt + 1)) {
    if (!r || !txt(r[c.no])) continue;
    const matText = txt(r[c.mat]);
    const material = (MATERIAL.find(([re]) => re.test(matText)) || [0, 'Other'])[1];
    if (material === 'Other' || !/^(spcc|secc|aluminium|ss)$/i.test(matText)) notes.push(`BOM ${txt(r[c.no])}: material "${matText}" saved as ${material}`);
    parts.push({ key: txt(r[c.no]), parent_key: 'asm', part_no: txt(r[c.no]), description: txt(r[c.name]), category: txt(r[c.cat]) || null,
      material, thickness: Number(r[c.thk]) || null, flat_size: txt(r[c.flat]).replace(/^-$/, ''), qty_per_parent: Number(r[c.qty]) || 1,
      hardware: txt(r[c.hw]).replace(/^N\/A$/i, ''), process_flow: txt(r[c.flow]), finish: txt(r[c.fin]), make_buy: txt(r[c.mb]) || null,
      process_ids: flowIds(r[c.flow]) });
  }
  const sets = Number(val('target product qty:')) || 1;
  const due = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  const res = await api('POST', '/api/projects/tree', { sets, create_jts: true, parts,
    project: { code: 'ENC-2026-01', name: txt(val('project name:')), customer: 'Internal', work_order: assembly, due_date: due, status: 'Planned' } });
  notes.push(`BOM ${file}: project ENC-2026-01 with ${res.parts.length} parts (${res.parts.filter((p) => p.jt_no).length} Job Travellers for Make parts, ${sets} sets).`);
}

// Shop-floor layout in process order: Laser -> Polishing -> Bending -> Clinching -> Welding / QC.
async function loadLayout(api) {
  const machines = await api('GET', '/api/machines');
  const id = (code) => (machines.find((m) => m.code === code) || {}).id || null;
  const item = (type, label, x, y, w, h, extra = {}) => ({ id: `${type}-${label}`.replace(/[^\w-]/g, '').slice(0, 20), type, label, x, y, w, h, machine_id: null, location: '', ...extra });
  const items = [
    item('wall', 'North wall', 0, 0, 80, 1),
    item('cell', 'Cutting cell', 1, 2, 20, 14), item('machine', 'LC-01 Fiber laser', 3, 4, 12, 8, { machine_id: id('LC-01') }),
    item('storage', 'Store rack B2', 15, 12, 5, 3, { location: 'Store rack B2' }),
    item('cell', 'Finishing cell', 22, 2, 14, 14), item('machine', 'PL-01 Polishing', 24, 4, 9, 6, { machine_id: id('PL-01') }),
    item('storage', 'Polishing bay', 24, 11, 9, 4, { location: 'Polishing bay' }),
    item('cell', 'Forming cell', 37, 2, 22, 14), item('machine', 'BD-01 Press brake', 39, 4, 12, 5, { machine_id: id('BD-01') }),
    item('storage', 'Tool cabinet BD-01', 52, 4, 6, 5, { location: 'Tool cabinet BD-01' }),
    item('machine', 'CL-01 Clinching', 40, 10, 8, 5, { machine_id: id('CL-01') }),
    item('walkway', 'Main walkway', 0, 17, 80, 4),
    item('storage', 'Store rack A1', 2, 22, 8, 5, { location: 'Store rack A1' }),
    item('storage', 'Chemical store', 11, 22, 7, 5, { location: 'Chemical store' }),
    item('office', 'QC table', 40, 22, 10, 6), item('storage', 'QC tools', 51, 22, 6, 6, { location: 'QC table' }),
    item('office', 'Supervisor office', 62, 2, 16, 10), item('cell', 'Welding (planned)', 60, 22, 18, 8),
    item('label', 'Material in', 1, 28, 10, 2), item('label', 'Finished goods out', 66, 14, 12, 2),
  ];
  await api('POST', '/api/layout', { floor: { w: 80, h: 32 }, items, note: 'Sheet metal area, process order Laser > Polishing > Bending > Clinching' });
}

function report() {
  const list = (a) => (a.length ? a.map((x) => `- ${x}`).join('\n') : '- None');
  return `# Data check for the preview (${new Date().toISOString().slice(0, 10)})

Sources: NEWAYS schedule reports (Laser, Polishing, Bending, Clinching), MASTER combined
dashboard, maintenance checklists (improved), Sheetmetal BOM (improved).

## Duplicates merged (${merged.length})
${list(merged)}

## Differences settled (${conflicts.length})
${list(conflicts)}

## Notes
${list(notes)}
`;
}

main().catch((err) => { console.error(err); process.exit(1); });
