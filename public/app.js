'use strict';
// Sheet Metal Manager web client. Plain JavaScript, no build step.
// Forms and lists are built from the module definitions served at /api/meta.

const state = { user: null, rights: null, meta: null, version: '' };

// ---------- helpers ----------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw) { opts.body = raw; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  if (res.status === 401 && !url.endsWith('/login')) { state.user = null; renderLogin(); throw new Error('Please sign in'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(text, isError) {
  const t = h('div', { class: `toast${isError ? ' err' : ''}` }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3000);
}

const STATUS_CLASS = {
  'Completed': 'ok', 'Done': 'ok', 'Closed': 'ok', 'Running': 'ok', 'Current': 'ok', 'Good': 'ok',
  'In progress': 'warn', 'Open': 'warn', 'Maintenance': 'warn', 'Worn': 'warn', 'On hold': 'warn', 'Idle': 'info', 'Planned': 'info',
  'Down': 'bad', 'Damaged': 'bad', 'Cancelled': 'bad', 'Superseded': '', 'Scrapped': 'bad', 'Breakdown': 'bad',
  'Blocked': 'bad', 'Resolved': 'ok', 'Urgent': 'bad', 'High': 'warn', 'Pending': '', '3D model': 'info', 'OK': 'ok', 'Low': 'warn', 'Out': 'bad', 'Drawing': '', 'Image': '',
};
const pill = (v) => h('span', { class: `pill ${STATUS_CLASS[v] ?? ''}` }, v);
// Numbers with thousands separators and at most 2 decimals; dates as DD/MM/YYYY.
const fmtNum = (n, d = 2) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-MY', { maximumFractionDigits: d }));
const fmtDate = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s || '') ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}${s.length > 10 ? s.slice(10, 16) : ''}` : s || '');
const fmtPct = (n) => `${fmtNum(n, 1)}%`;

function cellValue(field, row) {
  const v = field.type === 'ref' ? row[`${field.name}__label`] : row[field.name];
  if (v === null || v === undefined || v === '') return '';
  if (['status', 'condition', 'kind', 'priority'].includes(field.name)) return pill(v);
  if (field.type === 'number') return fmtNum(v);
  if (field.type === 'date') return fmtDate(v);
  return String(v);
}

function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// A new daily log or issue starts with today's date and the user's own process.
function userPreset(resName) {
  const p = state.user.process || '';
  if (resName === 'daily_logs') return { date: localToday(), process: p };
  if (resName === 'issues') return { opened: localToday(), from_process: p };
  if (resName === 'operator_outputs') return { date: localToday() };
  if (resName === 'inventory_moves') return { date: localToday(), process: p || null };
  return {};
}

const right = (res, action) => !!(state.rights && state.rights[res] && state.rights[res][action]);
const content = () => document.getElementById('content');

// ---------- forms ------------------------------------------------------------

const refCache = {};
async function refOptions(resName) {
  if (!refCache[resName]) refCache[resName] = api('GET', `/api/${resName}`);
  const rows = await refCache[resName];
  const display = state.meta.resources[resName].display;
  return rows.map((r) => ({ id: r.id, label: r[display] })).sort((a, b) => String(a.label).localeCompare(String(b.label)));
}
function clearRefCache(resName) { delete refCache[resName]; }

async function buildInput(field, value, editable) {
  if (!editable || field.readonly) {
    return h('div', { class: 'ro' }, value === null || value === undefined ? '—' : String(value));
  }
  const attrs = { name: field.name, id: `f_${field.name}`, required: field.required };
  if (field.type === 'textarea') return h('textarea', attrs, value ?? '');
  if (field.type === 'select') {
    return h('select', attrs, h('option', { value: '' }, ''),
      field.options.map((o) => h('option', { value: o, selected: o === value }, o)));
  }
  if (field.type === 'ref') {
    const opts = await refOptions(field.ref);
    return h('select', attrs, h('option', { value: '' }, ''),
      opts.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));
  }
  return h('input', { ...attrs, type: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text',
    step: field.type === 'number' ? 'any' : null, value: value ?? '' });
}

function openModal(title, body, buttons) {
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.append(h('div', { class: 'modal', role: 'dialog' },
    h('header', {}, title, h('button', { class: 'x', onclick: close, 'aria-label': 'Close' }, '×')),
    h('div', { class: 'body' }, body),
    h('footer', {}, buttons(close))));
  document.body.append(overlay);
  const first = overlay.querySelector('input, select, textarea');
  if (first) first.focus();
  return close;
}

// Opens the add/edit form for one record. `preset` fills fields for a new record.
async function editRecord(resName, row, preset, onSaved) {
  const res = state.meta.resources[resName];
  const isNew = !row;
  const ownedByOther = !isNew && res.ownerField && state.user.role !== 'admin' && row[res.ownerField] !== state.user.username;
  const editable = isNew ? right(resName, 'create') : right(resName, 'update') && !ownedByOther && !res.noUpdate;
  const values = { ...(isNew ? userPreset(resName) : {}), ...(preset || {}), ...(row || {}) };
  if (isNew) for (const f of res.fields) if (values[f.name] === undefined && f.default !== undefined) values[f.name] = f.default;

  const err = h('div');
  const form = h('form', { class: 'form' });
  for (const f of res.fields) {
    if (isNew && f.readonly) continue;
    const shown = f.type === 'ref' && !editable ? row && row[`${f.name}__label`] : values[f.name];
    form.append(h('div', { class: f.type === 'textarea' ? 'full' : '' },
      h('label', { for: `f_${f.name}` }, f.label, f.required && editable ? ' *' : ''),
      await buildInput(f, shown, editable),
      f.help && editable ? h('div', { class: 'help' }, f.help) : null));
  }

  async function save(close) {
    const data = {};
    for (const f of res.fields) {
      const el = form.elements[f.name];
      if (el) data[f.name] = el.value;
    }
    try {
      const saved = isNew ? await api('POST', `/api/${resName}`, data) : await api('PUT', `/api/${resName}/${row.id}`, data);
      clearRefCache(resName);
      close();
      toast(`${res.singular} saved`);
      if (onSaved) onSaved(saved);
    } catch (e) {
      err.replaceChildren(h('div', { class: 'msg err' }, e.message));
    }
  }
  form.addEventListener('submit', (e) => e.preventDefault());

  openModal(isNew ? `New ${res.singular}` : `${res.singular}: ${row[res.display] ?? row.id}`,
    [err, form],
    (close) => [
      !isNew && right(resName, 'delete') ? h('button', { class: 'btn danger left', onclick: async () => {
        if (!window.confirm(`Delete this ${res.singular.toLowerCase()}? This cannot be undone.`)) return;
        try { await api('DELETE', `/api/${resName}/${row.id}`); clearRefCache(resName); close(); toast('Deleted'); if (onSaved) onSaved(null); }
        catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
      } }, 'Delete') : null,
      !isNew && resName === 'ncrs' ? h('a', { class: 'btn left', href: `#/ncr/${row.id}/print` , onclick: close }, 'Print / PDF') : null,
      !isNew && resName === 'issues' ? h('a', { class: 'btn left', href: `#/issue/${row.id}`, onclick: close }, 'Open discussion') : null,
      !isNew && resName === 'daily_logs' && right('issues', 'create') ? h('button', { class: 'btn left', onclick: () => {
        close();
        editRecord('issues', null, { title: row.activity.split('\n')[0].slice(0, 120), project_id: row.project_id, part_no: row.part_no,
          from_process: row.process, to_process: row.handover_to || '', details: row.handover_note || row.activity }, (saved) => { if (saved) location.hash = `#/issue/${saved.id}`; });
      } }, 'Raise issue') : null,
      h('button', { class: 'btn', onclick: close }, editable ? 'Cancel' : 'Close'),
      editable ? h('button', { class: 'btn primary', onclick: () => save(close) }, 'Save') : null,
    ]);
}

// ---------- generic list -----------------------------------------------------

// A searchable table for one module. `filter` limits rows (e.g. { project_id: 3 }),
// `extra` adds buttons to the toolbar, `rowActions` adds buttons to each row.
function recordTable(resName, { filter = {}, extra = [], rowActions, columns, onRow } = {}) {
  const res = state.meta.resources[resName];
  const fields = res.fields.filter((f) => f.list !== false && (!columns || columns.includes(f.name)));
  const wrap = h('div');
  const search = h('input', { type: 'search', placeholder: `Search ${res.label.toLowerCase()}…` });
  const tableBox = h('div', { class: 'table-wrap' });
  const count = h('span', { class: 'muted' });

  async function load() {
    const qs = new URLSearchParams({ ...filter, ...(search.value ? { q: search.value } : {}) });
    try {
      const rows = await api('GET', `/api/${resName}?${qs}`);
      count.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
      if (!rows.length) { tableBox.replaceChildren(h('div', { class: 'empty' }, 'No records yet.')); return; }
      tableBox.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, fields.map((f) => h('th', {}, f.label)), rowActions ? h('th', {}, '') : null)),
        h('tbody', {}, rows.map((r) => h('tr', { class: 'click', onclick: () => (onRow ? onRow(r, load) : editRecord(resName, r, null, load)) },
          fields.map((f) => h('td', { class: f.type === 'number' ? 'num' : '' }, cellValue(f, r))),
          rowActions ? h('td', { onclick: (e) => e.stopPropagation() }, rowActions(r, load)) : null)))));
    } catch (e) { tableBox.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
  }
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

  wrap.append(h('div', { class: 'toolbar' },
    search, count, h('span', { class: 'grow' }),
    extra,
    right(resName, 'create') && !res.noCreate ? [
      h('a', { class: 'btn', href: `/api/${resName}/template.xlsx`, title: 'Excel template with a guide sheet' }, 'Template'),
      h('button', { class: 'btn', onclick: () => templateImportDialog(resName, load) }, 'Import template')] : null,
    right(resName, 'export') ? h('a', { class: 'btn', href: `/api/${resName}/export.xlsx?${new URLSearchParams(filter)}` }, 'Export Excel') : null,
    right(resName, 'export') ? h('a', { class: 'btn', href: `/api/${resName}/export.csv?${new URLSearchParams(filter)}` }, 'CSV') : null,
    right(resName, 'create') ? h('button', { class: 'btn primary', onclick: () => (onRow ? onRow(null, load) : editRecord(resName, null, filter, load)) }, `+ New ${res.singular}`) : null),
    tableBox);
  load();
  wrap.reload = load;
  return wrap;
}

