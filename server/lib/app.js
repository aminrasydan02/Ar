'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resources, PROCESSES, MOVE_SIGN } = require('./resources');
const { ROLES, can, rightsFor, canApprove, canEditLayout, setProcessRights } = require('./perm');
const { checkLayout, starterLayout } = require('./layout');
const auth = require('./auth');
const { FORMATS, MODEL_FORMATS, MIME, parseDrawingName, safeFilename, checkContent } = require('./drawings');
const { buildDashboard } = require('./dashboard');
const { readJobTravellers } = require('./jtimport');
const templates = require('./templates');

const VERSION = require('../../package.json').version;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;
const THEMES = ['standard', 'light', 'dark', 'green', 'contrast', 'galaxy']; // public/styles.css [data-theme]
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

// Today's date on the server clock (local time), as YYYY-MM-DD.
function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({ db, drawingsDir, secureCookies = false, company = 'Sheet Metal Department', publicHosts = [] }) {
  fs.mkdirSync(drawingsDir, { recursive: true });
  const loadRights = () => setProcessRights(db.prepare('SELECT process, resource FROM process_rights').all());
  loadRights();

  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJson(req) {
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      throw new HttpError(415, 'Expected JSON');
    }
    const buf = await readBody(req, MAX_JSON);
    try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  // before / after: the record as JSON, so every change can be traced (who, when, what).
  function audit(user, action, resource, id, before, after) {
    const js = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
    db.prepare('INSERT INTO audit (username, action, resource, record_id, before, after) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user ? user.username : null, action, resource, id ?? null, js(before), js(after));
  }

  function allow(user, action, resource) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (!can(user, action, resource)) throw new HttpError(403, `${user.process || user.role} cannot ${action} ${resource.replace(/_/g, ' ')}`);
  }

  // ---- generic records ----------------------------------------------------

  function selectSql(name) {
    const res = resources[name];
    const joins = [];
    const extra = [];
    res.fields.filter((f) => f.type === 'ref').forEach((f, i) => {
      const alias = `r${i}`;
      joins.push(`LEFT JOIN ${f.ref} ${alias} ON ${alias}.id = t.${f.name}`);
      extra.push(`${alias}.${resources[f.ref].display} AS ${f.name}__label`);
    });
    return `SELECT t.*${extra.length ? ', ' + extra.join(', ') : ''} FROM ${name} t ${joins.join(' ')}`;
  }

  function listRecords(name, query) {
    const res = resources[name];
    const where = [];
    const params = [];
    for (const f of res.fields) {
      if (query.has(f.name)) { where.push(`t.${f.name} = ?`); params.push(query.get(f.name)); }
    }
    const q = (query.get('q') || '').trim();
    if (q) {
      const textCols = res.fields.filter((f) => f.type !== 'ref' && f.type !== 'number').map((f) => `t.${f.name}`);
      where.push(`(${textCols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      textCols.forEach(() => params.push(`%${q}%`));
    }
    const sql = `${selectSql(name)}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY t.id DESC LIMIT 5000`;
    return db.prepare(sql).all(...params).map(stripHidden(name));
  }

  function getRecord(name, id) {
    const row = db.prepare(`${selectSql(name)} WHERE t.id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Not found');
    return stripHidden(name)(row);
  }

  function stripHidden(name) {
    const hidden = resources[name].fields.filter((f) => f.hidden).map((f) => f.name);
    return (row) => {
      const out = { ...row };
      for (const h of hidden) delete out[h];
      return out;
    };
  }

  // No code in the website: text that looks like HTML or script is refused, never stored.
  const CODE = /<\s*[a-z!/?][^>]*>|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i;
  function noCode(label, v) {
    if (CODE.test(String(v))) throw new HttpError(400, `${label}: code, HTML or script is not allowed`);
  }

  function clean(name, input, { partial }) {
    const res = resources[name];
    const out = {};
    const errors = [];
    for (const f of res.fields) {
      if (f.readonly) continue;
      if (!(f.name in input)) {
        if (!partial && f.default !== undefined) out[f.name] = f.default;
        else if (!partial && f.required) errors.push(`${f.label} is required`);
        continue;
      }
      let v = input[f.name];
      if (v === '' || v === undefined) v = null;
      if (v !== null) {
        if (f.type === 'json') {
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
          const ok = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 30 &&
            Object.values(v).every((x) => ['string', 'number'].includes(typeof x) && String(x).length <= 500);
          if (!ok) { errors.push(`${f.label} must be a list of short values`); continue; }
          Object.values(v).forEach((x) => noCode(f.label, x));
          v = JSON.stringify(v);
        } else if (f.type === 'number' || f.type === 'ref') {
          const n = Number(v);
          if (!Number.isFinite(n)) { errors.push(`${f.label} must be a number`); continue; }
          v = f.type === 'ref' ? Math.trunc(n) : n;
        } else {
          v = String(v).trim();
          noCode(f.label, v);
          if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { errors.push(`${f.label} must be a date (YYYY-MM-DD)`); continue; }
          if (f.type === 'select' && !f.options.includes(v)) { errors.push(`${f.label} must be one of: ${f.options.join(', ')}`); continue; }
        }
      }
      if (v === null && f.required) { errors.push(`${f.label} is required`); continue; }
      out[f.name] = v;
    }
    if (errors.length) throw new HttpError(400, errors.join('; '));
    return out;
  }

  function friendlyDbError(err) {
    const msg = String(err && err.message);
    if (msg.includes('UNIQUE')) return new HttpError(409, 'A record with the same value already exists');
    if (msg.includes('FOREIGN KEY')) return new HttpError(400, 'A linked record does not exist');
    return err;
  }

  // Running numbers per year, e.g. NCR-2026-0001 or ISS-2026-0001.
  function nextNumber(table, column, prefix, date) {
    const year = String(date || localToday()).slice(0, 4);
    const row = db.prepare(`SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`).get(`${prefix}-${year}-%`);
    const n = row ? Number(row.no.split('-')[2]) + 1 : 1;
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
  }

  // Values a new record takes from the signed-in user when the form leaves them empty.
  function userDefaults(name, input, user) {
    const out = { ...input };
    const blank = (k) => out[k] === undefined || out[k] === null || out[k] === '';
    if (name === 'daily_logs') {
      if (blank('date')) out.date = localToday();
      if (blank('process') && user.process) out.process = user.process;
    }
    if (name === 'operator_outputs' && blank('date')) out.date = localToday();
    if (name === 'issues') {
      if (blank('opened')) out.opened = localToday();
      if (blank('from_process') && user.process) out.from_process = user.process;
    }
    return out;
  }

  // ---- inventory stock ----------------------------------------------------
  const stockStatus = (qty, min) => (qty <= 0 ? 'Out' : qty <= (min || 0) ? 'Low' : 'OK');
  function setStock(itemId, qty) {
    const item = db.prepare('SELECT min_qty FROM inventory_items WHERE id = ?').get(itemId);
    db.prepare("UPDATE inventory_items SET qty_on_hand = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(qty, stockStatus(qty, item.min_qty), itemId);
  }
  function logMove(itemId, move, qty, user, remark) {
    db.prepare('INSERT INTO inventory_moves (date, item_id, move, qty, process, remark, moved_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(localToday(), itemId, move, qty, user.process || null, remark, user.username);
  }
  // How much a movement changes the stock, refusing to go below zero.
  function moveDelta(data) {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(data.item_id);
    if (!item) throw new HttpError(400, 'Item not found');
    const sign = MOVE_SIGN[data.move];
    if (sign !== 0 && !(data.qty > 0)) throw new HttpError(400, 'Qty must be more than 0');
    const delta = sign === 0 ? data.qty : sign * data.qty;
    if ((item.qty_on_hand || 0) + delta < 0) throw new HttpError(400, `Not enough stock: ${item.qty_on_hand || 0} ${item.unit || ''} of ${item.code} on hand`);
    return { item, delta };
  }

  function createRecord(name, data, user) {
    let stock = null;
    if (name === 'inventory_moves') {
      stock = moveDelta(data);
      data.moved_by = user.username;
      if (!data.process && user.process) data.process = user.process;
    }
    if (name === 'inventory_items') data.status = stockStatus(data.qty_on_hand || 0, data.min_qty);
    if (name === 'ncrs') data.ncr_no = nextNumber('ncrs', 'ncr_no', 'NCR', data.date);
    if (name === 'issues') {
      data.issue_no = nextNumber('issues', 'issue_no', 'ISS', data.opened);
      data.raised_by = user.username;
      if (['Resolved', 'Closed'].includes(data.status) && !data.resolved) data.resolved = localToday();
    }
    if (name === 'daily_logs') data.logged_by = user.username;
    if (name === 'operator_outputs') data.operator = user.username;
    if (name === 'job_travellers' && !data.jt_no) data.jt_no = nextNumber('job_travellers', 'jt_no', 'JT');
    const cols = Object.keys(data);
    try {
      const r = db.prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => data[c]));
      const id = Number(r.lastInsertRowid);
      if (stock) setStock(stock.item.id, (stock.item.qty_on_hand || 0) + stock.delta);
      if (name === 'inventory_items' && data.qty_on_hand > 0) logMove(id, 'Receive', data.qty_on_hand, user, 'Opening stock');
      audit(user, 'create', name, id, null, data);
      return getRecord(name, id);
    } catch (err) { throw friendlyDbError(err); }
  }

  function updateRecord(name, id, data, user) {
    const current = getRecord(name, id);
    const owner = resources[name].ownerField;
    if (owner && user.role !== 'admin' && current[owner] !== user.username) {
      throw new HttpError(403, `Only ${current[owner] || 'the person who wrote it'} or Admin can change this ${resources[name].singular.toLowerCase()}`);
    }
    if (name === 'issues' && ['Resolved', 'Closed'].includes(data.status) && !current.resolved && !data.resolved) data.resolved = localToday();
    if (name === 'inventory_moves') throw new HttpError(400, 'A stock movement cannot be changed. Record an Adjust instead');
    if (name === 'inventory_items') {
      const qty = data.qty_on_hand ?? current.qty_on_hand ?? 0;
      if (qty < 0) throw new HttpError(400, 'Qty on hand cannot be below 0');
      if (qty !== (current.qty_on_hand ?? 0)) logMove(id, 'Adjust', qty - (current.qty_on_hand ?? 0), user, 'Stock count');
      data.status = stockStatus(qty, data.min_qty ?? current.min_qty);
    }
    const cols = Object.keys(data);
    if (cols.length) {
      try {
        db.prepare(`UPDATE ${name} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...cols.map((c) => data[c]), id);
      } catch (err) { throw friendlyDbError(err); }
    }
    const after = getRecord(name, id);
    const changed = (o) => Object.fromEntries(cols.map((c) => [c, o[c] ?? null]));
    audit(user, 'update', name, id, changed(current), changed(after));
    return after;
  }

  function deleteRecord(name, id, user) {
    const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Not found');
    if (name === 'inventory_moves') {
      const item = db.prepare('SELECT qty_on_hand FROM inventory_items WHERE id = ?').get(row.item_id);
      const sign = MOVE_SIGN[row.move];
      if (item) setStock(row.item_id, Math.max(0, (item.qty_on_hand || 0) - (sign === 0 ? row.qty : sign * row.qty)));
    }
    db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
    if (name === 'drawings' && row.stored_name) fs.rmSync(path.join(drawingsDir, row.stored_name), { force: true });
    audit(user, 'delete', name, id, row, null);
  }

  function toCsv(name, rows) {
    const fields = resources[name].fields.filter((f) => !f.hidden);
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['ID', ...fields.map((f) => f.label)].map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.id, ...fields.map((f) => (f.type === 'ref' ? r[`${f.name}__label`] : r[f.name]))].map(esc).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ---- drawings -----------------------------------------------------------

  async function uploadDrawing(req, url, user) {
    allow(user, 'upload', 'drawings');
    const filename = safeFilename(url.searchParams.get('filename'));
    const parsed = parseDrawingName(filename);
    if (!FORMATS.includes(parsed.format)) throw new HttpError(400, `File type not allowed. Use: ${FORMATS.join(', ')}`);
    const partNo = (url.searchParams.get('part_no') || parsed.part_no).trim();
    const rev = (url.searchParams.get('rev') || parsed.rev).trim().toUpperCase();
    if (!partNo) throw new HttpError(400, 'Part number missing');
    const jtId = Number(url.searchParams.get('job_traveller_id')) || null;
    if (jtId && !db.prepare('SELECT id FROM job_travellers WHERE id = ?').get(jtId)) throw new HttpError(400, 'Job Traveller not found');
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw new HttpError(400, 'File is empty');
    const bad = checkContent(parsed.format, body);
    if (bad) throw new HttpError(400, bad);
    const kind = MODEL_FORMATS.includes(parsed.format) ? '3D model' : ['png', 'jpg', 'jpeg'].includes(parsed.format) ? 'Image' : 'Drawing';
    const dup = db.prepare('SELECT id FROM drawings WHERE part_no = ? AND rev = ? AND format = ?').get(partNo, rev, parsed.format);
    if (dup) throw new HttpError(409, `Drawing ${partNo} rev ${rev || '-'} (${parsed.format}) already exists`);
    const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${parsed.format}`;
    fs.writeFileSync(path.join(drawingsDir, storedName), body);
    db.exec('BEGIN');
    try {
      // A new revision of the same part and format supersedes the older ones.
      db.prepare("UPDATE drawings SET status = 'Superseded', updated_at = datetime('now') WHERE part_no = ? AND format = ? AND status = 'Current'")
        .run(partNo, parsed.format);
      const r = db.prepare(`INSERT INTO drawings (part_no, rev, format, kind, job_traveller_id, status, filename, size, stored_name, uploaded_by)
        VALUES (?, ?, ?, ?, ?, 'Current', ?, ?, ?, ?)`).run(partNo, rev, parsed.format, kind, jtId, filename, body.length, storedName, user.username);
      db.exec('COMMIT');
      const id = Number(r.lastInsertRowid);
      audit(user, 'upload', 'drawings', id);
      return getRecord('drawings', id);
    } catch (err) {
      db.exec('ROLLBACK');
      fs.rmSync(path.join(drawingsDir, storedName), { force: true });
      throw err;
    }
  }

  function sendDrawing(res, id, user, download) {
    allow(user, 'read', 'drawings');
    const row = db.prepare('SELECT * FROM drawings WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Not found');
    const file = path.join(drawingsDir, row.stored_name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'File missing on server');
    const type = (!download && MIME[row.format]) || 'application/octet-stream';
    const disp = `${download ? 'attachment' : 'inline'}; filename="${row.filename.replace(/"/g, '')}"`;
    res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': disp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    fs.createReadStream(file).pipe(res);
  }

  // ---- workflow -----------------------------------------------------------

  function generateWorkflow(partId, user) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (!can(user, 'update', 'parts')) throw new HttpError(403, 'Not allowed');
    getRecord('parts', partId);
    const existing = db.prepare('SELECT COUNT(*) AS n FROM wf_steps WHERE part_id = ?').get(partId).n;
    if (existing) throw new HttpError(409, 'This part already has workflow steps');
    const ops = db.prepare('SELECT operation FROM routings WHERE part_id = ? ORDER BY seq').all(partId).map((r) => r.operation);
    const head = ['Drawing review', 'Programming'];
    const tail = ['QC', 'Packing', 'Delivery'];
    const steps = [...head, ...ops.filter((o) => !head.includes(o) && !tail.includes(o)), ...tail];
    const ins = db.prepare("INSERT INTO wf_steps (part_id, seq, step, status, qty_done) VALUES (?, ?, ?, 'Not started', 0)");
    db.exec('BEGIN');
    steps.forEach((s, i) => ins.run(partId, (i + 1) * 10, s));
    db.exec('COMMIT');
    audit(user, 'generate-workflow', 'parts', partId);
    return listRecords('wf_steps', new URLSearchParams({ part_id: String(partId) }));
  }

  // ---- templates: download, fill in Excel, import ------------------------

  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const xlsxHeaders = (file) => ({ 'Content-Type': XLSX_TYPE, 'Content-Disposition': `attachment; filename="${file}"` });

  // Without commit=1 it only checks the rows; with it, all rows are saved or none.
  async function importTemplate(req, url, name, user) {
    allow(user, 'create', name);
    if (resources[name].noCreate) throw new HttpError(400, 'This module cannot be imported');
    const filename = safeFilename(url.searchParams.get('filename') || 'import.xlsx');
    if (!/\.(xlsx|csv)$/i.test(filename)) throw new HttpError(400, 'Use an .xlsx or .csv file');
    let rows;
    try { rows = templates.readTemplate(db, name, await readBody(req, 20 * 1024 * 1024), filename); } catch (err) { throw new HttpError(400, err.message); }
    if (!rows.length) throw new HttpError(400, 'The template has no rows to import');
    if (rows.length > 2000) throw new HttpError(400, 'At most 2,000 rows per import');
    const checked = rows.map((r) => {
      const errors = [...r.errors];
      let data = null;
      if (!errors.length) {
        try { data = clean(name, userDefaults(name, r.input, user), { partial: false }); } catch (err) { errors.push(err.message); }
      }
      return { line: r.line, data, errors };
    });
    const bad = checked.filter((r) => r.errors.length).map((r) => ({ line: r.line, error: r.errors.join('; ') }));
    const result = { rows: checked.length, ok: checked.length - bad.length, errors: bad };
    if (url.searchParams.get('commit') !== '1') return result;
    if (bad.length) throw new HttpError(400, `Fix ${bad.length} row(s) first: ${bad.slice(0, 3).map((b) => `row ${b.line}: ${b.error}`).join(' | ')}`);
    db.exec('BEGIN');
    try {
      for (const r of checked) createRecord(name, r.data, user);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err.status ? new HttpError(err.status, `${err.message} (import cancelled, nothing saved)`) : err; }
    return { ...result, committed: true };
  }

  // ---- job travellers ----------------------------------------------------

  // Target, good and reject per process step, summed from the Operator form.
  function jtProgress(id) {
    getRecord('job_travellers', id);
    return db.prepare(`
      SELECT s.id, s.seq, s.cycle_min, s.target_qty, s.details, p.id AS process_id, p.name AS process, p.unit,
        COALESCE(SUM(o.good_qty), 0) AS good, COALESCE(SUM(o.reject_qty), 0) AS reject, COALESCE(SUM(o.run_min), 0) AS run_min
      FROM jt_steps s JOIN shop_processes p ON p.id = s.process_id
      LEFT JOIN operator_outputs o ON o.job_traveller_id = s.job_traveller_id AND o.process_id = s.process_id
      WHERE s.job_traveller_id = ? GROUP BY s.id ORDER BY COALESCE(s.seq, p.seq), p.seq`).all(id);
  }

  // Everything about one Job Traveller: where it is now, each stage, parts, files, issues.
  function jtInfo(id) {
    const jt = getRecord('job_travellers', id);
    const steps = jtProgress(id).map((st) => ({ ...st,
      state: st.target_qty && st.good >= st.target_qty ? 'Done' : st.good || st.reject ? 'In progress' : 'Pending' }));
    const current = steps.find((st) => st.state !== 'Done') || null;
    const part = db.prepare('SELECT * FROM parts WHERE part_no = ?').get(jt.part_no) || null;
    const jtOf = db.prepare("SELECT id, jt_no, status FROM job_travellers WHERE part_no = ? AND status != 'Cancelled' ORDER BY id DESC LIMIT 1");
    const withJt = (p) => p && { part_no: p.part_no, description: p.description, qty_per_set: p.qty_per_set, jt: jtOf.get(p.part_no) || null };
    return {
      jt, steps, current: current ? current.process : steps.length ? 'Completed' : null,
      part, parent: part && part.parent_no ? withJt(db.prepare('SELECT * FROM parts WHERE part_no = ?').get(part.parent_no)) : null,
      children: db.prepare('SELECT * FROM parts WHERE parent_no = ? ORDER BY part_no').all(jt.part_no).map(withJt),
      drawings: listRecords('drawings', new URLSearchParams()).filter((d) => d.job_traveller_id === jt.id || d.part_no === jt.part_no),
      issues: db.prepare(`SELECT id, issue_no, title, status, priority, from_process, to_process, opened, due_date FROM issues
        WHERE job_traveller_id = ? OR (part_no IS NOT NULL AND part_no = ?) ORDER BY id DESC`).all(jt.id, jt.part_no),
    };
  }

  // ---- shop-floor layout ---------------------------------------------------
  // Live data for the layout: machine status, open work orders, last Job Traveller run, stock per location.
  function layoutLive() {
    const machines = db.prepare(`SELECT m.id, m.code, m.name, m.machine_type, m.status,
        (SELECT COUNT(*) FROM maint_orders w WHERE w.machine_id = m.id AND w.status != 'Closed') AS open_wo
      FROM machines m ORDER BY m.code`).all();
    const lastRun = db.prepare(`SELECT o.date, j.id AS jt_id, j.jt_no, j.part_no FROM operator_outputs o JOIN job_travellers j ON j.id = o.job_traveller_id
      WHERE o.machine IN (?, ?) ORDER BY o.date DESC, o.id DESC LIMIT 1`);
    for (const m of machines) m.last = lastRun.get(m.code, m.name) || null;
    const locations = db.prepare(`SELECT location, COUNT(*) AS items, SUM(status IN ('Low','Out')) AS low
      FROM inventory_items WHERE COALESCE(location, '') != '' GROUP BY location ORDER BY location`).all();
    return { machines, locations };
  }

  function handleLayout(req, res, method, parts, user) {
    allow(user, 'read', 'machines');
    const get = (v) => (v ? db.prepare('SELECT * FROM floor_layouts WHERE version = ?').get(v) : db.prepare('SELECT * FROM floor_layouts ORDER BY version DESC LIMIT 1').get());
    const shape = (row, live) => (row ? { version: row.version, note: row.note, saved_by: row.saved_by, created_at: row.created_at, ...JSON.parse(row.data), ...live }
      : { version: null, ...starterLayout(live.machines, live.locations.map((l) => l.location)), ...live });
    if (method === 'GET' && parts[1] === 'versions' && parts[2]) {
      const row = get(Number(parts[2]));
      if (!row) throw new HttpError(404, 'Version not found');
      return send(res, 200, shape(row, layoutLive()));
    }
    if (method === 'GET' && parts[1] === 'versions') {
      return send(res, 200, db.prepare('SELECT version, note, saved_by, created_at FROM floor_layouts ORDER BY version DESC LIMIT 200').all());
    }
    if (method === 'GET' && !parts[1]) return send(res, 200, shape(get(), layoutLive()));
    if (method === 'POST' && !parts[1]) {
      if (!canEditLayout(user)) throw new HttpError(403, 'Only Admin, Planner, Supervisor, Technician or Manager can change the layout');
      return readJson(req).then((b) => {
        let layout;
        try { layout = checkLayout(b, noCode); } catch (err) { throw err instanceof HttpError ? err : new HttpError(400, err.message); }
        const note = String(b.note || '').trim().slice(0, 200);
        noCode('Note', note);
        const version = (db.prepare('SELECT MAX(version) AS v FROM floor_layouts').get().v || 0) + 1;
        db.prepare('INSERT INTO floor_layouts (version, data, note, saved_by) VALUES (?, ?, ?, ?)').run(version, JSON.stringify(layout), note || null, user.username);
        audit(user, 'save', 'layout', version);
        return send(res, 201, shape(get(version), layoutLive()));
      });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // New project with a mother part and its child parts (any depth) in one go.
  // parts: [{ key, parent_key, part_no, description, material, thickness, qty_per_parent, process_ids }]
  function createProjectTree(b, user) {
    allow(user, 'create', 'projects');
    allow(user, 'create', 'parts');
    if (b.create_jts) allow(user, 'create', 'job_travellers');
    const list = Array.isArray(b.parts) ? b.parts : [];
    if (!list.length) throw new HttpError(400, 'Add at least the mother part');
    if (list.length > 500) throw new HttpError(400, 'At most 500 parts per project');
    const sets = Math.max(1, Math.trunc(Number(b.sets) || 1));
    const byKey = new Map();
    db.exec('BEGIN');
    try {
      const project = createRecord('projects', clean('projects', b.project || {}, { partial: false }), user);
      const out = [];
      for (const [i, raw] of list.entries()) {
        const parent = raw.parent_key != null && raw.parent_key !== '' ? byKey.get(String(raw.parent_key)) : null;
        if (raw.parent_key != null && raw.parent_key !== '' && !parent) throw new HttpError(400, `Line ${i + 1}: parent part must come before its child`);
        const qtyPer = Number(raw.qty_per_parent ?? 1);
        if (!(qtyPer > 0)) throw new HttpError(400, `Line ${i + 1}: Qty per parent must be more than 0`);
        const data = { project_id: project.id, part_no: raw.part_no, parent_no: parent ? parent.part_no : null,
          description: raw.description, material: raw.material, thickness: raw.thickness,
          qty_per_set: qtyPer * (parent ? parent.qty_per_set : 1), sets };
        for (const k of ['category', 'make_buy', 'drawing_no', 'flat_size', 'process_flow', 'finish', 'hardware']) if (raw[k]) data[k] = raw[k];
        let part;
        try { part = createRecord('parts', clean('parts', data, { partial: false }), user); } catch (err) { throw new HttpError(err.status || 400, `Line ${i + 1}: ${err.message}`); }
        byKey.set(String(raw.key ?? i), part);
        let jt = null;
        if (b.create_jts && raw.make_buy !== 'Buy') { // bought parts need no Job Traveller
          jt = createRecord('job_travellers', clean('job_travellers', { project_id: project.id, customer: project.customer, part_no: part.part_no,
            description: part.description, drawing_no: part.drawing_no, material: part.material, thickness: part.thickness, qty: part.qty_per_set * sets, due_date: project.due_date }, { partial: false }), user);
          const procs = (Array.isArray(raw.process_ids) ? raw.process_ids : []).map(Number)
            .map((pid) => db.prepare('SELECT id, seq FROM shop_processes WHERE id = ?').get(pid)).filter(Boolean);
          for (const pr of procs) {
            createRecord('jt_steps', { job_traveller_id: jt.id, process_id: pr.id, seq: pr.seq, target_qty: jt.qty }, user);
          }
        }
        out.push({ ...part, jt_id: jt && jt.id, jt_no: jt && jt.jt_no });
      }
      db.exec('COMMIT');
      return { project, parts: out };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Excel/CSV import. Without commit=1 it only shows what would change.
  async function importJobTravellers(req, url, user) {
    allow(user, 'create', 'job_travellers');
    const filename = safeFilename(url.searchParams.get('filename') || 'import.xlsx');
    if (!/\.(xlsx|csv)$/i.test(filename)) throw new HttpError(400, 'Use an .xlsx or .csv file');
    const body = await readBody(req, 20 * 1024 * 1024);
    const processes = db.prepare('SELECT id, code, name, seq FROM shop_processes').all();
    let parsed;
    try { parsed = readJobTravellers(body, filename, processes); } catch (err) { throw new HttpError(400, err.message); }
    const projectId = Number(url.searchParams.get('project_id')) || null;
    const find = db.prepare("SELECT id, jt_no FROM job_travellers WHERE part_no = ? AND status NOT IN ('Completed','Cancelled') ORDER BY id LIMIT 1");
    const plan = parsed.lines.map((l) => {
      const jt = find.get(l.part_no) || (!/_PART_/i.test(l.part_no) && find.get(`${l.part_no}_PART_1`)) || null;
      return { ...l, jt_id: jt ? jt.id : null, jt_no: jt ? jt.jt_no : null, action: jt ? 'update' : 'new' };
    });
    const result = { file: filename, sheet: parsed.sheet, lines: plan };
    if (url.searchParams.get('commit') !== '1') return result;

    db.exec('BEGIN');
    try {
      for (const l of plan) {
        const known = l.jt_id || plan.find((x) => x !== l && x.jt_id && x.part_no === l.part_no);
        if (known && !l.jt_id) Object.assign(l, { jt_id: known.jt_id, jt_no: known.jt_no });
        if (!l.jt_id) {
          const rec = createRecord('job_travellers', { project_id: projectId, part_no: l.part_no, drawing_no: l.drawing_no || null,
            material: l.material, thickness: l.thickness, qty: l.qty, status: 'Planned' }, user);
          Object.assign(l, { jt_id: rec.id, jt_no: rec.jt_no });
        }
        if (!l.process_id) continue;
        const step = db.prepare('SELECT id FROM jt_steps WHERE job_traveller_id = ? AND process_id = ?').get(l.jt_id, l.process_id);
        if (step) {
          db.prepare("UPDATE jt_steps SET cycle_min = COALESCE(?, cycle_min), seq = COALESCE(?, seq), target_qty = ?, updated_at = datetime('now') WHERE id = ?")
            .run(l.cycle_min, l.seq, l.qty, step.id);
        } else {
          db.prepare('INSERT INTO jt_steps (job_traveller_id, process_id, seq, cycle_min, target_qty) VALUES (?, ?, ?, ?, ?)')
            .run(l.jt_id, l.process_id, l.seq, l.cycle_min, l.qty);
        }
        // Output already recorded in the report is brought in once, so progress matches it.
        const hasOutput = db.prepare('SELECT 1 FROM operator_outputs WHERE job_traveller_id = ? AND process_id = ?').get(l.jt_id, l.process_id);
        if (l.good > 0 && !hasOutput) {
          createRecord('operator_outputs', { date: localToday(), process_id: l.process_id, job_traveller_id: l.jt_id,
            good_qty: l.good, reject_qty: 0, downtime_min: 0, remark: `Imported from ${filename}` }, user);
        }
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw friendlyDbError(err); }
    audit(user, 'import', 'job_travellers', null);
    return { ...result, committed: true };
  }

  // ---- issue discussion -------------------------------------------------

  async function handleReplies(req, res, method, issueId, user) {
    allow(user, 'read', 'issues');
    getRecord('issues', issueId);
    if (method === 'GET') {
      return send(res, 200, db.prepare('SELECT * FROM issue_replies WHERE issue_id = ? ORDER BY id').all(issueId));
    }
    if (method === 'POST') {
      allow(user, 'update', 'issues');
      const b = await readJson(req);
      const message = String(b.message || '').trim();
      if (!message) throw new HttpError(400, 'Write a message first');
      if (message.length > 5000) throw new HttpError(400, 'Message is too long (5000 characters at most)');
      noCode('Message', message);
      const r = db.prepare('INSERT INTO issue_replies (issue_id, username, process, message) VALUES (?, ?, ?, ?)')
        .run(issueId, user.username, user.process || null, message);
      db.prepare("UPDATE issues SET updated_at = datetime('now') WHERE id = ?").run(issueId);
      audit(user, 'reply', 'issues', issueId);
      return send(res, 201, db.prepare('SELECT * FROM issue_replies WHERE id = ?').get(r.lastInsertRowid));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // ---- users --------------------------------------------------------------

  function publicUser(u) {
    return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, process: u.process || null, theme: u.theme || 'standard', full_edit: !!u.full_edit, extra_processes: String(u.extra_processes || '').split(',').filter(Boolean), active: !!u.active, created_at: u.created_at };
  }

  function checkProcess(p) {
    if (p !== undefined && p !== null && p !== '' && !PROCESSES.includes(p)) {
      throw new HttpError(400, `Process must be one of: ${PROCESSES.join(', ')}`);
    }
    return p || null;
  }

  function checkProcessList(list) {
    const arr = Array.isArray(list) ? list : String(list || '').split(',').map((x) => x.trim()).filter(Boolean);
    arr.forEach(checkProcess);
    return arr.length ? [...new Set(arr)].join(',') : null;
  }

  // Access rights: which process may change which module. Admin only; applies on the next request.
  async function handleRights(req, res, method, user) {
    if (!user) throw new HttpError(401, 'Please sign in');
    const rows = () => db.prepare('SELECT process, resource FROM process_rights ORDER BY resource, process').all();
    if (method === 'GET') return send(res, 200, rows());
    if (user.role !== 'admin') throw new HttpError(403, 'Only Admin can change access rights');
    if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
    const b = await readJson(req);
    const list = Array.isArray(b.rights) ? b.rights : [];
    for (const r of list) {
      checkProcess(r.process);
      if (!resources[r.resource]) throw new HttpError(400, `Unknown module ${r.resource}`);
    }
    const before = rows();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM process_rights');
      const ins = db.prepare('INSERT OR IGNORE INTO process_rights (process, resource) VALUES (?, ?)');
      for (const r of list) ins.run(r.process, r.resource);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    loadRights();
    audit(user, 'update', 'access_rights', null, before, rows());
    return send(res, 200, rows());
  }

  async function handleUsers(req, res, method, id, user) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (user.role !== 'admin') throw new HttpError(403, 'Only Admin can manage users');
    if (method === 'GET' && !id) {
      return send(res, 200, db.prepare('SELECT * FROM users ORDER BY username').all().map(publicUser));
    }
    if (method === 'POST' && !id) {
      const b = await readJson(req);
      const username = String(b.username || '').trim();
      if (!/^[\w.-]{3,40}$/.test(username)) throw new HttpError(400, 'Username: 3-40 letters, numbers, . _ -');
      if (!ROLES.includes(b.role)) throw new HttpError(400, 'Role must be admin, planner or viewer');
      if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      const proc = checkProcess(b.process);
      noCode('Full name', b.full_name || '');
      try {
        const r = db.prepare('INSERT INTO users (username, full_name, role, process, full_edit, extra_processes, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(username, String(b.full_name || ''), b.role, proc, b.full_edit ? 1 : 0, checkProcessList(b.extra_processes), auth.hashPassword(b.password));
        const created = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid));
        audit(user, 'create', 'users', created.id, null, created);
        return send(res, 201, created);
      } catch (err) { throw friendlyDbError(err); }
    }
    const target = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'Not found');
    if (method === 'PUT') {
      const b = await readJson(req);
      if (b.role !== undefined && !ROLES.includes(b.role)) throw new HttpError(400, 'Invalid role');
      if (target.id === user.id && ((b.role && b.role !== 'admin') || b.active === false)) {
        throw new HttpError(400, 'You cannot remove your own Admin access');
      }
      if (b.password !== undefined && String(b.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      noCode('Full name', b.full_name || '');
      db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
        .run(b.full_name ?? null, b.role ?? null, b.active === undefined ? null : (b.active ? 1 : 0), id);
      if (b.process !== undefined) db.prepare('UPDATE users SET process = ? WHERE id = ?').run(checkProcess(b.process), id);
      if (b.full_edit !== undefined) db.prepare('UPDATE users SET full_edit = ? WHERE id = ?').run(b.full_edit ? 1 : 0, id);
      if (b.extra_processes !== undefined) db.prepare('UPDATE users SET extra_processes = ? WHERE id = ?').run(checkProcessList(b.extra_processes), id);
      if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), id);
      if (b.active === false || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      const after = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
      audit(user, 'update', 'users', id, publicUser(target), after);
      return send(res, 200, after);
    }
    if (method === 'DELETE') {
      if (target.id === user.id) throw new HttpError(400, 'You cannot delete your own account');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      audit(user, 'delete', 'users', id, publicUser(target), null);
      return send(res, 204, '');
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // ---- static files -------------------------------------------------------

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---- router -------------------------------------------------------------

  const failedLogins = new Map(); // username -> times of recent wrong passwords

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);

    // Refuse cross-site writes; the session cookie is also SameSite=Strict.
    if (method !== 'GET' && req.headers.origin) {
      const host = req.headers.host;
      let originHost = '';
      try { originHost = new URL(req.headers.origin).host; } catch { /* invalid origin */ }
      // publicHosts: the website's own public address, e.g. behind a Cloudflare Tunnel.
      if (originHost !== host && !publicHosts.includes(originHost)) throw new HttpError(403, 'Cross-site request refused');
    }

    const cookies = auth.parseCookies(req.headers.cookie);
    const user = auth.userForToken(db, cookies.smm_session);
    const parts = pathname.split('/').filter(Boolean).slice(1); // after "api"

    if (parts[0] === 'login' && method === 'POST') {
      const b = await readJson(req);
      const name = String(b.username || '').trim().toLowerCase();
      const fails = (failedLogins.get(name) || []).filter((t) => Date.now() - t < 15 * 60000);
      if (fails.length >= 5) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes');
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || '').trim());
      if (!row || !row.active || !auth.verifyPassword(String(b.password || ''), row.password_hash)) {
        failedLogins.set(name, [...fails, Date.now()]);
        throw new HttpError(401, 'Wrong username or password');
      }
      failedLogins.delete(name);
      const s = auth.createSession(db, row.id);
      audit(row, 'login', 'users', row.id);
      const cookie = `smm_session=${s.token}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(s.expires).toUTCString()}${secureCookies ? '; Secure' : ''}`;
      return send(res, 200, { user: publicUser(row), rights: rightsFor(row) }, { 'Set-Cookie': cookie });
    }
    if (parts[0] === 'logout' && method === 'POST') {
      if (cookies.smm_session) auth.destroySession(db, cookies.smm_session);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'smm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (!user) throw new HttpError(401, 'Please sign in');

    if (parts[0] === 'me' && parts.length === 1 && method === 'GET') {
      return send(res, 200, { user, rights: rightsFor(user), version: VERSION });
    }
    if (parts[0] === 'me' && parts[1] === 'theme' && method === 'POST') {
      if (!user) throw new HttpError(401, 'Please sign in');
      const { theme } = await readJson(req);
      if (!THEMES.includes(theme)) throw new HttpError(400, `Theme must be one of: ${THEMES.join(', ')}`);
      db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, user.id);
      return send(res, 200, { theme });
    }
    if (parts[0] === 'me' && parts[1] === 'password' && method === 'POST') {
      const b = await readJson(req);
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!auth.verifyPassword(String(b.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong');
      if (String(b.next || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.next), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, cookies.smm_session);
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'meta' && method === 'GET') {
      const meta = {};
      for (const [name, r] of Object.entries(resources)) {
        meta[name] = { ...r, fields: r.fields.filter((f) => !f.hidden) };
      }
      return send(res, 200, { resources: meta, formats: FORMATS, roles: ROLES, processes: PROCESSES, company });
    }
    if (parts[0] === 'dashboard' && method === 'GET') return send(res, 200, buildDashboard(db));
    if (parts[0] === 'rights') return handleRights(req, res, method, user);
    if (parts[0] === 'users') return handleUsers(req, res, method, parts[1] ? Number(parts[1]) : null, user);
    if (parts[0] === 'audit' && method === 'GET') {
      if (user.role !== 'admin') throw new HttpError(403, 'Only Admin can view the audit log');
      return send(res, 200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all());
    }
    if (parts[0] === 'drawings' && parts[1] === 'upload' && method === 'POST') {
      return send(res, 201, await uploadDrawing(req, url, user));
    }
    if (parts[0] === 'drawings' && parts[2] === 'file' && method === 'GET') {
      return sendDrawing(res, Number(parts[1]), user, url.searchParams.get('download') === '1');
    }
    if (parts[0] === 'job_travellers' && parts[1] === 'import' && method === 'POST') {
      return send(res, 200, await importJobTravellers(req, url, user));
    }
    if (parts[0] === 'job_travellers' && parts[2] === 'info' && method === 'GET') {
      allow(user, 'read', 'job_travellers');
      return send(res, 200, jtInfo(Number(parts[1])));
    }
    if (parts[0] === 'job_travellers' && parts[2] === 'approve' && method === 'POST') {
      if (!user) throw new HttpError(401, 'Please sign in');
      if (!canApprove(user)) throw new HttpError(403, 'Only a Manager or Admin can approve a Job Traveller');
      const id = Number(parts[1]);
      getRecord('job_travellers', id);
      db.prepare("UPDATE job_travellers SET approved_by = ?, approved_on = ?, updated_at = datetime('now') WHERE id = ?").run(user.username, localToday(), id);
      audit(user, 'approve', 'job_travellers', id);
      return send(res, 200, getRecord('job_travellers', id));
    }
    if (parts[0] === 'layout') return handleLayout(req, res, method, parts, user);
    if (parts[0] === 'projects' && parts[1] === 'tree' && method === 'POST') {
      return send(res, 201, createProjectTree(await readJson(req), user));
    }
    if (parts[0] === 'job_travellers' && parts[2] === 'progress' && method === 'GET') {
      allow(user, 'read', 'job_travellers');
      return send(res, 200, jtProgress(Number(parts[1])));
    }
    if (parts[0] === 'issues' && parts[2] === 'replies' && parts.length === 3) {
      const issueId = Number(parts[1]);
      if (!Number.isInteger(issueId)) throw new HttpError(404, 'Not found');
      return handleReplies(req, res, method, issueId, user);
    }
    if (parts[0] === 'parts' && parts[2] === 'workflow' && method === 'POST') {
      return send(res, 201, generateWorkflow(Number(parts[1]), user));
    }

    const name = parts[0];
    if (!Object.prototype.hasOwnProperty.call(resources, name)) throw new HttpError(404, 'Unknown module');

    if (parts[1] === 'template.xlsx' && method === 'GET') {
      allow(user, 'create', name);
      const sample = db.prepare(`${selectSql(name)} ORDER BY t.id DESC LIMIT 1`).get();
      return send(res, 200, templates.templateXlsx(db, name, { company, sample }), xlsxHeaders(`${name}-template.xlsx`));
    }
    if (parts[1] === 'import-template' && method === 'POST') {
      return send(res, 200, await importTemplate(req, url, name, user));
    }
    if (parts[1] === 'export.xlsx' && method === 'GET') {
      allow(user, 'export', name);
      const file = `${name}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return send(res, 200, templates.exportXlsx(name, listRecords(name, url.searchParams), { company }), xlsxHeaders(file));
    }
    if (parts[1] === 'export.csv' && method === 'GET') {
      allow(user, 'export', name);
      const csv = toCsv(name, listRecords(name, url.searchParams));
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
    }

    const id = parts[1] ? Number(parts[1]) : null;
    if (parts[1] && !Number.isInteger(id)) throw new HttpError(404, 'Not found');

    if (method === 'GET' && !id) { allow(user, 'read', name); return send(res, 200, listRecords(name, url.searchParams)); }
    if (method === 'GET') { allow(user, 'read', name); return send(res, 200, getRecord(name, id)); }
    if (method === 'POST' && !id) {
      allow(user, 'create', name);
      return send(res, 201, createRecord(name, clean(name, userDefaults(name, await readJson(req), user), { partial: false }), user));
    }
    if (method === 'PUT' && id) {
      allow(user, 'update', name);
      return send(res, 200, updateRecord(name, id, clean(name, await readJson(req), { partial: true }), user));
    }
    if (method === 'DELETE' && id) {
      allow(user, 'delete', name);
      deleteRecord(name, id, user);
      return send(res, 204, '');
    }
    throw new HttpError(405, 'Method not allowed');
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const status = err.status || 500;
      if (status === 500) console.error(err);
      send(res, status, { error: status === 500 ? 'Server error' : err.message });
    }
  };
}

module.exports = { createApp, VERSION };
