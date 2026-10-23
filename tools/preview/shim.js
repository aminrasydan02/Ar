'use strict';
// Stand-in for the server in the read-only preview: answers GET /api/... from the captured
// data (window.__SNAP), filters lists like the server does, and refuses every change.
(function () {
  const snap = window.__SNAP;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const READ_ONLY = 'Preview only: this copy is read-only, so changes are not saved.';

  function answer(url) {
    const u = new URL(url, location.href);
    const key = u.pathname + u.search;
    if (key in snap) return snap[key];
    if (u.pathname in snap && !u.search) return snap[u.pathname];
    const [, name, id, sub] = u.pathname.split('/').slice(1);
    const list = snap[`/api/${name}`];
    if (!Array.isArray(list)) return undefined;
    if (id && !sub) return list.find((r) => String(r.id) === id);
    if (id) return undefined;
    let rows = list;
    for (const [k, v] of u.searchParams) {
      if (k === 'q') {
        const q = v.trim().toLowerCase();
        rows = rows.filter((r) => Object.entries(r).some(([f, x]) => !f.endsWith('_id') && typeof x === 'string' && x.toLowerCase().includes(q)));
      } else rows = rows.filter((r) => String(r[k] ?? '') === v);
    }
    return rows;
  }

  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET') return json(403, { error: READ_ONLY });
    const data = answer(url);
    return data === undefined ? json(404, { error: 'Not included in the preview' }) : json(200, data);
  };

  // Downloads (Excel, CSV, drawing files) need the real server.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (!a) return;
    e.preventDefault();
    if (typeof toast === 'function') toast('Downloads work on the real website. This preview is read-only.', true);
  }, true);

  // "Data check": what was merged and settled when the data was loaded.
  function showCheck() {
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    const box = document.createElement('div');
    box.className = 'modal pv-check';
    const close = document.createElement('button');
    close.className = 'btn';
    close.type = 'button';
    close.textContent = 'Close';
    close.onclick = () => wrap.remove();
    const body = document.createElement('div');
    body.className = 'pv-check-body';
    let ul = null;
    for (const line of String(window.__CHECK || 'No data check in this build.').split('\n')) {
      if (/^#{1,2} /.test(line)) { ul = null; const el = document.createElement(line.startsWith('# ') ? 'h2' : 'h3'); el.textContent = line.replace(/^#+ /, ''); body.append(el); }
      else if (line.startsWith('- ')) { if (!ul) { ul = document.createElement('ul'); body.append(ul); } const li = document.createElement('li'); li.textContent = line.slice(2); ul.append(li); }
      else if (line.trim()) { ul = null; const p = document.createElement('p'); p.className = 'muted'; p.textContent = line; body.append(p); }
    }
    const foot = document.createElement('footer');
    foot.append(close);
    box.append(body, foot);
    wrap.append(box);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.append(wrap);
  }
  document.addEventListener('DOMContentLoaded', () => {});
  window.addEventListener('load', () => { const b = document.getElementById('pv-check'); if (b) b.onclick = showCheck; });
  const b = document.getElementById('pv-check');
  if (b) b.onclick = showCheck;
})();