// Upload a filled template: check every row first, then save all rows or none.
function templateImportDialog(resName, onDone) {
  const res = state.meta.resources[resName];
  const err = h('div');
  const result = h('div');
  const input = h('input', { type: 'file', accept: '.xlsx,.csv' });
  let file = null;
  let ready = false;
  const url = (commit) => `/api/${resName}/import-template?${new URLSearchParams({ filename: file.name, ...(commit ? { commit: 1 } : {}) })}`;
  input.addEventListener('change', async () => {
    file = input.files[0];
    ready = false;
    err.replaceChildren(); result.replaceChildren();
    if (!file) return;
    try {
      const r = await api('POST', url(false), undefined, file);
      ready = !r.errors.length;
      result.replaceChildren(
        h('div', { class: `msg ${ready ? 'ok' : 'err'}` }, `${r.ok} of ${r.rows} row(s) ready${ready ? '. Press Import to save.' : '. Fix these rows in Excel and choose the file again:'}`),
        r.errors.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Row'), h('th', {}, 'Problem'))),
          h('tbody', {}, r.errors.map((e) => h('tr', {}, h('td', { class: 'num' }, e.line), h('td', { class: 'wrap' }, e.error)))))) : null);
    } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
  });
  openModal(`Import ${res.label} template`, [err,
    h('p', { class: 'muted' }, 'Download the template, fill one row per record in Excel (see the Guide sheet), then choose the file here. Nothing is saved until every row is correct.'),
    h('p', {}, h('a', { class: 'btn small', href: `/api/${resName}/template.xlsx` }, 'Download template')),
    input, result], (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      if (!file || !ready) return;
      try { const r = await api('POST', url(true), undefined, file); close(); toast(`${r.rows} ${res.label.toLowerCase()} row(s) imported`); onDone(); }
      catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
    } }, 'Import'),
  ]);
}

// ---------- views ------------------------------------------------------------

async function viewDashboard() {
  const d = await api('GET', '/api/dashboard');
  const k = d.kpi;
  const tile = (n, l, alert) => h('div', { class: `kpi${alert && n ? ' alert' : ''}` }, h('div', { class: 'n' }, typeof n === 'number' ? fmtNum(n) : n), h('div', { class: 'l' }, l));
  const pr = d.production;
  return [
    h('h1', {}, 'Dashboard'),
    h('h2', {}, `Production by process (net ${d.minutesPerDay} min/day)`),
    h('div', { class: 'kpis' },
      tile(pr.target, 'Process target (pcs)'), tile(pr.good, 'Actual good (pcs)'), tile(pr.balance, 'Remaining balance (pcs)'),
      tile(fmtPct(pr.completion), 'Overall completion'), tile(fmtPct(pr.yield), 'First-pass yield'),
      tile(fmtNum(pr.remaining_min / 60, 1), 'Remaining workload (hrs)')),
    h('div', { class: 'table-wrap gap-top' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Process', 'Steps', 'Target', 'Good', 'Reject', 'Balance', 'Completion', 'Yield', 'Remaining (min)', 'Days', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.processes.map((p) => {
        const bar = h('div'); bar.style.width = `${Math.min(100, p.completion)}%`;
        return h('tr', {}, h('td', {}, p.name), h('td', { class: 'num' }, p.steps), h('td', { class: 'num' }, fmtNum(p.target)),
          h('td', { class: 'num' }, fmtNum(p.good)), h('td', { class: 'num' }, fmtNum(p.reject)), h('td', { class: 'num' }, fmtNum(p.balance)),
          h('td', {}, h('div', { class: 'bar' }, bar), ` ${fmtPct(p.completion)}`), h('td', { class: 'num' }, fmtPct(p.yield)),
          h('td', { class: 'num' }, fmtNum(p.remaining_min, 1)), h('td', { class: 'num' }, fmtNum(p.remaining_days)),
          h('td', {}, p.bottleneck ? h('span', { class: 'pill bad' }, 'Bottleneck') : ''));
      })))),
    h('h2', {}, 'Overview'),
    h('div', { class: 'kpis' },
      tile(k.active_projects, 'Active projects'), tile(k.parts, 'Parts'), tile(k.total_pcs, 'Total pieces'),
      tile(k.drawings, 'Current drawings'), tile(k.open_ncrs, 'Open NCRs', true), tile(k.open_work_orders, 'Open maintenance', true),
      tile(k.machines_down, 'Machines down', true), tile(k.low_stock, 'Plates at/below minimum', true),
      tile(k.logs_today, 'Activities logged today'), tile(k.open_issues, 'Open issues', true)),
    d.issues.length ? [h('h2', {}, 'Open issues'), issueTable(d.issues)] : null,
    h('h2', {}, 'Projects'),
    d.projects.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Project', 'Name', 'Customer', 'Due', 'Status', 'Parts', 'Progress'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.projects.map((p) => {
        const pct = p.steps ? Math.round((p.steps_done / p.steps) * 100) : 0;
        const bar = h('div');
        bar.style.width = `${pct}%`;
        return h('tr', { class: 'click', onclick: () => { location.hash = `#/project/${p.id}`; } },
          h('td', {}, p.code), h('td', {}, p.name), h('td', {}, p.customer || ''), h('td', {}, fmtDate(p.due_date)),
          h('td', {}, pill(p.status)), h('td', { class: 'num' }, p.parts),
          h('td', {}, h('div', { class: 'bar', title: `${p.steps_done}/${p.steps} steps` }, bar), ` ${pct}%`));
      })))) : h('div', { class: 'panel muted' }, 'No active projects.'),
    h('h2', {}, 'Workflow board'),
    d.workflow.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Part', 'Project', 'Current step', 'Flow'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.workflow.map((w) => h('tr', {},
        h('td', {}, w.part_no), h('td', {}, w.project), h('td', {}, pill(w.current === 'Completed' ? 'Completed' : 'In progress'), ' ', w.current),
        h('td', {}, h('div', { class: 'flow' }, w.steps.map((s) => h('span', { class: s.status === 'Done' ? 'done' : s.step === w.current ? 'doing' : '' }, s.step))))))))) :
      h('div', { class: 'panel muted' }, 'No workflow yet. Open a part and choose "Create workflow" to build it from the routing.'),
    h('div', { class: 'grid2' },
      h('div', {}, h('h2', {}, `Machine load (${d.minutesPerDay} min/day)`),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Machine', 'Type', 'Status', 'Load (min)', 'Days'].map((t) => h('th', {}, t)))),
          h('tbody', {}, d.load.map((m) => h('tr', {}, h('td', {}, m.code), h('td', {}, m.machine_type || ''), h('td', {}, pill(m.status)),
            h('td', { class: 'num' }, fmtNum(m.load_min, 0)), h('td', { class: 'num' }, fmtNum(m.load_days)))))))),
      h('div', {}, h('h2', {}, 'Maintenance, last 30 days'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Machine', 'Breakdowns', 'Downtime (min)', 'Availability', 'MTBF', 'MTTR'].map((t) => h('th', {}, t)))),
          h('tbody', {}, d.downtime.map((m) => h('tr', {}, h('td', {}, m.code), h('td', { class: 'num' }, m.breakdowns),
            h('td', { class: 'num' }, m.downtime_min), h('td', { class: 'num' }, `${m.availability}%`),
            h('td', { class: 'num' }, m.mtbf_min ?? '—'), h('td', { class: 'num' }, m.mttr_min ?? '—')))))))),
    d.lowStock.length ? [h('h2', {}, 'Plates at or below minimum'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Material', 'Thickness', 'Size', 'Qty', 'Minimum'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.lowStock.map((p) => h('tr', {}, h('td', {}, p.material), h('td', {}, p.thickness), h('td', {}, p.sheet_size || ''),
        h('td', { class: 'num' }, p.qty), h('td', { class: 'num' }, p.min_qty))))))] : null,
    d.lowItems.length ? [h('h2', {}, 'Inventory to reorder'), h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Item', 'Name', 'Group', 'Location', 'On hand', 'Minimum', 'Stock'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.lowItems.map((i) => h('tr', {}, h('td', {}, i.code), h('td', {}, i.name), h('td', {}, i.item_group), h('td', {}, i.location || ''),
        h('td', { class: 'num' }, `${fmtNum(i.qty_on_hand)} ${i.unit || ''}`), h('td', { class: 'num' }, fmtNum(i.min_qty)), h('td', {}, pill(i.status)))))))] : null,
  ];
}

function viewList(resName) {
  const res = state.meta.resources[resName];
  if (!res) return [h('h1', {}, 'Not found')];
  const opts = {};
  if (resName === 'parts') opts.rowActions = workflowButton;
  if (resName === 'projects') opts.rowActions = (r) => h('a', { class: 'btn small', href: `#/project/${r.id}` }, 'Open');
  if (resName === 'ncrs') opts.rowActions = (r) => h('a', { class: 'btn small', href: `#/ncr/${r.id}/print` }, 'Print');
  if (resName === 'issues') opts.rowActions = (r) => h('a', { class: 'btn small', href: `#/issue/${r.id}` }, 'Discuss');
  if (resName === 'job_travellers') {
    opts.rowActions = (r) => h('a', { class: 'btn small', href: `#/jt/${r.id}` }, 'Open');
    if (right('job_travellers', 'create')) opts.extra = [h('button', { class: 'btn', onclick: () => importDialog(() => route()) }, 'Import NEWAYS report')];
  }
  if (resName === 'operator_outputs') opts.onRow = (r, reload) => outputDialog(r, {}, reload);
  return [h('h1', {}, res.label), recordTable(resName, opts)];
}

function workflowButton(part, reload) {
  if (!right('parts', 'update')) return null;
  return h('button', { class: 'btn small', onclick: async () => {
    try { await api('POST', `/api/parts/${part.id}/workflow`); toast(`Workflow created for ${part.part_no}`); if (reload) reload(); }
    catch (e) { toast(e.message, true); }
  } }, 'Create workflow');
}

function drawingActions(r) {
  return [
    h('a', { class: 'btn small', href: `/api/drawings/${r.id}/file`, target: '_blank', rel: 'noopener' }, 'Open'), ' ',
    h('a', { class: 'btn small', href: `/api/drawings/${r.id}/file?download=1` }, 'Download'),
  ];
}

function uploadBox(onDone, preset) {
  const input = h('input', { type: 'file', multiple: true, accept: state.meta.formats.map((f) => `.${f}`).join(','), hidden: true });
  const box = h('div', { class: 'drop' },
    h('div', {}, 'Drop drawing files here or ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); input.click(); } }, 'choose files')),
    h('div', { class: 'muted' }, `Formats: ${state.meta.formats.join(', ')}. The part number and revision are read from the file name, e.g. "606118901_PART_1 Rev C.pdf". Older revisions become Superseded.`),
    input);
  async function send(files) {
    let ok = 0;
    for (const file of files) {
      const qs = new URLSearchParams({ filename: file.name, ...(preset || {}) });
      try { await api('POST', `/api/drawings/upload?${qs}`, undefined, file); ok++; }
      catch (e) { toast(`${file.name}: ${e.message}`, true); }
    }
    if (ok) toast(`${ok} drawing${ok === 1 ? '' : 's'} uploaded`);
    onDone();
  }
  input.addEventListener('change', () => { send([...input.files]); input.value = ''; });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); send([...e.dataTransfer.files]); });
  return box;
}

