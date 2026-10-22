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
  'Blocked': 'bad', 'Resolved': 'ok', 'Urgent': 'bad', 'High': 'warn',
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
  const editable = isNew ? right(resName, 'create') : right(resName, 'update') && !ownedByOther;
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
    right(resName, 'export') ? h('a', { class: 'btn', href: `/api/${resName}/export.csv?${new URLSearchParams(filter)}` }, 'Export CSV') : null,
    right(resName, 'create') ? h('button', { class: 'btn primary', onclick: () => (onRow ? onRow(null, load) : editRecord(resName, null, filter, load)) }, `+ New ${res.singular}`) : null),
    tableBox);
  load();
  wrap.reload = load;
  return wrap;
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
    if (right('job_travellers', 'create')) opts.extra = [h('button', { class: 'btn', onclick: () => importDialog(() => route()) }, 'Import Excel')];
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

async function viewJobTraveller(id) {
  const [jt, steps] = await Promise.all([api('GET', `/api/job_travellers/${id}`), api('GET', `/api/job_travellers/${id}/progress`)]);
  const reload = () => route();
  return [
    h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, `${jt.jt_no} — ${jt.part_no}`),
      h('a', { class: 'btn', href: `#/operator?jt=${jt.id}` }, 'Record output'),
      h('a', { class: 'btn', href: `#/jt/${jt.id}/print` }, 'Print / PDF'),
      h('button', { class: 'btn', onclick: () => editRecord('job_travellers', jt, null, reload) }, right('job_travellers', 'update') ? 'Edit' : 'Details')),
    h('div', { class: 'panel' }, h('div', { class: 'kpis' },
      [['Project', jt.project_id__label], ['Customer', jt.customer], ['Drawing', jt.drawing_no], ['Material', [jt.material, jt.thickness && `${jt.thickness} mm`].filter(Boolean).join(' ')],
        ['Qty', fmtNum(jt.qty)], ['Due', fmtDate(jt.due_date)]].map(([l, v]) => h('div', {}, h('div', { class: 'muted' }, l), h('div', {}, v || '—'))),
      h('div', {}, h('div', { class: 'muted' }, 'Status'), pill(jt.status)))),
    h('h2', {}, 'Routing and progress'),
    steps.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Seq', 'Process', 'Cycle (min)', 'Target', 'Good', 'Reject', 'Balance', 'Progress'].map((t) => h('th', {}, t)))),
      h('tbody', {}, steps.map((s) => {
        const pct = s.target_qty ? Math.min(100, Math.round((s.good / s.target_qty) * 100)) : 0;
        const bar = h('div'); bar.style.width = `${pct}%`;
        return h('tr', {}, h('td', { class: 'num' }, s.seq ?? ''), h('td', {}, s.process), h('td', { class: 'num' }, fmtNum(s.cycle_min)),
          h('td', { class: 'num' }, fmtNum(s.target_qty)), h('td', { class: 'num' }, fmtNum(s.good)), h('td', { class: 'num' }, fmtNum(s.reject)),
          h('td', { class: 'num' }, s.target_qty != null ? fmtNum(Math.max(0, s.target_qty - s.good)) : ''),
          h('td', {}, h('div', { class: 'bar' }, bar), ` ${pct}%`));
      })))) : h('div', { class: 'panel muted' }, 'No process steps yet.'),
    h('h2', {}, 'Steps'),
    h('p', { class: 'muted' }, 'Seq sets the order of the processes. Add a step for each process this part goes through.'),
    recordTable('jt_steps', { filter: { job_traveller_id: jt.id }, columns: ['seq', 'process_id', 'cycle_min', 'target_qty', 'details'] }),
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
      h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Process', 'Active', 'Created'].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', { class: 'click', onclick: () => userForm(u, load) },
        h('td', {}, u.username), h('td', {}, u.full_name || ''), h('td', {}, h('span', { class: 'role' }, u.role)), h('td', {}, u.process || ''),
        h('td', {}, u.active ? h('span', { class: 'pill ok' }, 'Active') : h('span', { class: 'pill bad' }, 'Disabled')),
        h('td', {}, u.created_at)))))));
  }
  await load();
  return [
    h('div', { class: 'toolbar' }, h('h1', { class: 'grow' }, 'Users'), h('button', { class: 'btn primary', onclick: () => userForm(null, load) }, '+ New user')),
    h('p', { class: 'muted' }, 'Admin: everything. Planner: view all, create and update projects, parts, routing and nesting, upload drawings, export; cannot delete. Viewer: view and export. Everyone can write their daily log, raise issues and reply to them.'),
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
    u ? h('div', {}, h('label', {}, h('input', { type: 'checkbox', name: 'active', checked: u.active }), ' Active')) : null);
  f.addEventListener('submit', (e) => e.preventDefault());
  openModal(u ? `User: ${u.username}` : 'New user', [err, f], (close) => [
    u && u.id !== state.user.id ? h('button', { class: 'btn danger left', onclick: async () => {
      if (!window.confirm(`Delete user ${u.username}?`)) return;
      try { await api('DELETE', `/api/users/${u.id}`); close(); reload(); } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
    } }, 'Delete') : null,
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      const body = { full_name: f.elements.full_name.value, role: f.elements.role.value, process: f.elements.process.value };
      if (f.elements.password.value) body.password = f.elements.password.value;
      try {
        if (u) { body.active = f.elements.active.checked; await api('PUT', `/api/users/${u.id}`, body); }
        else { body.username = f.elements.username.value; await api('POST', '/api/users', body); }
        close(); toast('User saved'); reload();
      } catch (e) { err.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
    } }, 'Save'),
  ]);
}

async function viewAudit() {
  const rows = await api('GET', '/api/audit');
  return [h('h1', {}, 'Activity log'), h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['When (UTC)', 'User', 'Action', 'Module', 'Record'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.at), h('td', {}, r.username || ''), h('td', {}, r.action),
      h('td', {}, r.resource), h('td', { class: 'num' }, r.record_id ?? ''))))))];
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
    msg, f];
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
  groups.Production = [['#/operator', 'Operator form'], ...(groups.Production || [])];
  delete groups['Daily work'];
  const nav = h('nav', { class: 'side', id: 'side' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('div', {}, 'Sheet Metal Manager', h('div', { class: 'brand-sub' }, state.meta.company))),
    h('a', { href: '#/' }, 'Dashboard'),
    Object.entries({ 'Daily work': daily, ...groups }).map(([g, links]) => [h('h4', {}, g), links.map(([href, label]) => h('a', { href }, label))]),
    state.user.role === 'admin' ? [h('h4', {}, 'Admin'), h('a', { href: '#/users' }, 'Users'), h('a', { href: '#/audit' }, 'Activity log')] : null,
    h('h4', {}, 'Account'), h('a', { href: '#/account' }, 'My account'));
  const top = h('div', { class: 'top' },
    h('button', { class: 'btn menu-btn', onclick: () => nav.classList.toggle('open') }, '☰'),
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
    else if (a === 'project') view = await viewProject(Number(b));
    else if (a === 'ncr' && c === 'print') view = await viewNcrPrint(Number(b));
    else if (a === 'users') view = await viewUsers();
    else if (a === 'audit') view = await viewAudit();
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
  renderShell();
  await route();
}

window.addEventListener('hashchange', route);
start().catch(() => { if (!state.user) renderLogin(); });
