'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resources, PROCESSES } = require('./resources');
const { ROLES, can, rightsFor } = require('./perm');
const auth = require('./auth');
const { FORMATS, MIME, parseDrawingName, safeFilename } = require('./drawings');
const { buildDashboard } = require('./dashboard');

const VERSION = require('../../package.json').version;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;
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

function createApp({ db, drawingsDir, secureCookies = false }) {
  fs.mkdirSync(drawingsDir, { recursive: true });

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

  function audit(user, action, resource, id) {
    db.prepare('INSERT INTO audit (username, action, resource, record_id) VALUES (?, ?, ?, ?)')
      .run(user ? user.username : null, action, resource, id ?? null);
  }

  function allow(user, action, resource) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (!can(user.role, action, resource)) throw new HttpError(403, `Your role (${user.role}) cannot ${action} ${resource}`);
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
        if (f.type === 'number' || f.type === 'ref') {
          const n = Number(v);
          if (!Number.isFinite(n)) { errors.push(`${f.label} must be a number`); continue; }
          v = f.type === 'ref' ? Math.trunc(n) : n;
        } else {
          v = String(v).trim();
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
    if (name === 'issues') {
      if (blank('opened')) out.opened = localToday();
      if (blank('from_process') && user.process) out.from_process = user.process;
    }
    return out;
  }

  function createRecord(name, data, user) {
    if (name === 'ncrs') data.ncr_no = nextNumber('ncrs', 'ncr_no', 'NCR', data.date);
    if (name === 'issues') {
      data.issue_no = nextNumber('issues', 'issue_no', 'ISS', data.opened);
      data.raised_by = user.username;
      if (['Resolved', 'Closed'].includes(data.status) && !data.resolved) data.resolved = localToday();
    }
    if (name === 'daily_logs') data.logged_by = user.username;
    const cols = Object.keys(data);
    try {
      const r = db.prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => data[c]));
      const id = Number(r.lastInsertRowid);
      audit(user, 'create', name, id);
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
    const cols = Object.keys(data);
    if (cols.length) {
      try {
        db.prepare(`UPDATE ${name} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
          .run(...cols.map((c) => data[c]), id);
      } catch (err) { throw friendlyDbError(err); }
    }
    audit(user, 'update', name, id);
    return getRecord(name, id);
  }

  function deleteRecord(name, id, user) {
    const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Not found');
    db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
    if (name === 'drawings' && row.stored_name) fs.rmSync(path.join(drawingsDir, row.stored_name), { force: true });
    audit(user, 'delete', name, id);
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
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw new HttpError(400, 'File is empty');
    const dup = db.prepare('SELECT id FROM drawings WHERE part_no = ? AND rev = ? AND format = ?').get(partNo, rev, parsed.format);
    if (dup) throw new HttpError(409, `Drawing ${partNo} rev ${rev || '-'} (${parsed.format}) already exists`);
    const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${parsed.format}`;
    fs.writeFileSync(path.join(drawingsDir, storedName), body);
    db.exec('BEGIN');
    try {
      // A new revision of the same part and format supersedes the older ones.
      db.prepare("UPDATE drawings SET status = 'Superseded', updated_at = datetime('now') WHERE part_no = ? AND format = ? AND status = 'Current'")
        .run(partNo, parsed.format);
      const r = db.prepare(`INSERT INTO drawings (part_no, rev, format, status, filename, size, stored_name, uploaded_by)
        VALUES (?, ?, ?, 'Current', ?, ?, ?, ?)`).run(partNo, rev, parsed.format, filename, body.length, storedName, user.username);
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
    if (!can(user.role, 'update', 'parts')) throw new HttpError(403, 'Not allowed');
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
    return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, process: u.process || null, active: !!u.active, created_at: u.created_at };
  }

  function checkProcess(p) {
    if (p !== undefined && p !== null && p !== '' && !PROCESSES.includes(p)) {
      throw new HttpError(400, `Process must be one of: ${PROCESSES.join(', ')}`);
    }
    return p || null;
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
      try {
        const r = db.prepare('INSERT INTO users (username, full_name, role, process, password_hash) VALUES (?, ?, ?, ?, ?)')
          .run(username, String(b.full_name || ''), b.role, proc, auth.hashPassword(b.password));
        audit(user, 'create', 'users', Number(r.lastInsertRowid));
        return send(res, 201, publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
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
      db.prepare('UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?')
        .run(b.full_name ?? null, b.role ?? null, b.active === undefined ? null : (b.active ? 1 : 0), id);
      if (b.process !== undefined) db.prepare('UPDATE users SET process = ? WHERE id = ?').run(checkProcess(b.process), id);
      if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), id);
      if (b.active === false || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      audit(user, 'update', 'users', id);
      return send(res, 200, publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
    }
    if (method === 'DELETE') {
      if (target.id === user.id) throw new HttpError(400, 'You cannot delete your own account');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      audit(user, 'delete', 'users', id);
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
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; frame-src 'self' blob:; object-src 'self'",
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---- router -------------------------------------------------------------

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
      if (originHost !== host) throw new HttpError(403, 'Cross-site request refused');
    }

    const cookies = auth.parseCookies(req.headers.cookie);
    const user = auth.userForToken(db, cookies.smm_session);
    const parts = pathname.split('/').filter(Boolean).slice(1); // after "api"

    if (parts[0] === 'login' && method === 'POST') {
      const b = await readJson(req);
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || '').trim());
      if (!row || !row.active || !auth.verifyPassword(String(b.password || ''), row.password_hash)) {
        throw new HttpError(401, 'Wrong username or password');
      }
      const s = auth.createSession(db, row.id);
      audit(row, 'login', 'users', row.id);
      const cookie = `smm_session=${s.token}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(s.expires).toUTCString()}${secureCookies ? '; Secure' : ''}`;
      return send(res, 200, { user: publicUser(row), rights: rightsFor(row.role) }, { 'Set-Cookie': cookie });
    }
    if (parts[0] === 'logout' && method === 'POST') {
      if (cookies.smm_session) auth.destroySession(db, cookies.smm_session);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'smm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (!user) throw new HttpError(401, 'Please sign in');

    if (parts[0] === 'me' && parts.length === 1 && method === 'GET') {
      return send(res, 200, { user, rights: rightsFor(user.role), version: VERSION });
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
      return send(res, 200, { resources: meta, formats: FORMATS, roles: ROLES, processes: PROCESSES });
    }
    if (parts[0] === 'dashboard' && method === 'GET') return send(res, 200, buildDashboard(db));
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