function viewDrawings() {
  const table = recordTable('drawings', { rowActions: drawingActions });
  return [h('h1', {}, 'Drawings'), right('drawings', 'upload') ? uploadBox(() => table.reload()) : null, table];
}

async function viewProject(id) {
  const p = await api('GET', `/api/projects/${id}`);
  const box = h('div');
  const tabs = [
    ['Parts', () => partsTree(p.id)],
    ['Routing', () => routingView(p.id)],
    ['Laser nesting', () => recordTable('nestings', { filter: { project_id: p.id } })],
    ['Drawings', () => projectDrawings(p.id)],
    ['NCR', () => recordTable('ncrs', { filter: { project_id: p.id }, rowActions: (r) => h('a', { class: 'btn small', href: `#/ncr/${r.id}/print` }, 'Print') })],
  ];
  const bar = h('div', { class: 'tabs' });
  function show(i) {
    [...bar.children].forEach((b, j) => b.classList.toggle('on', i === j));
    Promise.resolve(tabs[i][1]()).then((v) => box.replaceChildren(v));
  }
  tabs.forEach(([label], i) => bar.append(h('button', { onclick: () => show(i) }, label)));
  show(0);
  return [
    h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, `${p.code} — ${p.name}`),
      h('button', { class: 'btn', onclick: () => editRecord('projects', p, null, () => route()) }, right('projects', 'update') ? 'Edit project' : 'Details')),
    h('div', { class: 'panel' }, h('div', { class: 'kpis' },
      [['Customer', p.customer], ['Work order', p.work_order], ['Start', p.start_date], ['Due', p.due_date]].map(([l, v]) =>
        h('div', {}, h('div', { class: 'muted' }, l), h('div', {}, v || '—'))),
      h('div', {}, h('div', { class: 'muted' }, 'Status'), pill(p.status)))),
    p.notes ? h('p', { class: 'muted' }, p.notes) : null,
    h('h2', {}, 'Planning'), bar, box,
  ];
}

// Parts with child parts listed under their parent.
async function partsTree(projectId) {
  const wrap = h('div');
  async function load() {
    const rows = await api('GET', `/api/parts?project_id=${projectId}`);
    const byParent = new Map();
    for (const r of rows) {
      const key = r.parent_no && rows.some((x) => x.part_no === r.parent_no) ? r.parent_no : '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(r);
    }
    const ordered = [];
    const walk = (key, depth) => (byParent.get(key) || []).sort((a, b) => a.part_no.localeCompare(b.part_no))
      .forEach((r) => { ordered.push([r, depth]); walk(r.part_no, depth + 1); });
    walk('', 0);
    const total = rows.reduce((s, r) => s + (r.qty_per_set || 1) * (r.sets || 1), 0);
    wrap.replaceChildren(
      h('div', { class: 'toolbar' }, h('span', { class: 'muted grow' }, `${rows.length} parts, ${total.toLocaleString()} pieces`),
        right('parts', 'create') ? h('button', { class: 'btn primary', onclick: () => editRecord('parts', null, { project_id: projectId }, load) }, '+ New part') : null),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Part number', 'Description', 'Material', 'Thk', 'Qty/set', 'Sets', 'Pieces', 'Job sheet', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, ordered.map(([r, depth]) => h('tr', { class: `click${depth ? ' tree-child' : ''}`, onclick: () => editRecord('parts', r, null, load) },
          h('td', {}, depth ? '↳ ' : '', r.part_no), h('td', {}, r.description || ''), h('td', {}, r.material || ''),
          h('td', { class: 'num' }, r.thickness ?? ''), h('td', { class: 'num' }, r.qty_per_set ?? ''), h('td', { class: 'num' }, r.sets ?? ''),
          h('td', { class: 'num' }, ((r.qty_per_set || 1) * (r.sets || 1)).toLocaleString()), h('td', {}, r.job_sheet || ''),
          h('td', { onclick: (e) => e.stopPropagation() }, workflowButton(r, null))))))) : h('div', { class: 'panel muted' }, 'No parts yet.'));
  }
  await load();
  return wrap;
}

async function routingView(projectId) {
  const parts = await api('GET', `/api/parts?project_id=${projectId}`);
  if (!parts.length) return h('div', { class: 'panel muted' }, 'Add parts first.');
  const select = h('select', {}, parts.sort((a, b) => a.part_no.localeCompare(b.part_no)).map((p) => h('option', { value: p.id }, p.part_no)));
  const holder = h('div');
  const show = () => holder.replaceChildren(recordTable('routings', { filter: { part_id: Number(select.value) } }));
  select.addEventListener('change', show);
  show();
  return h('div', {}, h('div', { class: 'toolbar' }, h('label', {}, 'Part: '), select), holder);
}

async function projectDrawings(projectId) {
  const parts = await api('GET', `/api/parts?project_id=${projectId}`);
  const wrap = h('div');
  async function load() {
    const all = await api('GET', '/api/drawings');
    const nos = new Set(parts.map((p) => p.part_no));
    const rows = all.filter((d) => nos.has(d.part_no));
    wrap.replaceChildren(
      right('drawings', 'upload') ? uploadBox(load) : null,
      rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Part number', 'Rev', 'Format', 'Status', 'File', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((d) => h('tr', {}, h('td', {}, d.part_no), h('td', {}, d.rev || ''), h('td', {}, d.format),
          h('td', {}, pill(d.status)), h('td', {}, d.filename), h('td', {}, drawingActions(d))))))) :
        h('div', { class: 'panel muted' }, 'No drawings for these parts yet.'));
  }
  await load();
  return wrap;
}

async function viewNcrPrint(id) {
  const n = await api('GET', `/api/ncrs/${id}`);
  const sec = (label, value) => h('tr', {}, h('th', {}, label), h('td', { class: 'sec' }, value || ''));
  return [
    h('div', { class: 'print-actions' },
      h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print / Save as PDF'),
      h('a', { class: 'btn', href: '#/r/ncrs' }, 'Back to NCR list')),
    h('div', { class: 'print-page' },
      h('div', { class: 'doc-head' }, h('div', {}, h('div', { class: 'company' }, state.meta.company), h('h1', {}, 'NONCONFORMANCE REPORT')),
        h('div', { class: 'doc-no' }, n.ncr_no)),
      h('table', {},
        h('tr', {}, h('th', {}, 'NCR no.'), h('td', {}, n.ncr_no), h('th', {}, 'Date'), h('td', {}, fmtDate(n.date))),
        h('tr', {}, h('th', {}, 'Project'), h('td', {}, n.project_id__label || ''), h('th', {}, 'Part number'), h('td', {}, n.part_no || '')),
        h('tr', {}, h('th', {}, 'Qty affected'), h('td', {}, n.qty_affected ?? ''), h('th', {}, 'Status'), h('td', {}, n.status))),
      h('br'),
      h('table', {},
        sec('1. Nonconformance', n.defect), sec('2. Containment', n.containment), sec('3. Root cause', n.root_cause),
        sec('4. Corrective action', n.corrective), sec('5. Disposition', n.disposition), sec('6. Verification', n.verification)),
      h('br'),
      h('table', { class: 'sign' },
        h('tr', {}, ['Raised by', 'Reviewed by (QA)', 'Approved by'].map((t) => h('th', {}, t))),
        h('tr', {}, h('td', {}, n.raised_by || ''), h('td', {}), h('td', {})))),
  ];
}

// ---------- daily work -------------------------------------------------------

function issueTable(rows) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Issue', 'Problem', 'From → To', 'Priority', 'Status', 'Opened', 'Due'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((i) => h('tr', { class: 'click', onclick: () => { location.hash = `#/issue/${i.id}`; } },
      h('td', {}, i.issue_no), h('td', { class: 'wrap' }, i.title), h('td', {}, `${i.from_process} → ${i.to_process}`),
      h('td', {}, pill(i.priority)), h('td', {}, pill(i.status)), h('td', {}, fmtDate(i.opened)), h('td', {}, fmtDate(i.due_date)))))));
}

// One column per process, in the order work passes from design to the shop floor.
async function viewDaily(dateArg) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') ? dateArg : localToday();
  const [logs, issues] = await Promise.all([
    api('GET', `/api/daily_logs?date=${date}`),
    api('GET', '/api/issues'),
  ]);
  const open = issues.filter((i) => i.status === 'Open' || i.status === 'In progress');
  const reload = () => route();
  const shift = (days) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    location.hash = `#/daily/${d.toISOString().slice(0, 10)}`;
  };
  const picker = h('input', { type: 'date', value: date });
  picker.addEventListener('change', () => { if (picker.value) location.hash = `#/daily/${picker.value}`; });

  const columns = state.meta.processes.map((proc) => {
    const mine = logs.filter((l) => l.process === proc);
    const waiting = open.filter((i) => i.to_process === proc);
    const incoming = logs.filter((l) => l.handover_to === proc && l.process !== proc);
    return h('section', { class: `lane${state.user.process === proc ? ' me' : ''}` },
      h('header', {}, h('strong', {}, proc), h('span', { class: 'muted' }, `${mine.length} logged`)),
      waiting.length ? h('a', { class: 'lane-alert', href: '#/r/issues' }, `${waiting.length} open issue${waiting.length === 1 ? '' : 's'} waiting`) : null,
      incoming.map((l) => h('div', { class: 'card handover', onclick: () => editRecord('daily_logs', l, null, reload) },
        h('div', { class: 'muted small' }, `From ${l.process} · ${l.logged_by || ''}`),
        h('div', {}, l.handover_note || l.activity))),
      mine.map((l) => h('div', { class: 'card', onclick: () => editRecord('daily_logs', l, null, reload) },
        h('div', { class: 'card-top' }, pill(l.status), l.hours ? h('span', { class: 'muted small' }, `${l.hours} h`) : null),
        h('div', { class: 'act' }, l.activity),
        h('div', { class: 'muted small' }, [l.project_id__label, l.part_no].filter(Boolean).join(' · ')),
        h('div', { class: 'muted small' }, l.logged_by || '', l.handover_to ? ` → ${l.handover_to}` : ''))),
      !mine.length && !incoming.length ? h('div', { class: 'muted small empty-lane' }, 'Nothing logged') : null);
  });

  return [
    h('div', { class: 'toolbar' },
      h('h1', { class: 'grow' }, 'Daily board'),
      h('button', { class: 'btn', onclick: () => shift(-1) }, '‹ Previous day'), picker,
      h('button', { class: 'btn', onclick: () => shift(1) }, 'Next day ›'),
      date !== localToday() ? h('a', { class: 'btn', href: '#/daily' }, 'Today') : null,
      right('issues', 'create') ? h('button', { class: 'btn', onclick: () => editRecord('issues', null, null, reload) }, '! Raise issue') : null,
      right('daily_logs', 'create') ? h('button', { class: 'btn primary', onclick: () => editRecord('daily_logs', null, { date }, reload) }, '+ Log activity') : null),
    state.user.process ? null : h('div', { class: 'msg warn' }, 'Your account has no process yet. Ask Admin to set it under Users so your entries go to the right column.'),
    h('div', { class: 'lanes' }, columns),
    h('h2', {}, `Open issues (${open.length})`),
    open.length ? issueTable(open) : h('div', { class: 'panel muted' }, 'No open issues.'),
  ];
}

async function viewIssue(id) {
  const [issue, replies] = await Promise.all([api('GET', `/api/issues/${id}`), api('GET', `/api/issues/${id}/replies`)]);
  const reload = () => route();
  const field = (label, value) => value ? h('div', { class: 'full' }, h('div', { class: 'muted small' }, label), h('div', { class: 'pre' }, value)) : null;
  const box = h('textarea', { placeholder: 'Write an update, a question or the solution…' });
  const err = h('div');
  async function postReply() {
    try {
      await api('POST', `/api/issues/${id}/replies`, { message: box.value });
      reload();
    } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
  }
  async function setStatus(status) {
    try { await api('PUT', `/api/issues/${id}`, { status }); toast(`Issue ${status.toLowerCase()}`); reload(); }
    catch (e) { toast(e.message, true); }
  }
  const canEdit = right('issues', 'update');
  return [
    h('div', { class: 'toolbar' },
      h('h1', { class: 'grow' }, `${issue.issue_no} — ${issue.title}`),
      h('a', { class: 'btn', href: '#/daily' }, 'Daily board'),
      h('button', { class: 'btn', onclick: () => editRecord('issues', issue, null, reload) }, canEdit ? 'Edit' : 'Details'),
      canEdit && issue.status === 'Open' ? h('button', { class: 'btn', onclick: () => setStatus('In progress') }, 'Start working') : null,
      canEdit && ['Open', 'In progress'].includes(issue.status) ? h('button', { class: 'btn primary', onclick: () => setStatus('Resolved') }, 'Mark resolved') : null,
      canEdit && issue.status === 'Resolved' ? h('button', { class: 'btn', onclick: () => setStatus('Closed') }, 'Close') : null),
    h('div', { class: 'panel' },
      h('div', { class: 'kpis' },
        [['From', issue.from_process], ['Needs action from', issue.to_process], ['Project', issue.project_id__label], ['Part', issue.part_no],
          ['Opened', fmtDate(issue.opened)], ['Due', fmtDate(issue.due_date)], ['Resolved', fmtDate(issue.resolved)], ['Raised by', issue.raised_by]]
          .map(([l, v]) => h('div', {}, h('div', { class: 'muted' }, l), h('div', {}, v || '—'))),
        h('div', {}, h('div', { class: 'muted' }, 'Priority'), pill(issue.priority)),
        h('div', {}, h('div', { class: 'muted' }, 'Status'), pill(issue.status))),
      h('div', { class: 'form gap-top' },
        field('What happened', issue.details), field('Action plan', issue.action_plan), field('Solution', issue.resolution))),
    h('h2', {}, `Discussion (${replies.length})`),
    h('div', { class: 'thread' },
      replies.length ? replies.map((r) => h('div', { class: `reply${r.username === state.user.username ? ' mine' : ''}` },
        h('div', { class: 'muted small' }, r.username, r.process ? ` · ${r.process}` : '', ` · ${fmtDate(r.at)} UTC`),
        h('div', { class: 'pre' }, r.message))) : h('div', { class: 'panel muted' }, 'No replies yet. Use this to ask questions and share updates between processes.')),
    canEdit ? h('div', { class: 'panel reply-box' }, err, box,
      h('div', { class: 'toolbar reply-actions' }, h('span', { class: 'grow' }),
        h('button', { class: 'btn primary', onclick: postReply }, 'Post reply'))) : null,
  ];
}

// ---------- job traveller and operator output --------------------------------

function importDialog(onDone, projectId) {
  const err = h('div');
  const preview = h('div');
  const input = h('input', { type: 'file', accept: '.xlsx,.csv' });
  let file = null;
  const qs = (commit) => new URLSearchParams({ filename: file.name, ...(projectId ? { project_id: projectId } : {}), ...(commit ? { commit: 1 } : {}) });
  input.addEventListener('change', async () => {
    file = input.files[0];
    err.replaceChildren(); preview.replaceChildren();
    if (!file) return;
    try {
      const r = await api('POST', `/api/job_travellers/import?${qs(false)}`, undefined, file);
      preview.replaceChildren(h('p', { class: 'muted' }, `Sheet "${r.sheet}": ${r.lines.length} line(s).`),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Part number', 'Process', 'Stage', 'Qty', 'Cycle (min)', 'Done', 'Job Traveller'].map((t) => h('th', {}, t)))),
          h('tbody', {}, r.lines.map((l) => h('tr', {}, h('td', {}, l.part_no), h('td', {}, l.process || h('span', { class: 'pill bad' }, 'unknown')),
            h('td', { class: 'num' }, l.seq ?? ''), h('td', { class: 'num' }, l.qty), h('td', { class: 'num' }, l.cycle_min ?? ''),
            h('td', { class: 'num' }, l.good || ''), h('td', {}, l.jt_no ? `${l.jt_no} (update)` : 'New')))))));
    } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
  });
  openModal('Import Job Travellers from Excel', [err,
    h('p', { class: 'muted' }, 'Choose a schedule report (.xlsx) or a .csv with Part Number and quantity columns. The process is read from the report title or from a Machine_Cell / Process column.'),
    input, preview], (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      if (!file) return;
      try { const r = await api('POST', `/api/job_travellers/import?${qs(true)}`, undefined, file); close(); toast(`${r.lines.length} line(s) imported`); onDone(); }
      catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
    } }, 'Import'),
  ]);
}

const infoRow = (pairs) => h('div', { class: 'kpis' }, pairs.map(([l, v]) => h('div', {}, h('div', { class: 'muted' }, l), h('div', {}, v || '—'))));
const jtLink = (p) => (p.jt ? h('a', { href: `#/jt/${p.jt.id}` }, p.jt.jt_no) : h('span', { class: 'muted' }, 'No Job Traveller'));

async function viewJobTraveller(id) {
  const { jt, steps, current, part, parent, children, drawings, issues } = await api('GET', `/api/job_travellers/${id}/info`);
  const reload = () => route();
  const drawingBox = h('div');
  const showDrawings = (rows) => drawingBox.replaceChildren(
    right('drawings', 'upload') ? uploadBox(reload, { job_traveller_id: jt.id, part_no: jt.part_no }) : null,
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Type', 'Part number', 'Rev', 'Format', 'Status', 'File', 'By', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((d) => h('tr', {}, h('td', {}, pill(d.kind || 'Drawing')), h('td', {}, d.part_no), h('td', {}, d.rev || ''),
        h('td', {}, d.format.toUpperCase()), h('td', {}, pill(d.status)), h('td', {}, d.filename), h('td', {}, d.uploaded_by || ''), h('td', {}, drawingActions(d))))))) :
      h('div', { class: 'panel muted' }, 'No drawings or STEP files yet.'));
  showDrawings(drawings);
  return [
    h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, `${jt.jt_no} — ${jt.part_no}`),
      h('a', { class: 'btn', href: `#/operator?jt=${jt.id}` }, 'Record output'),
      h('a', { class: 'btn', href: `#/jt/${jt.id}/print` }, 'Print / PDF'),
      right('job_travellers', 'approve') && !jt.approved_by ? h('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', `/api/job_travellers/${jt.id}/approve`); toast(`${jt.jt_no} approved`); reload(); } catch (e) { toast(e.message, true); }
      } }, 'Approve') : null,
      h('button', { class: 'btn', onclick: () => editRecord('job_travellers', jt, null, reload) }, right('job_travellers', 'update') ? 'Edit' : 'Details')),
    h('div', { class: `now ${current === 'Completed' ? 'done' : ''}` }, h('span', { class: 'muted' }, 'Now at'),
      h('strong', {}, current || 'No routing yet'), pill(jt.status),
      jt.approved_by ? h('span', { class: 'pill ok' }, `Approved by ${jt.approved_by} ${fmtDate(jt.approved_on)}`) : h('span', { class: 'pill' }, 'Not approved yet')),
    h('div', { class: 'panel' }, infoRow([['Project', jt.project_id__label], ['Customer', jt.customer], ['Description', jt.description], ['Drawing', jt.drawing_no],
      ['Material', [jt.material, jt.thickness && `${fmtNum(jt.thickness)} mm`].filter(Boolean).join(' ')], ['Qty (pcs)', fmtNum(jt.qty)], ['Due', fmtDate(jt.due_date)]])),
    h('h2', {}, 'Stage progress'),
    steps.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Seq', 'Process', 'Stage', 'Cycle (min)', 'Target', 'Good', 'Reject', 'Balance', 'Progress'].map((t) => h('th', {}, t)))),
      h('tbody', {}, steps.map((st) => {
        const pct = st.target_qty ? Math.min(100, Math.round((st.good / st.target_qty) * 100)) : 0;
        const bar = h('div'); bar.style.width = `${pct}%`;
        return h('tr', { class: st.process === current ? 'here' : null }, h('td', { class: 'num' }, st.seq ?? ''), h('td', {}, st.process), h('td', {}, pill(st.state)),
          h('td', { class: 'num' }, fmtNum(st.cycle_min)), h('td', { class: 'num' }, fmtNum(st.target_qty)), h('td', { class: 'num' }, fmtNum(st.good)),
          h('td', { class: 'num' }, fmtNum(st.reject)), h('td', { class: 'num' }, st.target_qty != null ? fmtNum(Math.max(0, st.target_qty - st.good)) : ''),
          h('td', {}, h('div', { class: 'bar' }, bar), ` ${pct}%`));
      })))) : h('div', { class: 'panel muted' }, 'No process steps yet.'),
    h('h2', {}, 'Mother and child parts'),
    part ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Level', 'Part number', 'Description', 'Qty / set', 'Job Traveller'].map((t) => h('th', {}, t)))),
      h('tbody', {},
        parent ? h('tr', {}, h('td', {}, 'Mother'), h('td', {}, parent.part_no), h('td', {}, parent.description || ''), h('td', { class: 'num' }, fmtNum(parent.qty_per_set)), h('td', {}, jtLink(parent))) : null,
        h('tr', { class: 'here' }, h('td', {}, 'This part'), h('td', {}, part.part_no), h('td', {}, part.description || ''), h('td', { class: 'num' }, fmtNum(part.qty_per_set)), h('td', {}, jt.jt_no)),
        children.map((c) => h('tr', {}, h('td', {}, '↳ Child'), h('td', {}, c.part_no), h('td', {}, c.description || ''), h('td', { class: 'num' }, fmtNum(c.qty_per_set)), h('td', {}, jtLink(c)))))))
      : h('div', { class: 'panel muted' }, 'This part is not in a project parts list.'),
    h('h2', {}, 'Drawings and STEP files'), drawingBox,
    h('div', { class: 'toolbar gap-top' }, h('h2', { class: 'grow' }, 'Issues'),
      right('issues', 'create') ? h('button', { class: 'btn', onclick: () => editRecord('issues', null, { job_traveller_id: jt.id, part_no: jt.part_no, project_id: jt.project_id, ...userPreset('issues') }, reload) }, '+ Raise issue') : null),
    issues.length ? issueTable(issues) : h('div', { class: 'panel muted' }, 'No issues for this item.'),
    h('h2', {}, 'Steps'),
    h('p', { class: 'muted' }, 'Seq sets the order of the processes. Add a step for each process this part goes through.'),
    recordTable('jt_steps', { filter: { job_traveller_id: jt.id }, columns: ['seq', 'process_id', 'cycle_min', 'target_qty', 'details'] }),
  ];
}

// Search by Job Traveller no. (or part / drawing no.). One match opens it straight away.
async function viewFind() {
  const q = (new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '').trim();
  if (!q) return [h('h1', {}, 'Find Job Traveller'), h('p', { class: 'muted' }, 'Type a Job Traveller no., part no. or drawing no. in the search box at the top.')];
  const rows = await api('GET', `/api/job_travellers?q=${encodeURIComponent(q)}`);
  const exact = rows.find((r) => r.jt_no.toUpperCase() === q.toUpperCase());
  if (exact || rows.length === 1) { location.replace(`#/jt/${(exact || rows[0]).id}`); return []; }
  return [h('h1', {}, `Search: ${q}`),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Job Traveller', 'Part number', 'Drawing', 'Qty', 'Due', 'Status'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: 'click', onclick: () => { location.hash = `#/jt/${r.id}`; } },
        h('td', {}, r.jt_no), h('td', {}, r.part_no), h('td', {}, r.drawing_no || ''), h('td', { class: 'num' }, fmtNum(r.qty)), h('td', {}, fmtDate(r.due_date)), h('td', {}, pill(r.status)))))))
      : h('div', { class: 'panel muted' }, 'Nothing found.')];
}

// New project: mother part with child parts (any depth). Qty per parent is multiplied down the tree.
async function viewProjectNew() {
  const procs = await processList();
  const MATS = state.meta.resources.parts.fields.find((f) => f.name === 'material').options;
  let n = 0;
  const rows = h('tbody');
  const field = (name, attrs) => h('input', { name, ...attrs });
  function addRow(parentRow) {
    const key = String(++n);
    const depth = parentRow ? Number(parentRow.dataset.depth) + 1 : 0;
    const tr = h('tr', { 'data-key': key, 'data-parent': parentRow ? parentRow.dataset.key : '', 'data-depth': depth },
      h('td', {}, h('span', { class: `lvl lvl${Math.min(depth, 4)}` }, depth ? `${'↳'.padStart(depth, ' ')} Child` : 'Mother'), field('part_no', { required: true, placeholder: 'Part number' })),
      h('td', {}, field('description', { placeholder: 'Description' })),
      h('td', {}, h('select', { name: 'material' }, h('option', { value: '' }, '—'), MATS.map((m) => h('option', {}, m)))),
      h('td', {}, field('thickness', { type: 'number', step: 'any', min: 0, class: 'narrow' })),
      h('td', {}, field('qty_per_parent', { type: 'number', min: 1, step: 'any', value: 1, class: 'narrow', disabled: !parentRow })),
      h('td', { class: 'procs' }, procs.map((p) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'proc', value: p.id }), p.name))),
      h('td', {}, h('button', { class: 'btn small', type: 'button', onclick: () => addRow(tr) }, '+ Child'), ' ',
        h('button', { class: 'btn small danger', type: 'button', onclick: () => {
          const drop = new Set([tr.dataset.key]);
          [...rows.children].forEach((r) => { if (drop.has(r.dataset.parent)) drop.add(r.dataset.key); });
          [...rows.children].filter((r) => drop.has(r.dataset.key)).forEach((r) => r.remove());
        } }, 'Remove')));
    // A child goes after the last row in its parent's branch.
    let after = parentRow;
    if (parentRow) {
      const branch = new Set([parentRow.dataset.key]);
      for (const r of [...rows.children].slice([...rows.children].indexOf(parentRow) + 1)) {
        if (!branch.has(r.dataset.parent)) break;
        branch.add(r.dataset.key); after = r;
      }
      after.after(tr);
    } else rows.append(tr);
    tr.querySelector('input').focus();
  }
  const msg = h('div');
  const f = h('form', { class: 'panel form' },
    h('div', {}, h('label', {}, 'Project code *'), h('input', { name: 'code', required: true })),
    h('div', {}, h('label', {}, 'Project name *'), h('input', { name: 'name', required: true })),
    h('div', {}, h('label', {}, 'Customer'), h('input', { name: 'customer' })),
    h('div', {}, h('label', {}, 'Work order'), h('input', { name: 'work_order' })),
    h('div', {}, h('label', {}, 'Due date'), h('input', { name: 'due_date', type: 'date' })),
    h('div', {}, h('label', {}, 'Sets to make'), h('input', { name: 'sets', type: 'number', min: 1, value: 1 })),
    h('div', { class: 'full' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'create_jts', checked: true }), 'Create a Job Traveller for every part (qty = qty per set × sets), with the ticked processes as its routing')));
  const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    const e = f.elements;
    const parts = [...rows.children].map((r) => {
      const v = (name) => r.querySelector(`[name="${name}"]`).value.trim();
      return { key: r.dataset.key, parent_key: r.dataset.parent || null, part_no: v('part_no'), description: v('description'), material: v('material'),
        thickness: v('thickness'), qty_per_parent: r.dataset.parent ? Number(v('qty_per_parent')) || 1 : 1,
        process_ids: [...r.querySelectorAll('[name="proc"]:checked')].map((c) => Number(c.value)) };
    });
    try {
      const r = await api('POST', '/api/projects/tree', { sets: Number(e.sets.value) || 1, create_jts: e.create_jts.checked, parts,
        project: { code: e.code.value, name: e.name.value, customer: e.customer.value, work_order: e.work_order.value, due_date: e.due_date.value } });
      toast(`Project ${r.project.code} saved with ${r.parts.length} parts`);
      location.hash = `#/project/${r.project.id}`;
    } catch (err) { msg.replaceChildren(h('div', { class: 'msg err' }, err.message)); }
  } }, 'Save project');
  addRow(null);
  return [h('h1', {}, 'New project'),
    h('p', { class: 'muted' }, 'Enter the mother part (assembly), then add its child parts. A child can have its own children. Qty per parent is how many of this part go into one of its parent.'),
    f, h('h2', {}, 'Mother and child parts'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tree-form' },
      h('thead', {}, h('tr', {}, ['Part', 'Description', 'Material', 'Thk (mm)', 'Qty / parent', 'Processes', ''].map((t) => h('th', {}, t)))), rows)),
    h('div', { class: 'toolbar gap-top' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow(null) }, '+ Another mother part'), h('span', { class: 'grow' }), save),
    msg];
}

// Shop-floor layout. Boxes on a 0.5 m grid; drag to move, drag the corner to resize.
const nodes = (...a) => a.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
const LAYOUT_TYPES = { machine: 'Machine', cell: 'Work cell', storage: 'Storage / rack', walkway: 'Walkway', office: 'Office / QC', wall: 'Wall', label: 'Label' };
async function viewLayout(versionArg) {
  let data = await api('GET', versionArg ? `/api/layout/versions/${versionArg}` : '/api/layout');
  const versions = await api('GET', '/api/layout/versions');
  const canEdit = right('layout', 'edit');
  let items = data.items.map((it) => ({ ...it }));
  let floor = { ...data.floor };
  let selected = null;
  let dirty = false;
  const PX = 16; // pixels per grid unit
  const mById = new Map(data.machines.map((m) => [m.id, m]));
  const locs = new Map(data.locations.map((l) => [l.location, l]));
  const canvas = h('div', { class: 'floor' });
  const side = h('div', { class: 'floor-side panel' });
  const status = h('span', { class: 'muted' });

  const place = (el, it) => { el.style.left = `${it.x * PX}px`; el.style.top = `${it.y * PX}px`; el.style.width = `${it.w * PX}px`; el.style.height = `${it.h * PX}px`; };
  function draw() {
    canvas.style.width = `${floor.w * PX}px`; canvas.style.height = `${floor.h * PX}px`;
    const rank = ['walkway', 'cell', 'office', 'storage', 'wall', 'machine', 'label'];
    canvas.replaceChildren(...[...items].sort((a, b) => rank.indexOf(a.type) - rank.indexOf(b.type)).map((it) => {
      const m = it.machine_id && mById.get(it.machine_id);
      const loc = it.location && locs.get(it.location);
      const cls = ['lay', `lay-${it.type}`, it === selected ? 'sel' : '',
        m ? `st-${STATUS_CLASS[m.status] || 'info'}` : '', loc && loc.low ? 'st-warn' : ''].join(' ');
      const el = h('div', { class: cls, title: it.label },
        h('div', { class: 'lay-name' }, it.label || (m ? m.code : LAYOUT_TYPES[it.type])),
        m ? h('div', { class: 'lay-sub' }, m.status, m.open_wo ? ` · ${m.open_wo} WO` : '') : null,
        loc ? h('div', { class: 'lay-sub' }, `${loc.items} item${loc.items === 1 ? '' : 's'}${loc.low ? ` · ${loc.low} low` : ''}`) : null,
        canEdit ? h('div', { class: 'lay-grip' }) : null);
      place(el, it);
      el.addEventListener('pointerdown', (e) => startDrag(e, it, el, e.target.classList.contains('lay-grip')));
      return el;
    }));
    drawSide();
  }
  function startDrag(e, it, el, resize) {
    e.preventDefault();
    selected = it;
    if (!canEdit) { draw(); return; }
    const start = { ...it, cx: e.clientX, cy: e.clientY };
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = Math.round((ev.clientX - start.cx) / PX), dy = Math.round((ev.clientY - start.cy) / PX);
      if (resize) { it.w = Math.max(1, Math.min(floor.w - it.x, start.w + dx)); it.h = Math.max(1, Math.min(floor.h - it.y, start.h + dy)); }
      else { it.x = Math.max(0, Math.min(floor.w - it.w, start.x + dx)); it.y = Math.max(0, Math.min(floor.h - it.h, start.y + dy)); }
      place(el, it);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => {
      el.removeEventListener('pointermove', move);
      if (it.x !== start.x || it.y !== start.y || it.w !== start.w || it.h !== start.h) dirty = true;
      draw();
    }, { once: true });
  }
  function drawSide() {
    if (!selected) {
      side.replaceChildren(...nodes(h('strong', {}, 'Floor'), h('p', { class: 'muted' }, `${floor.w / 2} m × ${floor.h / 2} m. 1 square = 0.5 m.`),
        canEdit ? [h('label', {}, 'Width (squares)'), numInput(floor, 'w', 10, 400), h('label', {}, 'Length (squares)'), numInput(floor, 'h', 10, 400)] : null,
        h('p', { class: 'muted' }, canEdit ? 'Click an item to change it. Drag to move, drag the corner to resize.' : 'Click a machine or store to see its details.')));
      return;
    }
    const it = selected;
    const m = it.machine_id && mById.get(it.machine_id);
    const loc = it.location && locs.get(it.location);
    const set = (k) => (e) => { it[k] = e.target.value; dirty = true; draw(); };
    side.replaceChildren(...nodes(
      h('strong', {}, LAYOUT_TYPES[it.type]),
      canEdit ? [
        h('label', {}, 'Name'), h('input', { value: it.label, maxlength: 60, onchange: set('label') }),
        it.type === 'machine' ? [h('label', {}, 'Machine'), h('select', { onchange: (e) => { it.machine_id = Number(e.target.value) || null; dirty = true; draw(); } },
          h('option', { value: '' }, '—'), data.machines.map((x) => h('option', { value: x.id, selected: x.id === it.machine_id }, `${x.code} ${x.name}`)))] : null,
        it.type === 'storage' ? [h('label', {}, 'Inventory location'), h('select', { onchange: set('location') },
          h('option', { value: '' }, '—'), data.locations.map((l) => h('option', { selected: l.location === it.location }, l.location)))] : null,
        h('div', { class: 'gap-top' }, h('button', { class: 'btn small danger', onclick: () => { items = items.filter((x) => x !== it); selected = null; dirty = true; draw(); } }, 'Remove'), ' ',
          h('button', { class: 'btn small', onclick: () => { selected = null; draw(); } }, 'Done')),
      ] : null,
      m ? h('div', { class: 'gap-top' }, pill(m.status), h('div', {}, `${m.code} — ${m.name}`), h('div', { class: 'muted' }, m.machine_type || ''),
        h('div', {}, `Open work orders: ${m.open_wo}`),
        m.last ? h('div', {}, 'Last job: ', h('a', { href: `#/jt/${m.last.jt_id}` }, m.last.jt_no), ` ${m.last.part_no} (${fmtDate(m.last.date)})`) : h('div', { class: 'muted' }, 'No output recorded on this machine yet'),
        h('a', { class: 'btn small gap-top', href: '#/r/maint_orders' }, 'Maintenance')) : null,
      loc ? h('div', { class: 'gap-top' }, h('div', {}, `${loc.items} items stored here`), loc.low ? h('div', {}, pill('Low'), ` ${loc.low} to reorder`) : null,
        h('a', { class: 'btn small gap-top', href: '#/r/inventory_items' }, 'Inventory')) : null));
  }
  function numInput(obj, key, min, max) {
    return h('input', { type: 'number', min, max, value: obj[key], onchange: (e) => {
      const v = Math.trunc(Number(e.target.value));
      if (v >= min && v <= max && items.every((it) => (key === 'w' ? it.x + it.w : it.y + it.h) <= v)) { obj[key] = v; dirty = true; }
      else toast('The floor must stay bigger than the items on it', true);
      draw();
    } });
  }
  function add(type) {
    const it = { id: `n${Date.now()}`, type, label: LAYOUT_TYPES[type], x: 1, y: 1, w: type === 'walkway' ? 20 : type === 'wall' ? 20 : type === 'label' ? 6 : 6, h: type === 'walkway' ? 3 : type === 'wall' || type === 'label' ? 1 : 5, machine_id: null, location: '' };
    items.push(it); selected = it; dirty = true; draw();
  }
  const note = h('input', { class: 'note', placeholder: 'What changed (optional)', maxlength: 200 });
  async function save() {
    try {
      data = await api('POST', '/api/layout', { floor, items, note: note.value });
      dirty = false; toast(`Layout saved as version ${data.version}`); location.hash = '#/layout';
      route();
    } catch (e) { toast(e.message, true); }
  }
  const pick = h('select', { onchange: (e) => { location.hash = e.target.value ? `#/layout/${e.target.value}` : '#/layout'; } },
    h('option', { value: '' }, 'Latest version'),
    versions.map((v) => h('option', { value: v.version, selected: String(v.version) === String(versionArg) }, `v${v.version} · ${fmtDate(v.created_at)} · ${v.saved_by}${v.note ? ` · ${v.note}` : ''}`)));
  window.onbeforeunload = () => (dirty ? true : undefined);
  draw();
  return [
    h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, 'Shop-floor layout'), pick),
    h('p', { class: 'muted' }, data.version ? `Version ${data.version}, saved by ${data.saved_by} on ${fmtDate(data.created_at)}${versionArg ? ' (older version)' : ''}.` : 'Not saved yet: this is a starting layout from the machine list and inventory locations.'),
    canEdit ? h('div', { class: 'toolbar' }, Object.entries(LAYOUT_TYPES).map(([k, v]) => h('button', { class: 'btn small', onclick: () => add(k) }, `+ ${v}`)),
      h('span', { class: 'grow' }), note, h('button', { class: 'btn primary', onclick: save }, versionArg ? 'Restore as latest' : 'Save layout'), status) : null,
    h('div', { class: 'floor-wrap' }, h('div', { class: 'floor-scroll' }, canvas), side),
    h('div', { class: 'legend muted' }, h('span', { class: 'lay-key st-ok' }, 'Running'), h('span', { class: 'lay-key st-info' }, 'Idle'),
      h('span', { class: 'lay-key st-warn' }, 'Maintenance / low stock'), h('span', { class: 'lay-key st-bad' }, 'Down')),
  ];
}

// A4 Job Traveller that goes with the parts through the shop.
async function viewJobTravellerPrint(id) {
  const [jt, steps] = await Promise.all([api('GET', `/api/job_travellers/${id}`), api('GET', `/api/job_travellers/${id}/progress`)]);
  const cell = (label, value) => [h('th', {}, label), h('td', {}, value ?? '')];
  return [
    h('div', { class: 'print-actions' },
      h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print / Save as PDF'),
      h('a', { class: 'btn', href: `#/jt/${jt.id}` }, 'Back to Job Traveller')),
    h('div', { class: 'print-page' },
      h('div', { class: 'doc-head' }, h('div', {}, h('div', { class: 'company' }, state.meta.company), h('h1', {}, 'JOB TRAVELLER')),
        h('div', { class: 'doc-no' }, jt.jt_no)),
      h('table', {},
        h('tr', {}, cell('Project', jt.project_id__label), cell('Customer', jt.customer)),
        h('tr', {}, cell('Part number', jt.part_no), cell('Drawing no.', jt.drawing_no)),
        h('tr', {}, cell('Description', jt.description), cell('Material', [jt.material, jt.thickness && `${fmtNum(jt.thickness)} mm`].filter(Boolean).join(' '))),
        h('tr', {}, cell('Required qty (pcs)', fmtNum(jt.qty)), cell('Due date', fmtDate(jt.due_date)))),
      h('h2', {}, 'Process routing'),
      h('table', { class: 'route' },
        h('tr', {}, ['Seq', 'Process', 'Details', 'Cycle (min/pc)', 'Target', 'Good', 'Reject', 'Date', 'Operator', 'QC'].map((t) => h('th', {}, t))),
        steps.map((s) => h('tr', {}, h('td', {}, s.seq ?? ''), h('td', {}, s.process), h('td', {}, s.details || ''), h('td', { class: 'num' }, fmtNum(s.cycle_min)),
          h('td', { class: 'num' }, fmtNum(s.target_qty)), h('td', { class: 'num' }, s.good ? fmtNum(s.good) : ''), h('td', { class: 'num' }, s.reject ? fmtNum(s.reject) : ''),
          h('td', {}), h('td', {}), h('td', {})))),
      jt.notes ? [h('h2', {}, 'Notes'), h('p', { class: 'pre' }, jt.notes)] : null,
      h('table', { class: 'sign' },
        h('tr', {}, ['Prepared by (Planner)', 'Checked by (Supervisor)', 'Verified by (QA / QC)', 'Approved by (Production Manager)'].map((t) => h('th', {}, t))),
        h('tr', {}, [0, 1, 2, 3].map(() => h('td', {}, h('div', { class: 'sign-date' }, 'Date:'))))),
      h('div', { class: 'print-foot muted' }, `Printed ${fmtDate(localToday())} · ${state.meta.company}`)),
  ];
}

async function processList() {
  const all = await api('GET', '/api/shop_processes');
  return all.filter((p) => p.active !== 'No').sort((a, b) => (a.seq ?? 999) - (b.seq ?? 999));
}
const extraNames = (p) => String((p && p.extra_fields) || '').split(',').map((x) => x.trim()).filter(Boolean);

// The one Operator form used by every shop process. `holder` gets the form; returns it.
async function outputForm(row, preset, onSaved, onCancel) {
  const [processes, jts, codes] = await Promise.all([processList(), api('GET', '/api/job_travellers'), api('GET', '/api/reason_codes')]);
  const v = { ...userPreset('operator_outputs'), ...(preset || {}), ...(row || {}) };
  const extra = (() => { try { return JSON.parse(v.extra || '{}'); } catch { return {}; } })();
  const editable = row ? right('operator_outputs', 'update') && (state.user.role === 'admin' || row.operator === state.user.username) : right('operator_outputs', 'create');
  const err = h('div');
  const sel = (name, opts, value) => h('select', { name, required: true, disabled: !editable }, h('option', { value: '' }, ''),
    opts.map((o) => h('option', { value: o.id, selected: String(o.id) === String(value ?? '') }, o.label)));
  const num = (name, value) => h('input', { type: 'number', step: 'any', name, value: value ?? '', disabled: !editable });
  const txt = (name, value, type = 'text') => h('input', { type, name, value: value ?? '', disabled: !editable });
  const procSel = sel('process_id', processes.map((p) => ({ id: p.id, label: p.name })), v.process_id);
  const jtSel = h('select', { name: 'job_traveller_id', disabled: !editable });
  const extraBox = h('div', { class: 'form full' });
  const rejectSel = h('select', { name: 'reject_code', disabled: !editable });
  const downSel = h('select', { name: 'downtime_code', disabled: !editable });
  // Reason codes for the chosen process, plus codes that apply to every process.
  function fillCodes(pid) {
    for (const [el, kind, value] of [[rejectSel, 'Reject', v.reject_code], [downSel, 'Downtime', v.downtime_code]]) {
      const list = codes.filter((c) => c.kind === kind && (!c.process_id || c.process_id === pid)).sort((a, b) => a.code.localeCompare(b.code));
      el.replaceChildren(h('option', { value: '' }, '—'), ...list.map((c) => h('option', { value: c.code, selected: c.code === value }, `${c.code} · ${c.description}`)));
    }
  }
  const targetNote = h('div', { class: 'help' });

  async function refresh() {
    const pid = Number(procSel.value);
    const steps = pid ? await api('GET', `/api/jt_steps?process_id=${pid}`) : [];
    const withStep = new Set(steps.map((s) => s.job_traveller_id));
    const open = jts.filter((j) => (!pid || withStep.has(j.id) || j.id === Number(v.job_traveller_id)) && !['Completed', 'Cancelled'].includes(j.status));
    jtSel.replaceChildren(h('option', { value: '' }, ''), ...open.map((j) => h('option', { value: j.id, selected: j.id === Number(v.job_traveller_id) }, `${j.jt_no} · ${j.part_no}`)));
    const proc = processes.find((p) => p.id === pid);
    fillCodes(pid);
    extraBox.replaceChildren(...extraNames(proc).map((n) => h('div', {}, h('label', {}, n), h('input', { type: 'text', 'data-extra': n, value: extra[n] ?? '', disabled: !editable }))));
    showTarget(steps);
  }
  function showTarget(steps) {
    const s = (steps || []).find((x) => x.job_traveller_id === Number(jtSel.value));
    targetNote.textContent = s ? `Target ${fmtNum(s.target_qty) || '—'} pcs · cycle ${fmtNum(s.cycle_min) || '—'} min/pc` : '';
  }
  procSel.addEventListener('change', () => { v.job_traveller_id = jtSel.value; refresh(); });
  jtSel.addEventListener('change', async () => showTarget(await api('GET', `/api/jt_steps?process_id=${procSel.value}`)));

  const form = h('form', { class: 'form' },
    h('div', {}, h('label', {}, 'Process *'), procSel),
    h('div', {}, h('label', {}, 'Job Traveller *'), jtSel, targetNote),
    h('div', {}, h('label', {}, 'Date *'), txt('date', v.date, 'date')),
    h('div', {}, h('label', {}, 'Session / time slot'), txt('slot', v.slot)),
    h('div', {}, h('label', {}, 'Good qty *'), num('good_qty', v.good_qty)),
    h('div', {}, h('label', {}, 'Reject qty'), num('reject_qty', v.reject_qty ?? 0)),
    h('div', {}, h('label', {}, 'Run time (min)'), num('run_min', v.run_min)),
    h('div', {}, h('label', {}, 'Downtime (min)'), num('downtime_min', v.downtime_min ?? 0)),
    h('div', {}, h('label', {}, 'Reject code'), rejectSel),
    h('div', {}, h('label', {}, 'Downtime code'), downSel),
    h('div', {}, h('label', {}, 'Machine'), txt('machine', v.machine)),
    h('div', {}, h('label', {}, 'Remark'), txt('remark', v.remark)),
    extraBox,
    row ? h('div', { class: 'full muted small' }, `Recorded by ${row.operator || '—'}`) : null);
  form.addEventListener('submit', (e) => e.preventDefault());
  await refresh();

  async function save() {
    const data = {};
    for (const n of ['process_id', 'job_traveller_id', 'date', 'slot', 'good_qty', 'reject_qty', 'run_min', 'downtime_min', 'reject_code', 'downtime_code', 'machine', 'remark']) data[n] = form.elements[n].value;
    data.extra = {};
    form.querySelectorAll('[data-extra]').forEach((el) => { if (el.value.trim()) data.extra[el.dataset.extra] = el.value.trim(); });
    try {
      const saved = row ? await api('PUT', `/api/operator_outputs/${row.id}`, data) : await api('POST', '/api/operator_outputs', data);
      toast('Output saved');
      if (onSaved) onSaved(saved);
    } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
  }
  const buttons = [
    onCancel ? h('button', { class: 'btn', onclick: onCancel }, editable ? 'Cancel' : 'Close') : null,
    editable ? h('button', { class: 'btn primary', onclick: save }, row ? 'Save' : 'Save output') : null,
  ];
  return { body: [err, form], buttons };
}

async function outputDialog(row, preset, reload) {
  let closeFn;
  const f = await outputForm(row, preset, () => { closeFn(); if (reload) reload(); }, () => closeFn());
  closeFn = openModal(row ? 'Operator output' : 'New operator output', f.body, () => f.buttons);
}

async function viewOperator() {
  const jt = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('jt')) || null;
  const f = await outputForm(null, jt ? { job_traveller_id: jt } : {}, () => route());
  return [
    h('h1', {}, 'Operator form'),
    h('p', { class: 'muted' }, 'One form for every process. Choose the process and Job Traveller, then key in the output for this session.'),
    h('div', { class: 'panel' }, f.body, h('div', { class: 'toolbar reply-actions' }, h('span', { class: 'grow' }), f.buttons)),
    h('h2', {}, 'Output recorded today'),
    recordTable('operator_outputs', { filter: { date: localToday() }, onRow: (r, reload) => outputDialog(r, {}, reload) }),
  ];
}

async function viewUsers() {
  const box = h('div');
  async function load() {
    const users = await api('GET', '/api/users');
    box.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Process', 'Also edits for', 'Full edit', 'Active', 'Created'].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', { class: 'click', onclick: () => userForm(u, load) },
        h('td', {}, u.username), h('td', {}, u.full_name || ''), h('td', {}, h('span', { class: 'role' }, u.role)), h('td', {}, u.process || ''),
        h('td', {}, u.extra_processes.join(', ')), h('td', {}, u.full_edit ? h('span', { class: 'pill warn' }, 'Appointed') : ''),
        h('td', {}, u.active ? h('span', { class: 'pill ok' }, 'Active') : h('span', { class: 'pill bad' }, 'Disabled')),
        h('td', {}, u.created_at)))))));
  }
  await load();
  return [
    h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, 'Users'), h('button', { class: 'btn primary', onclick: () => userForm(null, load) }, '+ New user')),
    h('p', { class: 'muted' }, 'Everyone can view all data. A user can change only the data of their own process (see Access rights), plus any extra processes ticked here. "Full edit" is for users appointed by Admin: they can change all data (not users or deletes). Viewer: view and export only. Changes apply at once and are recorded in the Activity log.'),
    h('p', { class: 'muted' }, `Process is the person's job (${state.meta.processes.join(', ')}). New daily log entries and issues start with it.`),
    box,
  ];
}

function userForm(u, reload) {
  const err = h('div');
  const f = h('form', { class: 'form' },
    h('div', {}, h('label', {}, 'Username'), u ? h('div', { class: 'ro' }, u.username) : h('input', { type: 'text', name: 'username', required: true })),
    h('div', {}, h('label', {}, 'Full name'), h('input', { type: 'text', name: 'full_name', value: u ? u.full_name : '' })),
    h('div', {}, h('label', {}, 'Role'), h('select', { name: 'role' }, state.meta.roles.map((r) => h('option', { value: r, selected: u ? u.role === r : r === 'viewer' }, r)))),
    h('div', {}, h('label', {}, 'Process'), h('select', { name: 'process' }, h('option', { value: '' }, ''),
      state.meta.processes.map((p) => h('option', { value: p, selected: u ? u.process === p : false }, p)))),
    h('div', {}, h('label', {}, u ? 'New password (leave empty to keep)' : 'Password (8+ characters)'), h('input', { type: 'password', name: 'password', autocomplete: 'new-password' })),
    h('div', { class: 'full' }, h('label', {}, 'Can also edit the data of'), h('div', {}, state.meta.processes.map((p) =>
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'extra', value: p, checked: !!(u && u.extra_processes.includes(p)) }), p)))),
    h('div', { class: 'full' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'full_edit', checked: !!(u && u.full_edit) }),
      h('strong', {}, 'Full edit (appointed by Admin)'), ' can change all data in every module')),
    u ? h('div', {}, h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: u.active }), ' Active')) : null);
  f.addEventListener('submit', (e) => e.preventDefault());
  openModal(u ? `User: ${u.username}` : 'New user', [err, f], (close) => [
    u && u.id !== state.user.id ? h('button', { class: 'btn danger left', onclick: async () => {
      if (!window.confirm(`Delete user ${u.username}?`)) return;
      try { await api('DELETE', `/api/users/${u.id}`); close(); reload(); } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
    } }, 'Delete') : null,
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const body = { full_name: f.elements.full_name.value, role: f.elements.role.value, process: f.elements.process.value,
        full_edit: f.elements.full_edit.checked, extra_processes: [...f.querySelectorAll('[name="extra"]:checked')].map((c) => c.value) };
      if (f.elements.password.value) body.password = f.elements.password.value;
      try {
        if (u) { body.active = f.elements.active.checked; await api('PUT', `/api/users/${u.id}`, body); }
        else { body.username = f.elements.username.value; await api('POST', '/api/users', body); }
        close(); toast('User saved'); reload();
      } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
    } }, 'Save'),
  ]);
}

// What changed: "field: old → new" for updates, the values for create/delete.
function auditChange(r) {
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const b = parse(r.before), a = parse(r.after);
  if (Array.isArray(a) || Array.isArray(b)) return `${(b || []).length} → ${(a || []).length} rights`;
  const show = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const keys = [...new Set([...Object.keys(b || {}), ...Object.keys(a || {})])].filter((k) => !b || !a || show(b[k]) !== show(a[k]));
  return keys.slice(0, 8).map((k) => (b && a ? `${k}: ${show(b[k])} → ${show(a[k])}` : `${k}: ${show((a || b)[k])}`)).join('; ');
}

async function viewAudit() {
  const rows = await api('GET', '/api/audit');
  return [h('h1', {}, 'Activity log'), h('p', { class: 'muted' }, 'Every change: who, when, and the values before and after.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['When (UTC)', 'User', 'Action', 'Module', 'Record', 'Change'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.at)), h('td', {}, r.username || ''), h('td', {}, r.action),
        h('td', {}, (state.meta.resources[r.resource] || {}).label || r.resource), h('td', { class: 'num' }, r.record_id ?? ''),
        h('td', { class: 'wrap' }, auditChange(r)))))))];
}

// Admin: tick which process may change which module. Takes effect on the next click of every user.
async function viewRights() {
  const rows = await api('GET', '/api/rights');
  const on = new Set(rows.map((r) => `${r.process}|${r.resource}`));
  const procs = state.meta.processes;
  const mods = Object.entries(state.meta.resources).filter(([, r]) => r.write.length < 3 || r.processes);
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Module'), procs.map((p) => h('th', {}, p)))),
    h('tbody', {}, mods.map(([name, r]) => h('tr', {}, h('td', {}, r.label),
      procs.map((p) => h('td', {}, h('input', { type: 'checkbox', 'data-p': p, 'data-r': name, checked: on.has(`${p}|${name}`) })))))));
  return [h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, 'Access rights'),
    h('button', { class: 'btn primary', onclick: async () => {
      const rights = [...table.querySelectorAll('input:checked')].map((c) => ({ process: c.dataset.p, resource: c.dataset.r }));
      try { await api('PUT', '/api/rights', { rights }); toast('Access rights saved'); } catch (e) { toast(e.message, true); }
    } }, 'Save')),
    h('p', { class: 'muted' }, 'Which process may add and change each module. Everyone can view all modules. Daily log, Issues and Stock log are open to all. Admin and Full-edit users can change everything.'),
    h('div', { class: 'table-wrap' }, table)];
}

function viewAccount() {
  const msg = h('div');
  const f = h('form', { class: 'panel form' },
    h('div', { class: 'full' }, h('label', {}, 'Current password'), h('input', { type: 'password', name: 'current', autocomplete: 'current-password' })),
    h('div', {}, h('label', {}, 'New password (8+ characters)'), h('input', { type: 'password', name: 'next', autocomplete: 'new-password' })),
    h('div', {}, h('label', {}, 'Repeat new password'), h('input', { type: 'password', name: 'again', autocomplete: 'new-password' })),
    h('div', { class: 'full' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (f.elements.next.value !== f.elements.again.value) { msg.replaceChildren(h('div', { class: 'msg err' }, 'The new passwords do not match')); return; }
    try {
      await api('POST', '/api/me/password', { current: f.elements.current.value, next: f.elements.next.value });
      f.reset();
      msg.replaceChildren(h('div', { class: 'msg ok' }, 'Password changed.'));
    } catch (err) { msg.replaceChildren(h('div', { class: 'msg err' }, err.message)); }
  });
  return [h('h1', {}, 'My account'),
    h('p', {}, `Signed in as ${state.user.username}`, h('span', { class: 'role' }, state.user.role),
      state.user.process ? h('span', { class: 'role' }, state.user.process) : null),
    h('h2', {}, 'Colour theme'), themePicker(),
    h('h2', {}, 'Password'), msg, f];
}

// Colour themes (public/styles.css [data-theme]). Saved per user, so it follows them to any PC.
const THEMES = [
  ['standard', 'Standard', 'Navy and amber. The default for office and shop floor.', ['#1f3a5f', '#2c5282', '#f0a43a', '#f4f6f9']],
  ['light', 'Light', 'Soft grey and blue. Calm for long hours at a desk.', ['#eef1f4', '#0a5cad', '#d97706', '#ffffff']],
  ['dark', 'Dark', 'Low glare for night shift and bright screens.', ['#0f1317', '#2f6fb8', '#e8a948', '#1c2228']],
  ['green', 'Soft green', 'Green tones that are easy on the eyes.', ['#1e4d3a', '#24604a', '#e0a43a', '#f2f5f1']],
  ['contrast', 'High contrast', 'Black and white with thick lines. Easiest to read from a distance.', ['#000000', '#00307a', '#ffcc00', '#ffffff']],
];
function applyTheme(t) { document.documentElement.dataset.theme = t || 'standard'; }

function themePicker() {
  const wrap = h('div', { class: 'themes' });
  const draw = () => wrap.replaceChildren(...THEMES.map(([id, name, note, colours]) => {
    const sw = h('div', { class: 'swatches' }, colours.map((c) => { const x = h('span'); x.style.background = c; return x; }));
    return h('button', { type: 'button', class: `theme-card${state.user.theme === id ? ' on' : ''}`, onclick: async () => {
      try { await api('POST', '/api/me/theme', { theme: id }); state.user.theme = id; applyTheme(id); draw(); toast(`Theme: ${name}`); }
      catch (e) { toast(e.message, true); }
    } }, h('strong', {}, name), sw, h('div', { class: 'muted' }, note));
  }));
  draw();
  return wrap;
}

// ---------- shell and routing ------------------------------------------------

function renderLogin(message) {
  const err = h('div', {}, message ? h('div', { class: 'msg err' }, message) : null);
  const f = h('form', { class: 'panel' },
    h('h1', {}, h('img', { src: 'icon.svg', alt: '' }), 'Sheet Metal Manager'),
    err,
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), h('input', { id: 'u', type: 'text', name: 'username', autocomplete: 'username', required: true })),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), h('input', { id: 'p', type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/login', { username: f.elements.username.value, password: f.elements.password.value });
      state.user = r.user; state.rights = r.rights;
      await start();
    } catch (ex) { err.replaceChildren(h('div', { class: 'msg err' }, ex.message)); }
  });
  document.getElementById('app').replaceChildren(h('div', { class: 'login' }, f));
  f.elements.username.focus();
}

function renderShell() {
  const groups = {};
  for (const [name, r] of Object.entries(state.meta.resources)) {
    if (name === 'drawings' || r.nav === false) continue;
    (groups[r.group] = groups[r.group] || []).push([`#/r/${name}`, r.label]);
  }
  groups.Engineering = [['#/drawings', 'Drawings'], ...(groups.Engineering || [])];
  const daily = [['#/daily', 'Daily board'], ...(groups['Daily work'] || [])];
  groups.Production = [['#/operator', 'Operator form'], ['#/layout', 'Shop-floor layout'], ...(groups.Production || [])];
  if (right('projects', 'create')) groups.Planning = [['#/project-new', 'New project (parts)'], ...(groups.Planning || [])];
  delete groups['Daily work'];
  const nav = h('nav', { class: 'side', id: 'side' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('div', {}, 'Sheet Metal Manager', h('div', { class: 'brand-sub' }, state.meta.company))),
    h('a', { href: '#/' }, 'Dashboard'),
    Object.entries({ 'Daily work': daily, ...groups }).map(([g, links]) => [h('h4', {}, g), links.map(([href, label]) => h('a', { href }, label))]),
    state.user.role === 'admin' ? [h('h4', {}, 'Admin'), h('a', { href: '#/users' }, 'Users'), h('a', { href: '#/rights' }, 'Access rights'), h('a', { href: '#/audit' }, 'Activity log')] : null,
    h('h4', {}, 'Account'), h('a', { href: '#/account' }, 'My account'));
  const search = h('form', { class: 'find', role: 'search', onsubmit: (e) => {
    e.preventDefault();
    const q = search.elements.q.value.trim();
    if (q) location.hash = `#/find?q=${encodeURIComponent(q)}`;
  } }, h('input', { name: 'q', type: 'search', placeholder: 'Job Traveller no. e.g. JT-2026-0001', 'aria-label': 'Find Job Traveller' }), h('button', { class: 'btn', type: 'submit' }, 'Find'));
  const top = h('div', { class: 'top' },
    h('button', { class: 'btn menu-btn', onclick: () => nav.classList.toggle('open') }, '☰'),
    search,
    h('span', { class: 'who' }, state.user.full_name || state.user.username, h('span', { class: 'role' }, state.user.role),
      state.user.process ? h('span', { class: 'role' }, state.user.process) : null),
    h('span', {}, h('span', { class: 'muted' }, `v${state.version} `),
      h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); state.user = null; history.replaceState(null, '', '#/'); renderLogin(); } }, 'Sign out')));
  document.getElementById('app').replaceChildren(h('div', { class: 'shell' }, nav, h('div', { class: 'main' }, top, h('div', { class: 'content', id: 'content' }))));
}

async function route() {
  if (!state.user) return;
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [a, b, c] = hash.split('/');
  document.querySelectorAll('.side a').forEach((el) => el.classList.toggle('on', el.getAttribute('href') === `#/${a ? [a, b].filter(Boolean).join('/') : ''}`));
  document.getElementById('side').classList.remove('open');
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  if (a !== 'layout') window.onbeforeunload = null;
  let view;
  try {
    if (!a) view = await viewDashboard();
    else if (a === 'r') view = viewList(b);
    else if (a === 'drawings') view = viewDrawings();
    else if (a === 'daily') view = await viewDaily(b);
    else if (a === 'issue') view = await viewIssue(Number(b));
    else if (a === 'jt' && c === 'print') view = await viewJobTravellerPrint(Number(b));
    else if (a === 'jt') view = await viewJobTraveller(Number(b));
    else if (a === 'operator') view = await viewOperator();
    else if (a === 'find') view = await viewFind();
    else if (a === 'layout') view = await viewLayout(b);
    else if (a === 'project-new') view = await viewProjectNew();
    else if (a === 'project') view = await viewProject(Number(b));
    else if (a === 'ncr' && c === 'print') view = await viewNcrPrint(Number(b));
    else if (a === 'users') view = await viewUsers();
    else if (a === 'audit') view = await viewAudit();
    else if (a === 'rights') view = await viewRights();
    else if (a === 'account') view = viewAccount();
    else view = [h('h1', {}, 'Page not found')];
  } catch (e) {
    view = [h('div', { class: 'msg err' }, e.message)];
  }
  content().replaceChildren(...[view].flat(Infinity).filter((v) => v !== null && v !== undefined && v !== false));
  window.scrollTo(0, 0);
}

async function start() {
  const [me, meta] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/meta')]);
  Object.assign(state, { user: me.user, rights: me.rights, version: me.version, meta });
  applyTheme(me.user.theme);
  renderShell();
  await route();
}

window.addEventListener('hashchange', route);
start().catch(() => { if (!state.user) renderLogin(); });
