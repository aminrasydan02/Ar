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
  'Blocked': 'bad', 'Resolved': 'ok', 'Urgent': 'bad', 'High': 'warn', 'Pending': '', '3D model': 'info', 'OK': 'ok', 'Low': 'warn', 'Out': 'bad', 'Pass': 'ok', 'Fail': 'bad', 'Make': 'info', 'Buy': '', 'Drawing': '', 'Image': '',
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
  if (field.name === 'shift' && state.worktime) {
    const names = [...state.worktime.shifts.map((x) => x.name), 'Overtime'];
    if (value && !names.includes(value)) names.push(value);
    return h('select', attrs, names.map((o) => h('option', { value: o, selected: o === (value || names[0]) }, o)));
  }
  if (field.type === 'ref') {
    const opts = await refOptions(field.ref);
    return h('select', attrs, h('option', { value: '' }, ''),
      opts.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));
  }
  return h('input', { ...attrs, type: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'time' ? 'time' : 'text',
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
// Lists split by the module's slicers (project, machine, type...): one chip row per slicer,
// and while the first slicer shows "All", rows are grouped under that slicer's values.
const NONE_LABEL = { project_id: 'No project', machine_id: 'No machine', nesting_id: 'No nesting' };
function slicerValue(field, r) {
  const v = field.type === 'ref' ? r[`${field.name}__label`] : r[field.name];
  return v === null || v === undefined || v === '' ? '' : String(v);
}

// Project slicer: one coloured bubble per project with its name and key facts.
let projCache = null;
const PROJ_COLOURS = ['var(--ring-1)', 'var(--ring-2)', 'var(--ring-3)', 'var(--ring-4)', 'var(--link)', 'var(--ok)'];
function projectOf(code) { return (projCache || []).find((p) => p.code === code); }
function projectColour(code) {
  const i = (projCache || []).map((p) => p.code).sort().indexOf(code);
  return i < 0 ? 'var(--muted)' : PROJ_COLOURS[i % PROJ_COLOURS.length];
}
const dot = (colour) => { const d = h('span', { class: 'pdot', 'aria-hidden': 'true' }); d.style.background = colour; return d; };
function projectBubble(code, n, on, onclick, noneText) {
  const p = projectOf(code);
  const b = h('button', { type: 'button', class: `pbub${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick },
    dot(code ? projectColour(code) : 'var(--muted)'),
    h('span', { class: 'pbub-t' }, h('strong', {}, code || noneText), p ? h('span', { class: 'pbub-name' }, p.name) : null,
      p ? h('small', {}, [p.customer, p.due_date ? `due ${fmtDate(p.due_date)}` : null, p.status].filter(Boolean).join(' · ')) : null),
    h('span', { class: 'n' }, n));
  b.style.setProperty('--pc', code ? projectColour(code) : 'var(--muted)');
  return b;
}
function projectPanel(code, n) {
  const p = projectOf(code);
  if (!p) return null;
  const left = p.due_date ? daysBetweenIso(localToday(), p.due_date) : null;
  const fact = (l, v) => h('div', { class: 'pinfo-f' }, h('small', {}, l), h('strong', {}, v || '—'));
  const panel = h('div', { class: 'pinfo' },
    h('div', { class: 'pinfo-h' }, dot(projectColour(code)), h('strong', {}, `${p.code} · ${p.name}`), pill(p.status), h('span', { class: 'grow' }),
      h('a', { class: 'btn small', href: `#/project/${p.id}` }, 'Open project')),
    h('div', { class: 'pinfo-g' }, fact('Customer', p.customer), fact('Work order', p.work_order), fact('Start', fmtDate(p.start_date)),
      fact('Due', p.due_date ? `${fmtDate(p.due_date)}${left !== null ? ` (${left >= 0 ? `${left} day(s) left` : `${-left} day(s) late`})` : ''}` : ''),
      fact('Records here', fmtNum(n))));
  panel.style.setProperty('--pc', projectColour(code));
  return panel;
}
const daysBetweenIso = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function recordTable(resName, { filter = {}, extra = [], rowActions, columns, onRow, slicerSlot, noneLabel, onLoad, skipSlicers = [] } = {}) {
  const res = state.meta.resources[resName];
  const allFields = res.fields.filter((f) => f.list !== false && (!columns || columns.includes(f.name)));
  // Sections split the columns into separate tables, one kind of information per tab.
  const sections = !columns && res.sections ? [...res.sections, { label: 'All columns', fields: allFields.map((f) => f.name) }] : null;
  const tabKey = `sec:${resName}`;
  let tab = 0;
  try { tab = Math.min(Number(localStorage.getItem(tabKey)) || 0, sections ? sections.length - 1 : 0); } catch {}
  let fields = allFields;
  const tabBar = h('div', { class: 'sec-tabs', role: 'tablist', 'aria-label': `${res.label} sections` });
  function pickSection(i) {
    tab = i;
    try { localStorage.setItem(tabKey, String(i)); } catch {}
    const names = sections[i].fields;
    fields = names.map((n) => res.fields.find((f) => f.name === n)).filter((f) => f && !f.hidden);
    tabBar.replaceChildren(...sections.map((sec, j) => h('button', { type: 'button', role: 'tab', class: `sec-tab${j === i ? ' on' : ''}`, 'aria-selected': String(j === i),
      onclick: () => { pickSection(j); draw(); } }, sec.label, h('span', { class: 'n' }, sec.fields.length))));
  }
  if (sections) pickSection(tab);
  const slicers = (res.slicers || []).filter((n) => !(n in filter) && !skipSlicers.includes(n)).map((n) => res.fields.find((f) => f.name === n)).filter(Boolean);
  const picked = {};
  const wrap = h('div');
  const search = h('input', { type: 'search', placeholder: `Search ${res.label.toLowerCase()}…` });
  const tableBox = h('div', { class: 'table-wrap' });
  const count = h('span', { class: 'muted' });
  const slicerBox = h('div', { class: 'slicers' });
  let rows = [];
  const none = (f) => (noneLabel && noneLabel[f.name]) || NONE_LABEL[f.name] || 'Not set';

  function drawSlicers() {
    slicerBox.replaceChildren(...slicers.map((f) => {
      // Counts follow the other slicers, so the numbers always add up to what is shown.
      const base = rows.filter((r) => slicers.every((g) => g === f || picked[g.name] === undefined || slicerValue(g, r) === picked[g.name]));
      const counts = new Map();
      for (const r of base) { const v = slicerValue(f, r); counts.set(v, (counts.get(v) || 0) + 1); }
      const values = [...counts.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, undefined, { numeric: true }));
      const chip = (v, label, n) => h('button', { type: 'button', class: `chip${picked[f.name] === v ? ' on' : ''}`, 'aria-pressed': String(picked[f.name] === v),
        onclick: () => { if (v === undefined || picked[f.name] === v) delete picked[f.name]; else picked[f.name] = v; draw(); } },
        label, h('span', { class: 'n' }, n));
      if (f.name === 'project_id' && projCache) {
        const toggle = (v) => () => { if (v === undefined || picked[f.name] === v) delete picked[f.name]; else picked[f.name] = v; draw(); };
        return h('div', { class: 'slicer proj', role: 'group', 'aria-label': `Filter by ${f.label}` },
          h('span', { class: 'slicer-l' }, f.label),
          h('div', { class: 'pbubs' }, chip(undefined, 'All projects', base.length),
            values.map((v) => projectBubble(v, counts.get(v), picked[f.name] === v, toggle(v), none(f)))),
          picked[f.name] ? projectPanel(picked[f.name], counts.get(picked[f.name]) || 0) : null);
      }
      return h('div', { class: 'slicer', role: 'group', 'aria-label': `Filter by ${f.label}` },
        h('span', { class: 'slicer-l' }, f.label),
        h('div', { class: 'chips' }, chip(undefined, 'All', base.length), values.map((v) => chip(v, v || none(f), counts.get(v)))));
    }));
    slicerBox.hidden = !slicers.length || !rows.length;
  }

  function draw() {
    drawSlicers();
    const shown = rows.filter((r) => slicers.every((g) => picked[g.name] === undefined || slicerValue(g, r) === picked[g.name]));
    count.textContent = `${shown.length} record${shown.length === 1 ? '' : 's'}`;
    if (!shown.length) { tableBox.replaceChildren(h('div', { class: 'empty' }, rows.length ? 'Nothing matches this selection.' : 'No records yet.')); return; }
    const span = fields.length + (rowActions ? 1 : 0);
    const line = (r) => h('tr', { class: 'click', onclick: () => (onRow ? onRow(r, load) : editRecord(resName, r, null, load)) },
      fields.map((f) => h('td', { class: f.type === 'number' ? 'num' : f.type === 'textarea' ? 'long' : '' }, cellValue(f, r))),
      rowActions ? h('td', { onclick: (e) => e.stopPropagation() }, rowActions(r, load)) : null);
    const g = slicers[0];
    let body;
    if (g && picked[g.name] === undefined) {
      const groups = new Map();
      for (const r of shown) { const v = slicerValue(g, r); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(r); }
      const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, undefined, { numeric: true }));
      const isProj = g.name === 'project_id' && projCache;
      body = keys.map((k) => [h('tr', { class: 'group' }, h('td', { colspan: span }, isProj ? dot(k ? projectColour(k) : 'var(--muted)') : null, h('strong', {}, k || none(g)),
        isProj && projectOf(k) ? h('span', {}, ` · ${projectOf(k).name}`) : null, h('span', { class: 'muted' }, ` · ${groups.get(k).length}`))),
        groups.get(k).map(line)]);
    } else body = shown.map(line);
    tableBox.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, fields.map((f) => h('th', {}, f.label)), rowActions ? h('th', {}, '') : null)),
      h('tbody', {}, body)));
  }

  async function load() {
    const qs = new URLSearchParams({ ...filter, ...(search.value ? { q: search.value } : {}) });
    try {
      if (!projCache && slicers.some((f) => f.name === 'project_id')) projCache = await api('GET', '/api/projects').catch(() => null);
      rows = await api('GET', `/api/${resName}?${qs}`); draw(); if (onLoad) onLoad(rows); }
    catch (e) { tableBox.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
  }
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

  if (slicerSlot) slicerSlot.append(slicerBox); else wrap.append(slicerBox);
  wrap.append(h('div', { class: 'toolbar' },
    search, count, h('span', { class: 'grow' }),
    extra,
    right(resName, 'create') && !res.noCreate ? [
      h('a', { class: 'btn', href: `/api/${resName}/template.xlsx`, title: 'Excel template with a guide sheet' }, 'Template'),
      h('button', { class: 'btn', onclick: () => templateImportDialog(resName, load) }, 'Import template')] : null,
    right(resName, 'export') ? h('a', { class: 'btn', href: `/api/${resName}/export.xlsx?${new URLSearchParams(filter)}` }, 'Export Excel') : null,
    right(resName, 'export') ? h('a', { class: 'btn', href: `/api/${resName}/export.csv?${new URLSearchParams(filter)}` }, 'CSV') : null,
    right(resName, 'create') && !res.noCreate ? h('button', { class: 'btn primary', onclick: () => (onRow ? onRow(null, load) : editRecord(resName, null, { ...filter, ...presetFromSlicers() }, load)) }, `+ New ${res.singular}`) : null),
    ...(sections ? [tabBar] : []), tableBox);
  // A new record starts in the project or machine picked on the slicer.
  function presetFromSlicers() {
    const out = {};
    for (const f of slicers) {
      if (!picked[f.name]) continue;
      const r = rows.find((x) => slicerValue(f, x) === picked[f.name]);
      if (r) out[f.name] = r[f.name];
    }
    return out;
  }
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

// Dashboard layout: "classic" tables or the "cockpit" cards. Remembered on this PC only.
function dashMode() {
  try { const m = localStorage.getItem('smm-dash'); if (m) return m; } catch (e) { /* storage blocked */ }
  return state.user.theme === 'galaxy' ? 'cockpit' : state.user.theme === 'kit' ? 'kit' : 'classic';
}
function viewSwitch() {
  const mode = dashMode();
  const pick = (m) => { try { localStorage.setItem('smm-dash', m); } catch (e) { /* storage blocked */ } route(); };
  return h('div', { class: 'view-switch', role: 'group', 'aria-label': 'Dashboard layout' },
    [['cockpit', 'Cockpit'], ['kit', 'Kit'], ['classic', 'Classic']].map(([m, l]) => h('button', { type: 'button', class: mode === m ? 'on' : '', 'aria-pressed': String(mode === m), onclick: () => pick(m) }, l)));
}

// A bubble for any slicer: colour, title, two lines of detail and a value.
function bubble({ title, sub, small, colour, n }, on, onclick) {
  const b = h('button', { type: 'button', class: `pbub${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick },
    dot(colour), h('span', { class: 'pbub-t' }, h('strong', {}, title), sub ? h('span', { class: 'pbub-name' }, sub) : null, small ? h('small', {}, small) : null),
    n !== undefined ? h('span', { class: 'n' }, n) : null);
  b.style.setProperty('--pc', colour);
  return b;
}
const PROC_COLOURS = ['var(--ring-3)', 'var(--ring-2)', 'var(--ring-4)', 'var(--ring-1)', 'var(--link)', 'var(--ok)'];

// Production by process: bubbles pick a process; "All" compares processes, one process shows each project.
function processCard(processes, minutesPerDay, cardClass) {
  const card = h('section', { class: cardClass });
  let pick = '';
  try { pick = localStorage.getItem('smm-dash-proc') || ''; } catch (e) { /* storage blocked */ }
  const colour = (name) => PROC_COLOURS[Math.max(0, processes.findIndex((x) => x.name === name)) % PROC_COLOURS.length];
  function draw() {
    const p = processes.find((x) => x.name === pick);
    if (!p) pick = '';
    const set = (name) => () => { pick = pick === name ? '' : name; try { localStorage.setItem('smm-dash-proc', pick); } catch (e) { /* storage blocked */ } draw(); };
    const bubbles = h('div', { class: 'pbubs' },
      h('button', { type: 'button', class: `chip${!pick ? ' on' : ''}`, 'aria-pressed': String(!pick), onclick: set('') }, 'All processes', h('span', { class: 'n' }, processes.length)),
      processes.map((x) => bubble({ title: x.name, small: `${fmtNum(x.remaining_days)} day(s) left${x.bottleneck ? ' · bottleneck' : ''}`, colour: colour(x.name), n: fmtPct(x.completion) }, pick === x.name, set(x.name))));
    let chart;
    if (!p) {
      chart = processes.length ? h('div', { class: 'hbars', role: 'list' }, processes.map((x) => {
        const fill = h('div', { class: 'hbar-f' }); fill.style.width = `${Math.min(100, x.completion)}%`; fill.style.background = colour(x.name);
        return h('button', { type: 'button', class: 'hbar', role: 'listitem', onclick: set(x.name), 'aria-label': `${x.name} ${fmtPct(x.completion)}` },
          h('div', { class: 'hbar-l' }, dot(colour(x.name)), h('strong', {}, x.name, x.bottleneck ? [' ', h('span', { class: 'pill bad' }, 'Bottleneck')] : null), h('small', {}, `${x.steps} routing step(s)`)),
          h('div', { class: 'hbar-t' }, fill),
          h('div', { class: 'hbar-v' }, h('strong', {}, fmtPct(x.completion)), h('small', {}, `${fmtNum(x.good)}/${fmtNum(x.target)} pcs · ${fmtNum(x.remaining_days)}d left`)));
      })) : h('div', { class: 'empty' }, 'No Job Traveller routing yet.');
    } else {
      const projs = p.projects || [];
      const stat = (l, v) => h('div', {}, h('small', {}, l), h('strong', {}, v));
      chart = [h('div', { class: 'pstats' },
        stat('Completion', fmtPct(p.completion)), stat('Good / target', `${fmtNum(p.good)} / ${fmtNum(p.target)} pcs`), stat('Reject', fmtNum(p.reject)),
        stat('Yield', fmtPct(p.yield)), stat('Work left', `${fmtNum(p.remaining_min / 60, 1)} h · ${fmtNum(p.remaining_days)} day(s)`),
        p.bottleneck ? h('div', {}, h('small', {}, 'Flow'), h('span', { class: 'pill bad' }, 'Bottleneck')) : null),
      projs.length ? h('div', { class: 'vchart', role: 'img', 'aria-label': projs.map((x) => `${x.code} ${fmtPct(x.completion)}`).join(', ') },
        h('div', { class: 'vgrid', 'aria-hidden': 'true' }, ['100%', '75%', '50%', '25%', '0%'].map((t) => h('span', {}, t))),
        h('div', { class: 'vcols' }, projs.map((x) => {
          const bar = h('div', { class: 'vbar' }); bar.style.height = `${Math.min(100, x.completion)}%`; bar.style.background = projectColour(x.code);
          return h('div', { class: 'vcol' }, h('div', { class: 'vval' }, fmtPct(x.completion)), h('div', { class: 'vtrack' }, bar),
            h('div', { class: 'vlab' }, h('strong', {}, x.code), h('small', {}, `${fmtNum(x.good)}/${fmtNum(x.target)}${x.reject ? ` · ${fmtNum(x.reject)} rej` : ''}`)));
        }))) : h('div', { class: 'empty' }, 'No project has routing at this process.')];
    }
    card.replaceChildren(
      h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('pulse')), h('h2', {}, p ? `Production by process · ${p.name}` : `Production by process`),
        h('span', { class: 'muted small' }, `net ${minutesPerDay} min/day`)),
      h('div', { class: 'slicer proj' }, h('span', { class: 'slicer-l' }, 'Process'), bubbles), ...[chart].flat().filter(Boolean));
  }
  draw();
  return card;
}

// Gantt chart of schedule lines. With no project picked, each project is one bar from first start to last end.
function gantt(lines, { project, progress = [], onPick } = {}) {
  const today = localToday();
  const rows = project ? lines.filter((l) => l.project === project).map((l) => ({
    key: l.id, label: l.process, sub: [l.machine, l.planned_qty ? `${fmtNum(l.planned_qty)} pcs` : null].filter(Boolean).join(' · '),
    start: l.start_date, end: l.end_date, colour: projectColour(l.project), status: l.status,
    done: ((progress.find((p) => p.code === l.project) || { processes: [] }).processes.find((x) => x.name === l.process) || {}).completion || 0,
  })) : [...new Set(lines.map((l) => l.project))].map((code) => {
    const ls = lines.filter((l) => l.project === code);
    return { key: code, label: code, sub: (projectOf(code) || {}).name || '', start: ls.reduce((a, l) => (l.start_date < a ? l.start_date : a), ls[0].start_date),
      end: ls.reduce((a, l) => (l.end_date > a ? l.end_date : a), ls[0].end_date), colour: projectColour(code), status: `${ls.length} line(s)`,
      done: (progress.find((p) => p.code === code) || {}).completion || 0, pick: code };
  });
  if (!rows.length) return h('div', { class: 'empty' }, project ? 'Nothing planned for this project yet.' : 'No schedule yet. The Planner makes it on the Production schedule page.');
  let from = rows.reduce((a, r) => (r.start < a ? r.start : a), today), to = rows.reduce((a, r) => (r.end > a ? r.end : a), today);
  from = addDays(from, -1); to = addDays(to, 1);
  const span = daysBetween(from, to) + 1;
  const pos = (iso) => (daysBetween(from, iso) / span) * 100;
  const ticks = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (span <= 21 || new Date(`${d}T00:00:00Z`).getUTCDay() === 1) ticks.push(d);
  const axis = h('div', { class: 'g-axis' }, ticks.map((d) => { const t = h('span', {}, `${d.slice(8)}/${d.slice(5, 7)}`); t.style.left = `${pos(d)}%`; return t; }));
  const todayLine = () => { const t = h('div', { class: 'g-today', title: `Today ${fmtDate(today)}` }); t.style.left = `${pos(today)}%`; return t; };
  const gridLines = () => ticks.map((d) => { const l = h('span', { class: 'g-line', 'aria-hidden': 'true' }); l.style.left = `${pos(d)}%`; return l; });
  return h('div', { class: 'gantt' },
    h('div', { class: 'g-row g-head' }, h('div', { class: 'g-lab' }), h('div', { class: 'g-track' }, axis)),
    rows.map((r) => {
      const bar = h(r.pick && onPick ? 'button' : 'div', { class: 'g-bar', type: r.pick && onPick ? 'button' : null, onclick: r.pick && onPick ? () => onPick(r.pick) : null,
        title: `${r.label}: ${fmtDate(r.start)} to ${fmtDate(r.end)} · ${fmtPct(r.done)} done` },
        h('span', { class: 'g-fill' }), h('span', { class: 'g-txt' }, `${fmtDate(r.start).slice(0, 5)}–${fmtDate(r.end).slice(0, 5)} · ${fmtPct(r.done)}`));
      bar.style.left = `${pos(r.start)}%`; bar.style.width = `${Math.max(1.5, ((daysBetween(r.start, r.end) + 1) / span) * 100)}%`;
      bar.style.setProperty('--pc', r.colour); bar.firstChild.style.width = `${Math.min(100, r.done)}%`;
      const late = r.end < today && r.done < 100;
      return h('div', { class: 'g-row' }, h('div', { class: 'g-lab' }, dot(r.colour), h('strong', {}, r.label), r.sub ? h('small', {}, r.sub) : null,
        late ? h('span', { class: 'pill bad' }, 'Late') : r.status && STATUS_CLASS[r.status] !== undefined ? pill(r.status) : null),
        h('div', { class: 'g-track' }, gridLines(), todayLine(), bar));
    }),
    h('div', { class: 'g-key muted small' }, h('span', { class: 'g-today-key' }), ' Today · filled part of a bar = work done'));
}

// Dashboard card: schedule by project, with the project bubbles.
function scheduleCard(lines, progress, cardClass) {
  const card = h('section', { class: cardClass });
  let pick = '';
  try { pick = localStorage.getItem('smm-dash-plan') || ''; } catch (e) { /* storage blocked */ }
  const codes = [...new Set(lines.map((l) => l.project))];
  function draw() {
    if (!codes.includes(pick)) pick = '';
    const set = (code) => { pick = pick === code ? '' : code; try { localStorage.setItem('smm-dash-plan', pick); } catch (e) { /* storage blocked */ } draw(); };
    const late = (code) => lines.filter((l) => l.project === code && l.end_date < localToday() && l.status !== 'Done').length;
    card.replaceChildren(
      h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('gantt')), h('h2', {}, pick ? `Schedule · ${pick}` : 'Schedule by project'), h('a', { href: '#/plan' }, 'Production schedule')),
      codes.length ? h('div', { class: 'slicer proj' }, h('span', { class: 'slicer-l' }, 'Project'), h('div', { class: 'pbubs' },
        h('button', { type: 'button', class: `chip${!pick ? ' on' : ''}`, 'aria-pressed': String(!pick), onclick: () => set('') }, 'All projects', h('span', { class: 'n' }, codes.length)),
        codes.map((c) => projectBubble(c, late(c) ? `${late(c)} late` : `${lines.filter((l) => l.project === c).length} lines`, pick === c, () => set(c))))) : null,
      gantt(lines, { project: pick || null, progress, onPick: set }));
  }
  draw();
  return card;
}

// Project progress chart: bubbles pick a project; "All" compares projects, one project shows each process.
function projectProgressCard(list, cardClass) {
  const card = h('section', { class: cardClass });
  let pick = '';
  try { pick = localStorage.getItem('smm-dash-proj') || ''; } catch (e) { /* storage blocked */ }
  projCache = list;
  function draw() {
    const p = list.find((x) => x.code === pick);
    if (!p) pick = '';
    const set = (code) => () => { pick = pick === code ? '' : code; try { localStorage.setItem('smm-dash-proj', pick); } catch (e) { /* storage blocked */ } draw(); };
    const bubbles = h('div', { class: 'pbubs' },
      h('button', { type: 'button', class: `chip${!pick ? ' on' : ''}`, 'aria-pressed': String(!pick), onclick: set('') }, 'All projects', h('span', { class: 'n' }, list.length)),
      list.map((x) => projectBubble(x.code, fmtPct(x.completion), pick === x.code, set(x.code))));
    let chart;
    if (!p) {
      chart = list.length ? h('div', { class: 'hbars', role: 'list' }, list.map((x) => {
        const fill = h('div', { class: 'hbar-f' }); fill.style.width = `${Math.min(100, x.completion)}%`; fill.style.background = projectColour(x.code);
        const left = x.due_date ? daysBetweenIso(localToday(), x.due_date) : null;
        return h('button', { type: 'button', class: 'hbar', role: 'listitem', onclick: set(x.code), 'aria-label': `${x.code} ${fmtPct(x.completion)}` },
          h('div', { class: 'hbar-l' }, dot(projectColour(x.code)), h('strong', {}, x.code), h('small', {}, x.name)),
          h('div', { class: 'hbar-t' }, fill),
          h('div', { class: 'hbar-v' }, h('strong', {}, fmtPct(x.completion)), h('small', {}, `${fmtNum(x.good)}/${fmtNum(x.target)} pcs${left !== null ? ` · ${left >= 0 ? `${left}d left` : `${-left}d late`}` : ''}`)));
      })) : h('div', { class: 'empty' }, 'No projects yet.');
    } else {
      const cols = p.processes.length ? h('div', { class: 'vchart', role: 'img', 'aria-label': p.processes.map((x) => `${x.name} ${fmtPct(x.completion)}`).join(', ') },
        h('div', { class: 'vgrid', 'aria-hidden': 'true' }, ['100%', '75%', '50%', '25%', '0%'].map((t) => h('span', {}, t))),
        h('div', { class: 'vcols' }, p.processes.map((x) => {
          const bar = h('div', { class: 'vbar' }); bar.style.height = `${Math.min(100, x.completion)}%`; bar.style.background = projectColour(p.code);
          return h('div', { class: 'vcol' }, h('div', { class: 'vval' }, fmtPct(x.completion)), h('div', { class: 'vtrack' }, bar),
            h('div', { class: 'vlab' }, h('strong', {}, x.name), h('small', {}, `${fmtNum(x.good)}/${fmtNum(x.target)}`)));
        }))) : h('div', { class: 'empty' }, 'No Job Traveller routing for this project yet.');
      const jt = Object.entries(p.job_travellers || {});
      chart = [projectPanel(p.code, Object.values(p.job_travellers || {}).reduce((a, b) => a + b, 0)),
        h('div', { class: 'pstats' },
          h('div', {}, h('small', {}, 'Overall'), h('strong', {}, fmtPct(p.completion))),
          h('div', {}, h('small', {}, 'Good / target'), h('strong', {}, `${fmtNum(p.good)} / ${fmtNum(p.target)} pcs`)),
          h('div', {}, h('small', {}, 'Job Travellers'), h('span', {}, jt.length ? jt.map(([st, n]) => [pill(st), ` ${n} `]) : '—'))),
        cols];
    }
    card.replaceChildren(
      h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('folder')), h('h2', {}, p ? `Project progress · ${p.code}` : 'Project progress'),
        h('a', { href: '#/r/job_travellers' }, 'Job Travellers')),
      h('div', { class: 'slicer proj' }, h('span', { class: 'slicer-l' }, 'Project'), bubbles), ...[chart].flat().filter(Boolean));
    // The panel's records label counts Job Travellers here.
    card.querySelectorAll('.pinfo-f small').forEach((el) => { if (el.textContent === 'Records here') el.textContent = 'Job Travellers'; });
  }
  draw();
  return card;
}

async function viewDashboard() {
  const d = await api('GET', '/api/dashboard');
  projCache = d.projectProgress;
  // Today's hourly output, this month's actual output and the working time, for every layout.
  const today = localToday();
  const [hourly, actual, wt] = await Promise.all([`/api/reports/hourly?date=${today}`, `/api/reports/actual?from=${today.slice(0, 8)}01&to=${today}`, '/api/worktime']
    .map((u) => api('GET', u).catch(() => null)));
  d.live = { today, hourly, actual, wt };
  if (dashMode() === 'cockpit') return viewCockpit(d);
  if (dashMode() === 'kit') return viewKit(d);
  const k = d.kpi, pr = d.production;
  const stat = (ic, value, label, note, tone) => h('div', { class: `stat ${tone || ''}` }, h('span', { class: 'stat-i' }, icon(ic)),
    h('div', {}, h('div', { class: 'stat-n' }, value), h('div', { class: 'stat-l' }, label), note ? h('div', { class: 'stat-s' }, note) : null));
  const dcard = (title, ic, body, link, wide) => h('section', { class: `dcard${wide ? ' wide' : ''}` },
    h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon(ic)), h('h2', {}, title), link ? h('a', { href: link[0] }, link[1]) : null), body);
  const table = (heads, rows, nums = []) => h('div', { class: 'table-wrap flat' }, h('table', {},
    h('thead', {}, h('tr', {}, heads.map((t, i) => h('th', { class: nums.includes(i) ? 'num' : '' }, t)))),
    h('tbody', {}, rows)));
  const empty = (t) => h('div', { class: 'empty' }, t);
  return [
    pageHead('Dashboard', 'grid', `${fmtDate(localToday())} · net ${d.minutesPerDay} working min/day`, viewSwitch()),
    h('div', { class: 'stat-grid' },
      stat('pulse', fmtPct(pr.completion), 'Overall completion', `${fmtNum(pr.good)} of ${fmtNum(pr.target)} pcs`, 't1'),
      stat('check', fmtPct(pr.yield), 'First-pass yield', `${fmtNum(pr.reject)} rejected`, 't2'),
      stat('clock', fmtNum(pr.remaining_min / 60, 1), 'Hours of work left', `${fmtNum(pr.balance)} pcs to make`, 't3'),
      stat('folder', fmtNum(k.active_projects), 'Active projects', `${fmtNum(k.parts)} parts`, 't4'),
      stat('chat', fmtNum(k.open_issues), 'Open issues', `${fmtNum(k.open_ncrs)} open NCR`, k.open_issues ? 'alert' : 't2'),
      stat('gear', fmtNum(k.machines_down), 'Machines down', `${fmtNum(k.open_work_orders)} open maintenance`, k.machines_down ? 'alert' : 't2')),
    h('div', { class: 'dgrid' },
      todayCard(d.live, 'dcard'),
      monthCard(d.live, 'dcard'),
      projectProgressCard(d.projectProgress, 'dcard wide'),
      processCard(d.processes, d.minutesPerDay, 'dcard wide'),
      scheduleCard(d.schedules, d.projectProgress, 'dcard wide'),
      dcard('Projects', 'folder', d.projects.length ? table(['Project', 'Due', 'Status', 'Progress'], d.projects.map((p) => {
        const pct = p.steps ? Math.round((p.steps_done / p.steps) * 100) : 0;
        const bar = h('div'); bar.style.width = `${pct}%`;
        return h('tr', { class: 'click', onclick: () => { location.hash = `#/project/${p.id}`; } },
          h('td', {}, h('strong', {}, p.code), h('div', { class: 'muted small' }, p.name)), h('td', {}, fmtDate(p.due_date)), h('td', {}, pill(p.status)),
          h('td', {}, h('div', { class: 'bar', title: `${p.steps_done}/${p.steps} steps` }, bar), ` ${pct}%`));
      })) : empty('No active projects.'), ['#/r/projects', 'All projects']),
      dcard('Plate stock by project', 'layers', d.plates.length ? table(['Project', 'Materials', 'Sizes', 'Sheets', 'Stock'], d.plates.map((p) =>
        h('tr', { class: 'click', onclick: () => { location.hash = '#/r/plates'; } },
          h('td', {}, h('strong', {}, p.project), p.name ? h('div', { class: 'muted small' }, p.name) : null), h('td', {}, p.materials || ''),
          h('td', { class: 'num' }, p.sizes), h('td', { class: 'num' }, fmtNum(p.sheets)), h('td', {}, pill(p.low ? 'Low' : 'OK'), p.low ? ` ${p.low} size(s)` : ''))), [2, 3]) :
        empty('No plates recorded.'), ['#/r/plates', 'Plate stock']),
      dcard('Open issues', 'chat', d.issues.length ? table(['Issue', 'From → To', 'Status'], d.issues.slice(0, 8).map((i) =>
        h('tr', { class: 'click', onclick: () => { location.hash = `#/issue/${i.id}`; } }, h('td', {}, h('strong', {}, i.title), h('div', { class: 'muted small' }, `${i.issue_no} · ${i.priority}`)),
          h('td', {}, `${i.from_process || ''} → ${i.to_process || ''}`), h('td', {}, pill(i.status))))) :
        empty('No open issues.'), ['#/r/issues', 'All issues']),
      dcard('Machines', 'gear', table(['Machine', 'Type', 'Status', 'Load (days)', 'Availability'], d.load.map((m) => {
        const dt = d.downtime.find((x) => x.code === m.code);
        return h('tr', {}, h('td', {}, h('strong', {}, m.code)), h('td', {}, m.machine_type || ''), h('td', {}, pill(m.status)),
          h('td', { class: 'num' }, fmtNum(m.load_days)), h('td', { class: 'num' }, dt ? `${dt.availability}%` : '—'));
      }), [3, 4]), ['#/r/machines', 'Machines']),
      dcard('Workflow board', 'flow', d.workflow.length ? table(['Part', 'Project', 'Now at', 'Flow'], d.workflow.map((w) => h('tr', {},
        h('td', {}, w.part_no), h('td', {}, w.project), h('td', {}, pill(w.current === 'Completed' ? 'Completed' : 'In progress'), ' ', w.current),
        h('td', {}, h('div', { class: 'flow' }, w.steps.map((s) => h('span', { class: s.status === 'Done' ? 'done' : s.step === w.current ? 'doing' : '' }, s.step))))))) :
        empty('No workflow yet. Open a part and choose "Create workflow".'), ['#/r/wf_steps', 'Workflow'], true),
      d.lowItems.length || d.lowStock.length ? dcard('To reorder', 'box', table(['Item', 'Where', 'On hand', 'Minimum', 'Stock'], [
        ...d.lowStock.map((p) => h('tr', {}, h('td', {}, `${p.material} ${fmtNum(p.thickness)} mm ${p.sheet_size || ''}`), h('td', {}, p.project),
          h('td', { class: 'num' }, fmtNum(p.qty)), h('td', { class: 'num' }, fmtNum(p.min_qty)), h('td', {}, pill(p.qty > 0 ? 'Low' : 'Out')))),
        ...d.lowItems.map((i) => h('tr', {}, h('td', {}, `${i.code} ${i.name}`), h('td', {}, i.location || i.item_group),
          h('td', { class: 'num' }, `${fmtNum(i.qty_on_hand)} ${i.unit || ''}`), h('td', { class: 'num' }, fmtNum(i.min_qty)), h('td', {}, pill(i.status))))], [2, 3]),
        ['#/r/inventory_items', 'Inventory'], true) : null),
  ];
}

// ---------- Planner: production schedule ----------------------------------------

async function viewPlan() {
  const [lines, projects, dash] = await Promise.all([api('GET', '/api/schedules'), api('GET', '/api/projects'), api('GET', '/api/dashboard')]);
  projCache = projects;
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const pick = qs.get('project') || '';
  const flat = lines.map((l) => ({ id: l.id, project: l.project_id__label, process: l.process_id__label, machine: l.machine_id__label,
    start_date: l.start_date, end_date: l.end_date, planned_qty: l.planned_qty, status: l.status }));
  const head = pageHead('Production schedule', 'gantt', 'Planner plans when each process works on each project');
  const codes = projects.filter((p) => !['Completed', 'Cancelled'].includes(p.status)).map((p) => p.code);
  const go = (code) => { location.hash = code && code !== pick ? `#/plan?project=${encodeURIComponent(code)}` : '#/plan'; };
  head.append(h('div', { class: 'slicers' }, h('div', { class: 'slicer proj' }, h('span', { class: 'slicer-l' }, 'Project'),
    h('div', { class: 'pbubs' }, h('button', { type: 'button', class: `chip${!pick ? ' on' : ''}`, onclick: () => go('') }, 'All projects', h('span', { class: 'n' }, codes.length)),
      codes.map((c) => projectBubble(c, `${flat.filter((l) => l.project === c).length} lines`, pick === c, () => go(c)))),
    pick ? projectPanel(pick, flat.filter((l) => l.project === pick).length) : null)));
  const pickProject = projects.find((p) => p.code === pick);
  let tools = null;
  if (right('schedules', 'create')) {
    const projSel = h('select', { 'aria-label': 'Project to plan' }, projects.filter((p) => !['Completed', 'Cancelled'].includes(p.status)).map((p) =>
      h('option', { value: p.id, selected: pickProject && p.id === pickProject.id }, `${p.code} · ${p.name}`)));
    const startIn = h('input', { type: 'date', value: localToday(), 'aria-label': 'Plan start date' });
    tools = h('div', { class: 'panel plan-tools' },
      h('div', {}, h('strong', {}, 'Auto plan from Job Traveller routing'),
        h('p', { class: 'muted small' }, 'Makes one line per process. Days = work left (pcs × cycle time ÷ 465 min), at least 1. Each process starts one working day after the one before. Sundays are off. Lines you entered yourself are kept; you can move any line after.')),
      h('div', { class: 'plan-row' }, projSel, startIn, h('button', { class: 'btn primary', onclick: async () => {
        try { const r = await api('POST', '/api/schedules/auto', { project_id: Number(projSel.value), start_date: startIn.value }); toast(`${r.filter((x) => x.source === 'Auto plan').length} line(s) planned`); route(); }
        catch (e) { toast(e.message, true); }
      } }, 'Auto plan')));
  }
  const table = recordTable('schedules', { filter: pickProject ? { project_id: pickProject.id } : {}, skipSlicers: ['project_id'] });
  return [head, tools,
    h('section', { class: 'dcard gap-top' }, h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('gantt')), h('h2', {}, pick ? `Timeline · ${pick}` : 'Timeline, all projects')),
      gantt(flat, { project: pick || null, progress: dash.projectProgress, onPick: go })),
    h('h2', {}, 'Schedule lines'), table];
}

// ---------- Supervisor: operator roster ------------------------------------------

async function viewRoster() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const base = qs.get('week') || localToday();
  const dow = (new Date(`${base}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(base, -dow);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const [all, procs] = await Promise.all([api('GET', '/api/shift_plans'), api('GET', '/api/shop_processes')]);
  const proc = qs.get('process') || '';
  const week = all.filter((r) => r.date >= days[0] && r.date <= days[6] && (!proc || String(r.process_id) === proc));
  const operators = [...new Set(all.map((r) => r.operator))].sort();
  const go = (ch) => { const n = new URLSearchParams({ week: monday, ...(proc ? { process: proc } : {}), ...ch }); for (const [k, v] of [...n]) if (!v) n.delete(k); location.hash = `#/roster?${n}`; };
  const canPlan = right('shift_plans', 'create');
  const add = (date, operator) => editRecord('shift_plans', null, { date, operator, ...(proc ? { process_id: Number(proc) } : {}) }, () => route());

  const head = pageHead('Operator roster', 'users', `Week of ${fmtDate(days[0])} to ${fmtDate(days[6])}`,
    h('button', { class: 'btn', onclick: () => go({ week: addDays(monday, -7) }) }, '‹ Previous week'),
    h('button', { class: 'btn', onclick: () => go({ week: localToday() }) }, 'This week'),
    h('button', { class: 'btn', onclick: () => go({ week: addDays(monday, 7) }) }, 'Next week ›'));
  const inWeek = all.filter((r) => r.date >= days[0] && r.date <= days[6]);
  head.append(h('div', { class: 'slicers' }, h('div', { class: 'slicer' }, h('span', { class: 'slicer-l' }, 'Process'),
    h('div', { class: 'chips' }, h('button', { type: 'button', class: `chip${!proc ? ' on' : ''}`, onclick: () => go({ process: '' }) }, 'All', h('span', { class: 'n' }, inWeek.length)),
      procs.map((p) => h('button', { type: 'button', class: `chip${proc === String(p.id) ? ' on' : ''}`, onclick: () => go({ process: proc === String(p.id) ? '' : String(p.id) }) },
        p.name, h('span', { class: 'n' }, inWeek.filter((r) => r.process_id === p.id).length)))))));

  const today = localToday();
  const entry = (r) => h('button', { type: 'button', class: `ros-e shift-${String(r.shift || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, onclick: () => editRecord('shift_plans', r, null, () => route()),
    title: `${r.operator} · ${r.shift} · ${r.process_id__label}${r.machine_id__label ? ` · ${r.machine_id__label}` : ''}` },
    h('strong', {}, r.process_id__label), h('small', {}, [r.shift, r.machine_id__label, r.job_traveller_id__label].filter(Boolean).join(' · ')),
    r.planned_qty ? h('small', {}, `${fmtNum(r.planned_qty)} pcs · ${fmtNum(r.hours)} h`) : null);
  const people = proc ? [...new Set(week.map((r) => r.operator))].sort() : operators;
  const grid = people.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'roster' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Operator'), days.map((d) => h('th', { class: d === today ? 'today' : '' },
      new Date(`${d}T00:00:00Z`).toLocaleDateString('en-MY', { weekday: 'short', timeZone: 'UTC' }), h('br'), `${d.slice(8)}/${d.slice(5, 7)}`)))),
    h('tbody', {}, people.map((op) => h('tr', {}, h('th', {}, op), days.map((d) => {
      const es = week.filter((r) => r.operator === op && r.date === d);
      return h('td', { class: d === today ? 'today' : '' }, es.map(entry), canPlan ? h('button', { type: 'button', class: 'ros-add', 'aria-label': `Add ${op} on ${fmtDate(d)}`, onclick: () => add(d, op) }, '+') : null);
    })))),
    h('tfoot', {}, h('tr', {}, h('th', {}, 'Hours'), days.map((d) => h('td', { class: 'num' }, fmtNum(week.filter((r) => r.date === d).reduce((n, r) => n + (r.hours || 0), 0), 1))))))) :
    h('div', { class: 'empty' }, 'No operators planned yet. Press "+ Plan operator" to add the first one.');
  return [head,
    canPlan ? h('div', { class: 'toolbar' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => add(today >= days[0] && today <= days[6] ? today : days[0], '') }, '+ Plan operator')) : null,
    grid,
    h('p', { class: 'muted small' }, 'Click an entry to change it. Day, Night and Overtime shifts have their own colour.')];
}

// ---------- Admin: working time --------------------------------------------------

async function viewWorktime() {
  const wt = await api('GET', '/api/worktime');
  state.worktime = wt;
  const head = pageHead('Working time', 'clock', 'Shifts, working hours and holidays. Used by the hour slots, hourly output, dashboard and auto plan.');
  const stat = (ic, v, l, tone) => h('div', { class: `stat ${tone}` }, h('span', { class: 'stat-i' }, icon(ic)), h('div', {}, h('div', { class: 'stat-n' }, v), h('div', { class: 'stat-l' }, l)));
  const upcoming = wt.holidays.filter((x) => x.date >= localToday());
  const shiftCards = wt.shifts.map((sh) => h('section', { class: 'dcard' },
    h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('clock')), h('h2', {}, `${sh.name} shift`),
      h('span', { class: 'muted small' }, `${sh.start_time}–${sh.end_time}${sh.break_start ? ` · break ${sh.break_start}–${sh.break_end}` : ''} · ${sh.days}`)),
    h('div', { class: 'chips' }, sh.slots.map((x) => h('span', { class: 'chip static' }, x.label, h('span', { class: 'n' }, `${x.minutes}m`)))),
    h('p', { class: 'muted small' }, `${sh.slots.length} hour slots · ${sh.net_min} net minutes`)));
  const reload = () => { start().catch(() => route()); };
  return [head,
    h('div', { class: 'stat-grid' },
      stat('users', String(wt.shifts.length), 'Active shifts', 't1'),
      stat('clock', fmtNum(wt.minutes_per_day), 'Net minutes a day', 't2'),
      stat('cal', String(upcoming.length), 'Holidays ahead', 't3'),
      stat('flow', upcoming[0] ? fmtDate(upcoming[0].date) : '—', upcoming[0] ? `Next: ${upcoming[0].name}` : 'Next holiday', 't4')),
    h('div', { class: 'dgrid' }, shiftCards),
    h('h2', {}, 'Shifts'),
    h('p', { class: 'muted small' }, 'Add a shift for each working pattern (for example Day and Night). Set Active to No to stop using one. An end time before the start runs past midnight.'),
    recordTable('shifts', { onLoad: () => {} }),
    h('h2', {}, 'Holidays and leave'),
    recordTable('holidays'),
    h('div', { class: 'toolbar gap-top' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: reload }, 'Apply changes to this session'))];
}

// ---------- Admin: database & backup ---------------------------------------------

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function viewDatabase() {
  const d = await api('GET', '/api/database');
  const head = pageHead('Database & backup', 'db', `${d.name} · schema version ${d.schema_version}. Download a full backup or a SQL script for another database, and see the scheduled backups.`);
  const stat = (ic, v, l, tone) => h('div', { class: `stat ${tone}` }, h('span', { class: 'stat-i' }, icon(ic)), h('div', {}, h('div', { class: 'stat-n' }, v), h('div', { class: 'stat-l' }, l)));
  const rows = d.counts.reduce((n, c) => n + c.rows, 0);
  const sched = d.schedule;
  const busy = (btn, job) => async () => {
    btn.disabled = true;
    try { await job(); route(); } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
  const backupBtn = h('button', { class: 'btn primary' }, 'Backup now');
  backupBtn.onclick = busy(backupBtn, async () => { const r = await api('POST', '/api/database/backup'); toast(`Backup ${r.file} saved${r.uploaded ? ' and uploaded' : ''}`); });
  const bqBtn = h('button', { class: 'btn', disabled: !d.bigquery, title: d.bigquery ? '' : 'Set BIGQUERY_PROJECT and a service account key on the server' }, 'Export to BigQuery');
  bqBtn.onclick = busy(bqBtn, async () => { const r = await api('POST', '/api/database/bigquery'); toast(`${Object.keys(r.tables).length} tables sent to BigQuery`); });
  const card = (ic, title, ...body) => h('section', { class: 'dcard' }, h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon(ic)), h('h2', {}, title)), ...body);
  const lastLine = (x, what) => (x ? `${what}: ${x.at.slice(0, 16).replace('T', ' ')} UTC` : `${what}: not run since the server started`);
  return [head,
    h('div', { class: 'stat-grid' },
      stat('db', d.name, 'Database in use', 't1'),
      stat('list', fmtNum(rows), `Rows in ${d.counts.length} tables`, 't2'),
      stat('clock', sched.backup_hours ? `Every ${sched.backup_hours} h` : 'Off', 'Automatic backup', 't3'),
      stat('folder', d.storage || 'Data folder only', 'Backup storage', 't4')),
    h('div', { class: 'dgrid' },
      card('file', 'Download',
        h('p', { class: 'muted small' }, 'Full backup: every table, compressed, with row counts and a checksum. Load it with "import-backup" on any database.'),
        h('div', { class: 'toolbar' }, h('a', { class: 'btn primary', href: '/api/database/backup.json.gz' }, 'Backup file (.json.gz)')),
        h('p', { class: 'muted small' }, 'SQL script: builds the tables and adds every row, for the chosen database.'),
        h('div', { class: 'chips' }, d.sql_targets.map((t) => h('a', { class: 'chip', href: `/api/database/export.sql?dialect=${t.id}` }, t.name)))),
      card('clock', 'Backup and reporting',
        h('p', { class: 'muted small' }, `Keeps every backup for ${sched.keep_days} days, then one a month for ${sched.keep_months ? `${sched.keep_months} months` : 'ever'}.`),
        h('p', { class: 'muted small' }, lastLine(d.last.backup, 'Last backup')),
        h('p', { class: 'muted small' }, d.bigquery ? `BigQuery: ${d.bigquery}${sched.bigquery_hours ? `, every ${sched.bigquery_hours} h` : ', on request'}. ${lastLine(d.last.bigquery, 'Last export')}` : 'BigQuery is not set up.'),
        h('div', { class: 'toolbar' }, backupBtn, bqBtn))),
    h('h2', {}, 'Rows per table'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Table'), h('th', { class: 'num' }, 'Rows'))),
      h('tbody', {}, d.counts.map((c) => h('tr', {}, h('td', {}, (state.meta.resources[c.table] || {}).label || c.table), h('td', { class: 'num' }, fmtNum(c.rows))))))),
    h('h2', {}, 'Saved backups'),
    d.backups.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['File', 'Where', 'Size'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.backups.map((b) => (b.error ? h('tr', {}, h('td', { colspan: 3, class: 'wrap' }, `Storage could not be read: ${b.error}`))
        : h('tr', {}, h('td', {}, b.file), h('td', {}, b.where), h('td', { class: 'num' }, fmtSize(b.size)))))))) : h('div', { class: 'empty panel' }, 'No backups yet. Click Backup now, or wait for the automatic one.')];
}

// ---------- Hourly output (plan from the roster vs actual) ------------------------

const achieveTone = (p) => (p === null || p === undefined ? '' : p >= 95 ? 'ok' : p >= 80 ? 'warn' : 'bad');

async function viewHourly() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const date = qs.get('date') || localToday();
  const proc = qs.get('process') || '';
  const pick = qs.get('project') || '';
  const r = await api('GET', `/api/reports/hourly?date=${date}`);
  const projects = await api('GET', '/api/projects');
  projCache = projects;
  const go = (ch) => { const n = new URLSearchParams({ date, process: proc, project: pick, ...ch }); for (const [k, v] of [...n]) if (!v) n.delete(k); location.hash = `#/hourly?${n}`; };
  const dateIn = h('input', { type: 'date', value: date, 'aria-label': 'Date', onchange: (e) => go({ date: e.target.value }) });
  const head = pageHead('Hourly output', 'clock', 'Plan per hour from the Operator roster, actual from the Operator form', dateIn,
    right('operator_outputs', 'export') ? [h('a', { class: 'btn', href: `/api/reports/hourly.xlsx?date=${date}` }, 'Export Excel'), h('a', { class: 'btn', href: `/api/reports/hourly.csv?date=${date}` }, 'CSV')] : null);
  const procs = [...new Set(r.rows.map((x) => x.process))];
  const codes = [...new Set(r.rows.map((x) => x.project).filter(Boolean))];
  head.append(h('div', { class: 'slicers' },
    h('div', { class: 'slicer' }, h('span', { class: 'slicer-l' }, 'Process'), h('div', { class: 'chips' },
      h('button', { type: 'button', class: `chip${!proc ? ' on' : ''}`, onclick: () => go({ process: '' }) }, 'All', h('span', { class: 'n' }, r.rows.length)),
      procs.map((p) => h('button', { type: 'button', class: `chip${proc === p ? ' on' : ''}`, onclick: () => go({ process: proc === p ? '' : p }) }, p, h('span', { class: 'n' }, r.rows.filter((x) => x.process === p).length))))),
    codes.length ? h('div', { class: 'slicer proj' }, h('span', { class: 'slicer-l' }, 'Project'), h('div', { class: 'pbubs' },
      h('button', { type: 'button', class: `chip${!pick ? ' on' : ''}`, onclick: () => go({ project: '' }) }, 'All projects', h('span', { class: 'n' }, codes.length)),
      codes.map((c) => projectBubble(c, r.rows.filter((x) => x.project === c).length, pick === c, () => go({ project: pick === c ? '' : c }))))) : null));
  const rows = r.rows.filter((x) => (!proc || x.process === proc) && (!pick || x.project === pick));
  if (!rows.length) return [head, h('div', { class: 'empty panel' }, r.rows.length ? 'Nothing matches this selection.' : `No operators on the roster for ${fmtDate(date)}. The Supervisor plans them on the Operator roster page.`)];

  const tables = [...new Set(rows.map((x) => x.shift))].map((shift) => {
    const list = rows.filter((x) => x.shift === shift);
    const labels = ((r.shifts.find((x) => x.name === shift) || {}).slots || list[0].slots).map((x) => x.label);
    const cell = (s) => {
      if (!s) return h('td', {});
      const p = s.plan ? Math.round(((s.actual || 0) / s.plan) * 100) : null;
      return h('td', { class: `hr-c ${s.actual === null ? '' : achieveTone(p)}` }, h('strong', {}, s.actual ?? '·'), h('small', {}, s.plan ? `/${s.plan}` : ''));
    };
    const tot = (l) => {
      const ss = list.map((x) => x.slots.find((y) => y.label === l)).filter(Boolean);
      const plan = ss.reduce((n, x) => n + (x.plan || 0), 0), act = ss.reduce((n, x) => n + (x.actual || 0), 0);
      return h('td', { class: `hr-c ${ss.some((x) => x.actual !== null) ? achieveTone(plan ? (act / plan) * 100 : null) : ''}` }, h('strong', {}, fmtNum(act)), h('small', {}, `/${fmtNum(plan)}`));
    };
    const plan = list.reduce((n, x) => n + (x.planned_qty || 0), 0), act = list.reduce((n, x) => n + x.actual, 0);
    return h('section', { class: 'dcard gap-top' },
      h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('clock')), h('h2', {}, `${shift} shift · ${fmtDate(date)}`),
        h('span', { class: `pill ${achieveTone(plan ? (act / plan) * 100 : null)}` }, `${fmtNum(act)} / ${fmtNum(plan)} pcs`)),
      h('div', { class: 'table-wrap flat' }, h('table', { class: 'hourly' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Operator'), h('th', {}, 'Process / machine'), h('th', {}, 'Job Traveller'), labels.map((l) => h('th', { class: 'num' }, l.replace('-', '–'))),
          h('th', { class: 'num' }, 'Actual / target'), h('th', { class: 'num' }, 'Achieved'))),
        h('tbody', {}, list.map((x) => h('tr', {}, h('th', {}, x.operator),
          h('td', {}, x.process, x.machine ? h('div', { class: 'muted small' }, x.machine) : null),
          h('td', {}, x.jt_no || '—', x.project ? h('div', { class: 'muted small' }, dot(projectColour(x.project)), x.project) : null),
          labels.map((l) => cell(x.slots.find((y) => y.label === l))),
          h('td', { class: 'num' }, h('strong', {}, fmtNum(x.actual)), ` / ${fmtNum(x.planned_qty) || '—'}`),
          h('td', { class: 'num' }, x.achieved === null ? '—' : h('span', { class: `pill ${achieveTone(x.achieved)}` }, fmtPct(x.achieved)))))),
        h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('td', {}), h('td', {}), labels.map(tot),
          h('td', { class: 'num' }, h('strong', {}, fmtNum(act)), ` / ${fmtNum(plan)}`), h('td', { class: 'num' }, plan ? fmtPct((act / plan) * 100) : '—'))))));
  });
  return [head, h('p', { class: 'muted small' }, 'Each cell: actual good pcs / planned pcs for that hour. Green 95% and over, amber 80–95%, red under 80%. The plan spreads the roster target over the shift by the minutes in each hour.'), tables];
}

// ---------- Actual output by process and project ----------------------------------

async function viewActual() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const to = qs.get('to') || localToday();
  const from = qs.get('from') || `${to.slice(0, 8)}01`;
  const proc = qs.get('process') || '';
  const pick = qs.get('project') || '';
  const [r, projects] = await Promise.all([api('GET', `/api/reports/actual?from=${from}&to=${to}`), api('GET', '/api/projects')]);
  projCache = projects;
  const go = (ch) => { const n = new URLSearchParams({ from, to, process: proc, project: pick, ...ch }); for (const [k, v] of [...n]) if (!v) n.delete(k); location.hash = `#/actual?${n}`; };
  const fromIn = h('input', { type: 'date', value: from, 'aria-label': 'From', onchange: (e) => go({ from: e.target.value }) });
  const toIn = h('input', { type: 'date', value: to, 'aria-label': 'To', onchange: (e) => go({ to: e.target.value }) });
  const proj = projects.find((p) => p.code === pick);
  const procRow = r.rows.find((x) => x.process === proc);
  const exportQs = new URLSearchParams({ from, to, ...(procRow ? { process_id: procRow.process_id } : {}), ...(proj ? { project_id: proj.id } : {}) });
  const head = pageHead('Actual output', 'pulse', `From the Operator form, ${fmtDate(from)} to ${fmtDate(to)}`, fromIn, toIn,
    right('operator_outputs', 'export') ? [h('a', { class: 'btn', href: `/api/reports/actual.xlsx?${exportQs}` }, 'Export Excel'), h('a', { class: 'btn', href: `/api/reports/actual.csv?${exportQs}` }, 'CSV')] : null);
  const procs = [...new Set(r.rows.map((x) => x.process))];
  const codes = [...new Set(r.rows.map((x) => x.project || ''))];
  head.append(h('div', { class: 'slicers' },
    h('div', { class: 'slicer' }, h('span', { class: 'slicer-l' }, 'Process'), h('div', { class: 'chips' },
      h('button', { type: 'button', class: `chip${!proc ? ' on' : ''}`, onclick: () => go({ process: '' }) }, 'All', h('span', { class: 'n' }, procs.length)),
      procs.map((p) => h('button', { type: 'button', class: `chip${proc === p ? ' on' : ''}`, onclick: () => go({ process: proc === p ? '' : p }) }, p,
        h('span', { class: 'n' }, fmtNum(r.rows.filter((x) => x.process === p).reduce((n, x) => n + (x.good_qty || 0), 0))))))),
    h('div', { class: 'slicer proj' }, h('span', { class: 'slicer-l' }, 'Project'), h('div', { class: 'pbubs' },
      h('button', { type: 'button', class: `chip${!pick ? ' on' : ''}`, onclick: () => go({ project: '' }) }, 'All projects', h('span', { class: 'n' }, codes.length)),
      codes.map((c) => projectBubble(c, `${fmtNum(r.rows.filter((x) => (x.project || '') === c).reduce((n, x) => n + (x.good_qty || 0), 0))} pcs`, pick === c, () => go({ project: pick === c ? '' : c }), 'No project'))),
      pick ? projectPanel(pick, r.rows.filter((x) => x.project === pick).length) : null)));
  const rows = r.rows.filter((x) => (!proc || x.process === proc) && (!pick || (x.project || '') === pick));
  const sum = (list, k) => list.reduce((n, x) => n + (x[k] || 0), 0);
  const good = sum(rows, 'good_qty'), rej = sum(rows, 'reject_qty');
  const stat = (ic, v, l, tone) => h('div', { class: `stat ${tone}` }, h('span', { class: 'stat-i' }, icon(ic)), h('div', {}, h('div', { class: 'stat-n' }, v), h('div', { class: 'stat-l' }, l)));
  // Process × project matrix of good pcs.
  const mProcs = [...new Set(rows.map((x) => x.process))], mCodes = [...new Set(rows.map((x) => x.project || ''))];
  const matrix = rows.length ? h('section', { class: 'dcard gap-top' },
    h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('grid')), h('h2', {}, 'Good pcs by process and project')),
    h('div', { class: 'table-wrap flat' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Process'), mCodes.map((c) => h('th', { class: 'num' }, c ? [dot(projectColour(c)), c] : 'No project')), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Reject'), h('th', { class: 'num' }, 'Yield'))),
      h('tbody', {}, mProcs.map((p) => {
        const pr = rows.filter((x) => x.process === p), g = sum(pr, 'good_qty'), rj = sum(pr, 'reject_qty');
        return h('tr', {}, h('th', {}, p), mCodes.map((c) => h('td', { class: 'num' }, fmtNum(sum(pr.filter((x) => (x.project || '') === c), 'good_qty')) || '—')),
          h('td', { class: 'num' }, h('strong', {}, fmtNum(g))), h('td', { class: 'num' }, fmtNum(rj)), h('td', { class: 'num' }, g + rj ? fmtPct((g / (g + rj)) * 100) : '—'));
      }))))) : null;
  const detail = rows.length ? h('section', { class: 'dcard gap-top' },
    h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('list')), h('h2', {}, 'Detail'), h('span', { class: 'muted small' }, `${rows.length} entries`)),
    h('div', { class: 'table-wrap flat' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Date', 'Hour slot', 'Process', 'Project', 'Job Traveller', 'Machine', 'Good', 'Reject', 'Run (min)', 'Down (min)', 'Operator'].map((t, i) => h('th', { class: i >= 6 && i <= 9 ? 'num' : '' }, t)))),
      h('tbody', {}, [...new Set(rows.map((x) => x.project || ''))].map((c) => [
        h('tr', { class: 'group' }, h('td', { colspan: 11 }, c ? dot(projectColour(c)) : null, h('strong', {}, c || 'No project'), h('span', { class: 'muted' }, ` · ${fmtNum(sum(rows.filter((x) => (x.project || '') === c), 'good_qty'))} good pcs`))),
        rows.filter((x) => (x.project || '') === c).map((x) => h('tr', {}, h('td', {}, fmtDate(x.date)), h('td', {}, x.slot || ''), h('td', {}, x.process), h('td', {}, x.project || ''),
          h('td', {}, x.jt_no || ''), h('td', {}, x.machine || ''), h('td', { class: 'num' }, fmtNum(x.good_qty)), h('td', { class: 'num' }, fmtNum(x.reject_qty)),
          h('td', { class: 'num' }, fmtNum(x.run_min)), h('td', { class: 'num' }, fmtNum(x.downtime_min)), h('td', {}, x.operator || '')))]))))) :
    h('div', { class: 'empty panel gap-top' }, 'No output recorded for this selection.');
  return [head,
    h('div', { class: 'stat-grid' }, stat('check', fmtNum(good), 'Good pcs', 't2'), stat('alert', fmtNum(rej), 'Reject pcs', rej ? 'alert' : 't2'),
      stat('pulse', good + rej ? fmtPct((good / (good + rej)) * 100) : '—', 'Yield', 't1'), stat('clock', fmtNum(sum(rows, 'run_min') / 60, 1), 'Run hours', 't3'),
      stat('gear', fmtNum(sum(rows, 'downtime_min')), 'Downtime (min)', 't4')),
    matrix, detail];
}

// ---------- PM check by date ---------------------------------------------------

const PM_DAYS = { Daily: 1, Weekly: 7, Monthly: 30, Quarterly: 91, 'Semi-Annual': 182, Annual: 365 };
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

async function viewPm() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const [machines, tasks, logs] = await Promise.all([api('GET', '/api/machines'), api('GET', '/api/pm_tasks'), api('GET', '/api/pm_logs')]);
  const withTasks = machines.filter((m) => tasks.some((t) => t.machine_id === m.id));
  const date = qs.get('date') || localToday();
  const machineId = Number(qs.get('machine')) || (withTasks[0] || {}).id;
  const freq = qs.get('freq') || 'Daily';
  const go = (ch) => { const n = new URLSearchParams({ date, machine: machineId || '', freq, ...ch }); location.hash = `#/pm?${n}`; };
  const canLog = right('pm_logs', 'create');

  // Last check of each item up to the chosen date, and whether it is due by its frequency.
  const last = new Map();
  for (const l of logs) if (l.date <= date && (!last.has(l.pm_task_id) || l.date > last.get(l.pm_task_id).date)) last.set(l.pm_task_id, l);
  const dueState = (t) => {
    const l = last.get(t.id);
    if (!l) return ['Never checked', 'bad'];
    const age = daysBetween(l.date, date), every = PM_DAYS[t.frequency] || 1;
    if (age >= every * 2) return [`Overdue ${age - every} day(s)`, 'bad'];
    if (age >= every) return ['Due', 'warn'];
    return [`Next ${fmtDate(addDays(l.date, every))}`, 'ok'];
  };

  const dateIn = h('input', { type: 'date', value: date, 'aria-label': 'Date', onchange: (e) => go({ date: e.target.value }) });
  const head = pageHead('PM check log', 'clip', 'Daily care record of each machine, by date', dateIn);
  const chipRow = (label, items, cur, key) => h('div', { class: 'slicer' }, h('span', { class: 'slicer-l' }, label),
    h('div', { class: 'chips' }, items.map(([v, l, n]) => h('button', { type: 'button', class: `chip${String(cur) === String(v) ? ' on' : ''}`, onclick: () => go({ [key]: v }) }, l, h('span', { class: 'n' }, n)))));
  const mTasks = tasks.filter((t) => t.machine_id === machineId);
  head.append(h('div', { class: 'slicers' },
    chipRow('Machine', withTasks.map((m) => [m.id, m.code, tasks.filter((t) => t.machine_id === m.id).length]), machineId, 'machine'),
    chipRow('Frequency', Object.keys(PM_DAYS).filter((f) => mTasks.some((t) => t.frequency === f)).map((f) => [f, f, mTasks.filter((t) => t.frequency === f).length]), freq, 'freq')));

  // Checklist for the chosen machine, frequency and date.
  const list = mTasks.filter((t) => t.frequency === freq);
  const todays = new Map(logs.filter((l) => l.date === date && l.machine_id === machineId).map((l) => [l.pm_task_id, l]));
  const marks = new Map();
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (!marks.size) return toast('Mark Pass, Fail or N/A first', true);
    let ok = 0;
    for (const [id, mk] of marks) {
      try { await api('POST', '/api/pm_logs', { date, pm_task_id: id, result: mk.result, reading: mk.reading.value || null, remarks: mk.remark.value || null }); ok++; }
      catch (e) { toast(e.message, true); }
    }
    if (ok) toast(`${ok} check(s) saved for ${fmtDate(date)}`);
    route();
  } }, 'Save checks');
  const rows = list.map((t) => {
    const done = todays.get(t.id);
    const [dueText, tone] = dueState(t);
    const reading = h('input', { type: 'text', placeholder: 'Reading', 'aria-label': `Reading for ${t.task}` });
    const remark = h('input', { type: 'text', placeholder: 'Remark', 'aria-label': `Remark for ${t.task}` });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': `Result for ${t.task}` }, ['Pass', 'Fail', 'N/A'].map((r) => h('button', { type: 'button', class: `seg-${r === 'N/A' ? 'na' : r.toLowerCase()}`, onclick: (e) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      marks.set(t.id, { result: r, reading, remark });
      saveBtn.textContent = `Save ${marks.size} check(s)`;
    } }, r)));
    return h('div', { class: `pm-row${done ? ' done' : ''}` },
      h('div', { class: 'pm-no' }, t.item_no || ''),
      h('div', { class: 'pm-task' }, h('strong', {}, t.task), t.standard ? h('small', {}, t.standard) : null, h('span', { class: `pill ${tone}` }, dueText)),
      done ? h('div', { class: 'pm-done' }, pill(done.result), done.reading ? ` ${done.reading}` : '', h('small', {}, `by ${done.checked_by}${done.remarks ? ` · ${done.remarks}` : ''}`))
        : canLog ? h('div', { class: 'pm-in' }, seg, reading, remark) : h('div', { class: 'muted' }, 'Not checked'));
  });
  const m = machines.find((x) => x.id === machineId);
  const doneCount = list.filter((t) => todays.has(t.id)).length;

  // Log by date: the last 14 days for every machine.
  const days = Array.from({ length: 14 }, (_, i) => addDays(date, -13 + i));
  const grid = h('div', { class: 'table-wrap flat' }, h('table', { class: 'pm-grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Machine'), days.map((d) => h('th', { class: d === date ? 'today' : '' }, `${d.slice(8)}/${d.slice(5, 7)}`)))),
    h('tbody', {}, withTasks.map((mc) => h('tr', {}, h('th', {}, mc.code), days.map((d) => {
      const dl = logs.filter((l) => l.machine_id === mc.id && l.date === d);
      const fail = dl.filter((l) => l.result === 'Fail').length;
      return h('td', { class: `pm-cell ${dl.length ? (fail ? 'bad' : 'ok') : ''}`, title: dl.length ? `${mc.code} ${fmtDate(d)}: ${dl.length} checked, ${fail} fail` : `${mc.code} ${fmtDate(d)}: no check`,
        onclick: () => go({ date: d, machine: mc.id }) }, dl.length ? (fail ? `${dl.length} · ${fail}✕` : dl.length) : '·');
    }))))));

  return [head,
    h('section', { class: 'dcard' },
      h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('gear')), h('h2', {}, `${m ? `${m.code} ${m.name}` : 'No machine'} · ${freq} · ${fmtDate(date)}`),
        h('span', { class: 'muted' }, `${doneCount}/${list.length} done`)),
      list.length ? rows : h('div', { class: 'empty' }, 'No PM items for this machine and frequency. Add them in PM checklist.'),
      canLog && list.length > doneCount ? h('div', { class: 'ck-actions' }, saveBtn) : null),
    h('section', { class: 'dcard gap-top' },
      h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('cal')), h('h2', {}, 'Log by date (last 14 days)'), h('a', { href: '#/r/pm_logs' }, 'All PM logs')),
      grid, h('p', { class: 'muted small' }, 'Number = items checked that day. ✕ = items that failed. Click a day to open it.')),
  ];
}

// ---------- cockpit dashboard -------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
}
const ICONS = {
  form: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h5',
  jt: 'M4 6h16 M4 12h16 M4 18h10 M18 16l2 2 3-4',
  layout: 'M3 3h18v18H3z M3 10h8 M11 3v18 M15 14h6',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  draw: 'M4 20l4-1 11-11-3-3L5 16z M14 6l3 3',
  check: 'M4 12l5 5L20 6',
  plus: 'M12 5v14 M5 12h14',
  gear: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  file: 'M6 3h9l4 4v14H6z M14 3v5h5',
  chat: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5',
  alert: 'M12 3l10 18H2z M12 10v4 M12 17v1',
  grid: 'M3 3h8v8H3z M13 3h8v5h-8z M13 10h8v11h-8z M3 13h8v8H3z',
  folder: 'M3 6h6l2 2h10v11H3z',
  nest: 'M3 3h18v18H3z M7 7h4v4H7z M13 7h4v3h-4z M7 13h3v4H7z M12 13h5v4h-5z',
  route: 'M4 6h10 M4 12h16 M4 18h7 M17 3l3 3-3 3',
  flow: 'M3 5h6v5H3z M15 14h6v5h-6z M9 7.5h3a2 2 0 0 1 2 2v7h1',
  wrench: 'M15 4a5 5 0 0 0 5 5l-10 10a2.1 2.1 0 0 1-3-3L17 6a5 5 0 0 0-2-2z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  clip: 'M9 3h6v3H9z M6 5H5v16h14V5h-1 M8 13l3 3 5-6',
  tag: 'M3 3h8l10 10-8 8L3 11z M7 7h.01',
  cal: 'M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4',
  list: 'M4 4h16v16H4z M8 9h8 M8 13h8 M8 17h5',
  users: 'M9 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M16 3a4 4 0 0 1 0 8 M18 14a6 6 0 0 1 4 7',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  clock: 'M12 7v5l3 2 M12 3a9 9 0 1 0 .01 0',
  user: 'M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  search: 'M11 4a7 7 0 1 0 .01 0 M20 20l-4-4',
  pulse: 'M3 12h4l3-7 4 14 3-7h4',
  gantt: 'M4 3v18h17 M7 7h7 M10 11h8 M8 15h6',
  board: 'M4 4h4v16H4z M10 4h4v10h-4z M16 4h4v6h-4z',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
};
// The icon shown beside each page title.
const PAGE_ICONS = {
  projects: 'folder', parts: 'box', routings: 'route', nestings: 'nest', nesting_parts: 'nest', wf_steps: 'flow', machines: 'gear', tooling: 'wrench',
  plates: 'layers', drawings: 'draw', maint_orders: 'wrench', pm_tasks: 'clip', pm_logs: 'cal', pm: 'clip', schedules: 'gantt', plan: 'gantt', worktime: 'clock', shifts: 'clock', holidays: 'cal', hourly: 'clock', actual: 'pulse', shift_plans: 'users', roster: 'users', ncrs: 'alert', reason_codes: 'tag', job_travellers: 'jt', jt_steps: 'jt',
  operator_outputs: 'form', daily_logs: 'cal', inventory_items: 'box', inventory_moves: 'list', issues: 'chat', shop_processes: 'pulse',
  '': 'grid', daily: 'board', issue: 'chat', jt: 'jt', operator: 'form', find: 'search', layout: 'layout', 'project-new': 'plus', project: 'folder',
  ncr: 'alert', users: 'users', audit: 'clock', rights: 'shield', database: 'db', account: 'user', nesting: 'nest',
};
// Page title card: icon, title, a short line, and room for the slicer chips.
function pageHead(title, iconName, sub, ...extra) {
  return h('header', { class: 'page-head' }, pageArt(iconName),
    h('div', { class: 'ph-row' }, h('span', { class: 'ph-icon' }, icon(iconName || 'grid')),
      h('div', { class: 'ph-text' }, h('h1', {}, title), sub ? h('p', {}, sub) : null), extra));
}

// Faint sheet-metal drawings behind each page title, chosen to suit the page.
// Each drawing is a list of [layer, path]: o outline, f soft fill, d fine detail, a accent (sparks, beam, weld).
const ring_ = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
function gear_(cx, cy, r, n) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a0 = (i / (n * 2)) * Math.PI * 2, a1 = ((i + 1) / (n * 2)) * Math.PI * 2, rr = i % 2 ? r : r + 7;
    const p = (a, q) => `${(cx + q * Math.cos(a)).toFixed(1)} ${(cy + q * Math.sin(a)).toFixed(1)}`;
    d += `${i ? 'L' : 'M'}${p(a0, rr)}L${p(a1, rr)}`;
  }
  return `${d}Z`;
}
const ticks_ = (x0, x1, y, step, big) => { let d = ''; for (let x = x0, i = 0; x <= x1; x += step, i++) d += `M${x} ${y}v${i % big ? -5 : -10}`; return d; };
const spiral_ = (cx, cy, r0, r1, turns) => {
  let d = `M${cx + r0} ${cy}`;
  for (let i = 1; i <= turns * 36; i++) { const a = (i / 36) * Math.PI * 2, r = r0 + ((r1 - r0) * i) / (turns * 36); d += `L${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`; }
  return d;
};
const sparks_ = (x, y, n, len) => { let d = ''; for (let i = 0; i < n; i++) { const a = Math.PI * (1.05 + (i / (n - 1)) * 0.9), l = len * (0.55 + ((i * 37) % 10) / 22); d += `M${x} ${y}l${(Math.cos(a) * l).toFixed(1)} ${(-Math.sin(a) * l).toFixed(1)}`; } return d; };
const ART = {
  laser: () => [
    ['f', 'M30 108 L80 80 H340 L290 108 Z M30 108 v28 h260 v-28 Z M290 136 L340 108 V80 L290 108 Z'],
    ['o', 'M30 108 L80 80 H340 L290 108 Z M30 108 v28 h260 v-28 M290 136 L340 108 V80 M0 140 h360'],
    ['f', 'M62 46 H334 V58 H62 Z M180 34 h30 v34 h-30 Z'],
    ['o', 'M62 46 H334 V58 H62 Z M72 58 V92 M322 58 V84 M180 34 h30 v34 h-30 Z M187 68 l8 12 l8 -12 M334 46 q22 -18 0 -36 h-50 v24'],
    ['d', 'M60 104 L98 86 H306 L268 104 Z M110 100 l10 -5 h34 l-10 5 z M168 100 l10 -5 h22 l-10 5 z M222 100 l10 -5 h30 l-10 5 z M122 92 l6 -3 h22 l-6 3 z M240 92 l6 -3 h22 l-6 3 z ' +
      'M40 116 h60 M40 124 h60 M120 116 h40 M300 118 l30 -18 M300 128 l30 -18 M186 40 h18 M186 46 h18 M8 56 h22 v52 h-22 z M12 60 h14 v12 h-14 z' + ring_(15, 84, 3) + ring_(23, 84, 3) + ring_(15, 96, 3) + ring_(23, 96, 3)],
    ['a', `M195 82 V100${sparks_(195, 100, 9, 16)}`],
  ],
  brake: () => [
    ['f', 'M70 18 h220 v30 h-220 Z M48 18 h26 v118 h-26 Z M286 18 h26 v118 h-26 Z M76 104 h208 v32 h-208 Z'],
    ['o', 'M70 18 h220 v30 h-220 Z M48 18 h26 v118 h-26 Z M286 18 h26 v118 h-26 Z M76 104 h208 v32 h-208 Z M150 48 v18 h60 v-18 M164 66 l16 18 l16 -18 M150 96 h60 v8 h-60 Z M170 96 l10 -9 l10 9 M0 140 h360'],
    ['d', 'M100 2 v16 M92 2 h16 M260 2 v16 M252 2 h16 M84 30 h40 M236 30 h40 M240 98 v-14 h22 M78 52 v48 M282 52 v48 M90 116 h180 M90 124 h180 M54 40 h14 M54 120 h14 M292 40 h14 M292 120 h14 ' +
      'M322 40 h30 v44 h-30 Z M326 44 h22 v14 h-22 Z M337 84 v52' + ring_(330, 70, 3) + ring_(344, 70, 3)],
    ['a', 'M84 70 L180 87 L276 70'],
  ],
  plates: () => {
    const out = [];
    for (const y of [136, 128, 120, 112, 104]) {
      out.push(['f', `M40 ${y} L100 ${y - 26} H320 L260 ${y} Z`]);
      out.push(['o', `M40 ${y} L100 ${y - 26} H320 L260 ${y} Z M40 ${y} v5 h220 l60 -26 v-5`]);
    }
    out.push(['f', 'M70 64 L120 44 H300 L250 64 Z']);
    out.push(['o', 'M70 64 L120 44 H300 L250 64 Z M70 64 v4 h180 l50 -20 v-4 M120 24 h150 M140 24 v26 M180 24 v24 M220 24 v22 M260 24 v20 M195 24 v-12 M188 12 h14 M0 142 h360']);
    out.push(['d', `${ring_(140, 50, 4)}${ring_(180, 48, 4)}${ring_(220, 46, 4)}${ring_(260, 44, 4)}M195 0 v12 M290 112 h30 v12 h-30 Z M294 118 h22`]);
    out.push(['a', 'M150 80 h-30 M320 84 l20 -10']);
    return out;
  },
  blueprint: () => [
    ['f', 'M20 8 h320 v144 h-320 Z'],
    ['d', 'M20 28 h320 M20 48 h320 M20 68 h320 M20 88 h320 M20 108 h320 M20 128 h320 M60 8 v144 M100 8 v144 M140 8 v144 M180 8 v144 M220 8 v144 M260 8 v144 M300 8 v144'],
    ['o', 'M20 8 h320 v144 h-320 Z M240 118 h100 M240 118 v34 M290 118 v34 M240 134 h100 M50 98 v-52 h12 v40 h70 v12 Z M160 46 h80 v52 h-80 Z' + ring_(180, 72, 6) + ring_(220, 72, 6)],
    ['d', 'M160 58 h80 M50 110 h82 M50 106 v8 M132 106 v8 M54 110 l-4 -2 v4 Z M128 110 l4 -2 v4 Z M150 46 v52 M146 46 h8 M146 98 h8 M248 126 h34 M248 142 h34 M296 126 h36'],
    ['a', 'M180 60 v24 M168 72 h24 M220 60 v24 M208 72 h24 M262 40 l60 -22 l6 6 l-60 22 Z M262 40 l-8 8 l14 -2'],
  ],
  weld: () => [
    ['f', 'M36 136 h64 v-16 h-64 Z M58 120 v-40 h22 v40 Z M180 108 h150 v12 h-150 Z M250 66 h12 v42 h-12 Z'],
    ['o', 'M36 136 h64 v-16 h-64 Z M58 120 v-40 h22 v40 M69 80 L140 38 M140 38 L212 70 M212 70 l18 22 M226 90 l8 8 M180 108 h150 v12 h-150 Z M250 66 h12 v42 h-12 M0 140 h360' + ring_(69, 80, 9) + ring_(140, 38, 8) + ring_(212, 70, 7)],
    ['d', 'M76 78 L138 42 M88 70 L140 46 M144 44 L208 74 M60 128 h30 M190 114 h130 M100 40 q-20 -24 20 -30 M120 10 h40'],
    ['a', `M236 104 q4 -4 8 0 q4 4 8 0 q4 -4 8 0 q4 4 8 0 q4 -4 8 0 q4 4 8 0${sparks_(236, 102, 9, 18)}`],
  ],
  machine: () => [
    ['f', 'M30 30 h190 v104 h-190 Z' + gear_(292, 88, 30, 12)],
    ['o', 'M30 30 h190 v104 h-190 Z M46 46 h104 v64 h-104 Z M162 46 h44 v30 h-44 Z M30 120 h190 M0 140 h360' + gear_(292, 88, 30, 12) + ring_(292, 88, 12)],
    ['d', 'M60 96 h76 v8 h-76 Z M92 46 v22 h12 v-22 M98 68 v12 M166 50 h36 v22 h-36 Z M48 112 v8 M200 112 v8 M240 22 v-14 h12 v14 M236 22 h20 ' +
      ring_(172, 90, 5) + ring_(192, 90, 5) + ring_(182, 104, 5) + 'M250 140 l26 -26 M270 108 a10 10 0 1 1 12 12'],
    ['a', 'M246 8 v14 M240 12 h12 M86 82 l-6 -4 M110 82 l6 -4'],
  ],
  caliper: () => [
    ['f', 'M24 56 h300 v18 h-300 Z M40 74 v46 l18 -12 v-34 Z M150 48 h50 v34 h-50 Z M166 82 v38 l-16 -12 v-26 Z'],
    ['o', 'M24 56 h300 v18 h-300 Z M40 74 v46 l18 -12 v-34 M40 56 v-30 l14 10 v20 M150 48 h50 v34 h-50 Z M166 82 v38 l-16 -12 v-26 M166 48 v-22 l-14 10 v12 M324 64 h30 M0 140 h360' + ring_(214, 92, 7)],
    ['d', ticks_(64, 140, 74, 4, 5) + ticks_(210, 318, 74, 4, 5) + ticks_(154, 196, 82, 4, 5) + 'M60 130 h90 v-10 h-10 v-20 h-70 v20 h-10 Z'],
    ['a', 'M58 112 h92 M62 108 l-4 4 l4 4 M146 108 l4 4 l-4 4'],
  ],
  rack: () => [
    ['f', 'M56 32 h44 v20 h-44 Z M110 36 h34 v16 h-34 Z M190 28 h54 v24 h-54 Z M64 64 h60 v24 h-60 Z M140 70 h30 v18 h-30 Z M60 102 h46 v22 h-46 Z M122 98 h60 v26 h-60 Z M262 96 h48 v28 h-48 Z'],
    ['o', 'M40 18 v106 M200 18 v106 M40 52 h220 M40 88 h220 M40 124 h300 M260 18 v34 M56 32 h44 v20 h-44 Z M110 36 h34 v16 h-34 Z M190 28 h54 v24 h-54 Z M64 64 h60 v24 h-60 Z M140 70 h30 v18 h-30 Z M60 102 h46 v22 h-46 Z M122 98 h60 v26 h-60 Z ' +
      'M262 96 h48 v28 h-48 Z M300 124 v-48 M300 76 h40 v24 h-40 M318 76 v-12 h22 v12 M296 136 h-46 M0 140 h360' + ring_(312, 130, 8) + ring_(338, 130, 8)],
    ['d', 'M64 76 h60 M70 64 v24 M118 64 v24 M190 40 h54 M60 113 h46 M122 106 h60 M122 114 h60 M44 30 h8 M44 66 h8 M44 102 h8 M204 30 h8 M204 66 h8 M204 102 h8'],
    ['a', 'M250 122 h50'],
  ],
  factory: () => [
    ['f', 'M20 132 V74 l40 -28 v28 l40 -28 v28 l40 -28 v28 l40 -28 v86 Z M218 132 V40 h18 v92 Z M244 132 V62 h56 v70 Z'],
    ['o', 'M20 132 V74 l40 -28 v28 l40 -28 v28 l40 -28 v28 l40 -28 v86 M218 132 V40 h18 v92 M244 132 V62 h56 v70 M0 136 h360 M300 108 h44 v24 h-44 M344 116 h10 l6 8 v8 h-16' + ring_(312, 134, 5) + ring_(350, 134, 5)],
    ['d', 'M36 92 h22 v14 h-22 Z M80 92 h22 v14 h-22 Z M124 92 h22 v14 h-22 Z M36 112 h22 v14 h-22 Z M150 108 h20 v24 h-20 Z M256 74 h12 v10 h-12 Z M276 74 h12 v10 h-12 Z M256 92 h12 v10 h-12 Z M276 92 h12 v10 h-12 Z M262 112 h20 v20 h-20 Z M60 48 v26 M100 48 v26 M140 48 v26'],
    ['a', 'M224 30 q8 -10 0 -18 q-8 -8 4 -14 M232 34 q10 -12 4 -22'],
  ],
  roll: () => [
    ['f', ring_(70, 82, 40) + 'M44 132 h52 l-10 -18 h-32 Z M150 112 h170 v8 h-170 Z'],
    ['o', ring_(70, 82, 40) + ring_(70, 82, 12) + 'M44 132 h52 l-10 -18 h-32 Z M106 92 L150 112 M150 112 h170 v8 h-170 M0 136 h360 M190 34 h70 v26 h-70 Z M225 60 v40' + ring_(170, 100, 9) + ring_(170, 130, 9) + ring_(205, 100, 9) + ring_(205, 130, 9)],
    ['d', spiral_(70, 82, 14, 38, 4) + 'M260 108 v-8 M290 108 v-8 M330 100 h20 v20 h-20 Z M334 96 h20 v20'],
    ['a', 'M219 104 h12 M225 98 v12'],
  ],
};
const ART_FOR = { nest: 'laser', layers: 'plates', draw: 'blueprint', gear: 'machine', wrench: 'machine', clip: 'machine', alert: 'caliper', check: 'caliper',
  box: 'rack', list: 'rack', tag: 'rack', layout: 'factory', grid: 'factory', folder: 'factory', plus: 'blueprint', jt: 'brake', form: 'brake', pulse: 'laser',
  clock: 'brake', gantt: 'roll', users: 'weld', board: 'weld', cal: 'roll', chat: 'weld', route: 'roll', flow: 'roll', shield: 'factory', user: 'weld', search: 'blueprint' };
const artCache = {};
function pageArt(iconName) {
  const name = ART_FOR[iconName] || 'factory';
  const layers = artCache[name] || (artCache[name] = ART[name]());
  return svg('svg', { class: 'ph-art', viewBox: '0 0 360 160', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    layers.map(([cls, d]) => svg('path', { class: `pa-${cls}`, d })));
}
const icon = (n) => svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d: ICONS[n] }));

function ring(pct, colour, title, sub) {
  const r = 34, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(pct) || 0));
  const arc = svg('circle', { cx: 44, cy: 44, r, fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round', stroke: colour,
    'stroke-dasharray': `${(v / 100) * c} ${c}`, transform: 'rotate(-90 44 44)' });
  return h('div', { class: 'ck-ring' }, h('div', { class: 't' }, title), h('div', { class: 's' }, sub),
    svg('svg', { viewBox: '0 0 88 88', role: 'img', 'aria-label': `${title} ${fmtPct(v)}` },
      svg('circle', { class: 'ck-track', cx: 44, cy: 44, r, fill: 'none', 'stroke-width': 8 }), v ? arc : null,
      svg('text', { x: 44, y: 50, 'text-anchor': 'middle' }, `${Math.round(v)}%`)));
}

function donut(parts) {
  const total = parts.reduce((n, p) => n + p.n, 0) || 1, r = 52, c = 2 * Math.PI * r;
  let off = 0;
  const arcs = parts.filter((p) => p.n).map((p) => {
    const len = (p.n / total) * c;
    const a = svg('circle', { cx: 75, cy: 75, r, fill: 'none', 'stroke-width': 18, stroke: p.colour,
      'stroke-dasharray': `${len} ${c - len}`, 'stroke-dashoffset': String(-off), transform: 'rotate(-90 75 75)' });
    off += len;
    return a;
  });
  return h('div', { class: 'ck-donut' },
    svg('svg', { viewBox: '0 0 150 150', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${p.n}`).join(', ') },
      svg('circle', { class: 'ck-track', cx: 75, cy: 75, r, fill: 'none', 'stroke-width': 18 }), arcs,
      svg('text', { x: 75, y: 74, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 700 }, String(parts.reduce((n, p) => n + p.n, 0))),
      svg('text', { x: 75, y: 94, 'text-anchor': 'middle', 'font-size': 11 }, 'Job Travellers')),
    h('div', { class: 'ck-legend' }, parts.map((p) => {
      const sw = h('span', { class: 'sw' }); sw.style.background = p.colour;
      return h('div', {}, sw, `${p.label} `, h('strong', {}, p.n), h('span', { class: 'muted' }, ` (${Math.round((p.n / total) * 100)}%)`));
    })));
}

function calendar(marks) {
  const today = localToday();
  const [y, m] = today.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < (first + 6) % 7; i++) cells.push(h('div', { class: 'd out' }));
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const due = marks[iso];
    cells.push(h('div', { class: `d${iso === today ? ' today' : due ? ' due' : ''}`, title: due ? due.join(', ') : null }, d));
  }
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return [h('div', { class: 'ck-sub' }, month),
    h('div', { class: 'ck-cal' }, ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((x) => h('div', { class: 'dn' }, x)), cells),
    h('div', { class: 'ck-cal-note' }, 'Pink: today. Orange: Job Traveller, project due or holiday.')];
}

async function viewCockpit(d) {
  const get = (url) => api('GET', url).catch(() => []);
  const [jts, drawings, pm, machines, projects] = await Promise.all(['/api/job_travellers', '/api/drawings', '/api/pm_tasks', '/api/machines', '/api/projects'].map(get));
  const me = state.user, pr = d.production;
  const name = me.full_name || me.username;
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const live = jts.filter((j) => j.status !== 'Cancelled');
  const approved = live.filter((j) => j.approved_on).length;
  const checked = pm.filter((t) => t.status === 'Pass' || t.status === 'Fail');
  const passRate = checked.length ? (checked.filter((t) => t.status === 'Pass').length / checked.length) * 100 : 0;
  const card = (title, ...kids) => h('section', { class: 'ck-card' }, title ? h('h3', {}, title) : null, kids);

  // Left: profile, quick links, help
  const quick = [['#/operator', 'form', 'Operator form'], ['#/r/job_travellers', 'jt', 'Job Travellers'], ['#/layout', 'layout', 'Shop-floor layout'],
    ['#/r/inventory_items', 'box', 'Inventory'], ['#/drawings', 'draw', 'Drawings and STEP'], ['#/r/pm_tasks', 'check', 'PM checklist'],
    ['#/r/machines', 'gear', 'Machines'], ['#/daily', 'chat', 'Daily board']];
  if (right('projects', 'create')) quick.push(['#/project-new', 'plus', 'New project']);
  const left = h('div', { class: 'ck-col' },
    h('section', { class: 'ck-card ck-profile' },
      h('div', { class: 'ck-avatar', 'aria-hidden': 'true' }, initials),
      h('div', { class: 'ck-name' }, name),
      h('div', { class: 'ck-role' }, [me.process, me.role].filter(Boolean).join(' · ')),
      h('nav', { class: 'ck-links', 'aria-label': 'My pages' },
        h('a', { href: '#/daily' }, 'Daily board', h('span', { 'aria-hidden': 'true' }, '›')),
        h('a', { href: '#/r/issues' }, 'Issues', h('span', {}, d.kpi.open_issues)),
        h('a', { href: '#/account' }, 'My account', h('span', { 'aria-hidden': 'true' }, '›')))),
    card('Quick links', h('nav', { class: 'ck-quick', 'aria-label': 'Quick links' },
      quick.map(([href, ic, label]) => h('a', { href, class: ic === 'plus' ? 'add' : null, title: label, 'aria-label': label }, icon(ic))))),
    h('section', { class: 'ck-card' }, h('a', { class: 'ck-help', href: '#/r/issues' }, icon('chat'),
      h('span', {}, h('strong', {}, 'Need help?'), h('br'), h('span', { class: 'dot' }), h('small', { class: 'muted' }, 'Raise an issue to any process')))));

  // Middle: rings, machines, focus, process bars, status donut
  const nextJt = live.find((j) => !j.approved_on && j.status !== 'Completed');
  const machineIcon = { Running: 'check', Idle: 'gear', Down: 'alert', Maintenance: 'gear' };
  const colours = ['var(--ring-1)', 'var(--ring-2)', 'var(--ring-3)', 'var(--ring-4)'];
  const count = (st) => live.filter((j) => j.status === st).length;
  const mid = h('div', { class: 'ck-mid' },
    h('section', { class: 'ck-card wide' }, h('div', { class: 'ck-rings' },
      h('div', { class: 'ck-intro' }, h('div', { class: 'big' }, 'Production'), h('p', {}, `${fmtNum(pr.good)} of ${fmtNum(pr.target)} pcs good. ${fmtNum(pr.remaining_min / 60, 1)} hours of work left at ${d.minutesPerDay} min/day.`)),
      ring(pr.completion, colours[0], 'Completion', 'all processes'),
      ring(pr.yield, colours[1], 'Yield', 'first pass'),
      ring(live.length ? (approved / live.length) * 100 : 0, colours[2], 'Approved', `${approved}/${live.length} JTs`),
      ring(passRate, colours[3], 'PM pass', `${checked.length} checks`))),
    projectProgressCard(d.projectProgress, 'ck-card wide'),
    card('Machines', h('div', { class: 'ck-list' }, machines.slice(0, 8).map((m) =>
      h('div', {}, icon(machineIcon[m.status] || 'gear'), h('span', {}, m.code, ' ', pill(m.status), h('small', {}, m.name || m.machine_type || '')))))),
    card('Next to approve', nextJt ? [
      h('div', { class: 'ck-focus' }, h('div', { class: 'ico' }, icon('jt')),
        h('div', {}, h('p', {}, h('strong', {}, nextJt.jt_no), ` · ${nextJt.part_no || ''}`),
          h('p', {}, nextJt.description || ''), h('p', {}, `Qty ${fmtNum(nextJt.qty)} · due ${fmtDate(nextJt.due_date) || '—'}`))),
      h('div', { class: 'ck-actions' }, h('a', { class: 'btn', href: `#/jt/${nextJt.id}` }, 'Open'),
        right('job_travellers', 'approve') ? h('a', { class: 'btn grad', href: `#/jt/${nextJt.id}` }, 'Review and approve') : null)]
      : h('p', { class: 'muted' }, 'Every Job Traveller is approved.')),
    todayCard(d.live, 'ck-card'),
    monthCard(d.live, 'ck-card'),
    processCard(d.processes, d.minutesPerDay, 'ck-card wide'),
    scheduleCard(d.schedules, d.projectProgress, 'ck-card wide'),
    card('Job Traveller status', donut([
      { label: 'Planned', n: count('Planned'), colour: colours[2] }, { label: 'In progress', n: count('In progress'), colour: colours[3] },
      { label: 'Completed', n: count('Completed'), colour: colours[1] }, { label: 'On hold', n: count('On hold'), colour: colours[0] }])));

  // Right: recent docs, tasks, calendar
  const docs = [...drawings].sort((a, b) => String(b.created_at || b.id).localeCompare(String(a.created_at || a.id), undefined, { numeric: true })).slice(0, 5);
  const tasks = d.issues.filter((i) => !me.process || i.to_process === me.process || me.role === 'admin').slice(0, 6);
  const marks = {};
  for (const x of [...live.filter((j) => j.status !== 'Completed').map((j) => [j.due_date, j.jt_no]), ...projects.map((p) => [p.due_date, p.code]),
    ...((d.live.wt && d.live.wt.holidays) || []).map((x) => [x.date, x.name])]) {
    if (x[0]) (marks[x[0].slice(0, 10)] = marks[x[0].slice(0, 10)] || []).push(x[1]);
  }
  const rightCol = h('div', { class: 'ck-col ck-right' },
    card('Recent drawings and STEP', h('div', { class: 'ck-docs' }, docs.length ? docs.map((x) =>
      h('a', { href: '#/drawings' }, icon(x.kind === '3D model' ? 'box' : 'file'), h('span', {}, `${x.part_no} rev ${x.rev || '-'}`, h('small', {}, `${x.kind || 'Drawing'} · ${(x.format || '').toUpperCase()}`)))) :
      h('p', { class: 'muted' }, 'No files yet.'))),
    card('My tasks', h('div', { class: 'ck-tasks' }, tasks.length ? tasks.map((i) =>
      h('a', { href: `#/issue/${i.id}` }, h('span', { class: `circ${i.status === 'In progress' ? ' on' : ''}`, 'aria-hidden': 'true' }),
        h('span', {}, i.title, h('small', {}, `${i.from_process || ''} → ${i.to_process || ''} · ${i.status}`)))) :
      h('p', { class: 'muted' }, 'Nothing waiting for you.'))),
    card('Plate stock by project', h('div', { class: 'ck-tasks' }, d.plates.map((p) =>
      h('a', { href: '#/r/plates' }, icon('layers'), h('span', {}, p.project, ' ', pill(p.low ? 'Low' : 'OK'), h('small', {}, `${fmtNum(p.sheets)} sheets · ${p.materials || ''}`)))))),
    card('Schedule', calendar(marks)));

  return [pageHead(`Hello, ${name.split(' ')[0]}`, 'grid', `${fmtDate(localToday())} · ${[me.process, me.role].filter(Boolean).join(' · ')}`, viewSwitch()), h('div', { class: 'ck' }, left, mid, rightCol)];
}

// ---------- live production cards (every dashboard layout) ----------------------

const sumBy = (list, k) => list.reduce((n, x) => n + (Number(x[k]) || 0), 0);
// Good pcs per hour today: plan from the roster, actual from the Operator form.
function hourTotals(live) {
  const shifts = (live.wt && live.wt.shifts) || [];
  const rows = ((live.actual && live.actual.rows) || []).filter((x) => x.date === live.today);
  const roster = (live.hourly && live.hourly.rows) || [];
  return shifts.flatMap((sh) => sh.slots.map((sl) => ({
    label: sl.label, shift: sh.name,
    actual: sumBy(rows.filter((x) => String(x.slot || '').endsWith(sl.label) && (!x.slot.includes(' ') || x.slot.startsWith(`${sh.name} `))), 'good_qty'),
    plan: roster.filter((x) => x.shift === sh.name).reduce((n, x) => n + ((x.slots.find((y) => y.label === sl.label) || {}).plan || 0), 0),
  })));
}
// Bars with an optional line, drawn as SVG so every theme colours it.
function barChart(items, { line, height = 150, width = 320, labelEvery = 1 } = {}) {
  const W = width, H = height, pad = 22, n = items.length || 1, bw = (W - pad) / n;
  const max = Math.max(1, ...items.map((x) => Math.max(x.v || 0, x.p || 0, line ? x.l || 0 : 0)));
  const y = (v) => H - 18 - ((v || 0) / max) * (H - 30);
  const kids = [svg('line', { x1: pad, x2: W, y1: H - 18, y2: H - 18, class: 'bc-axis' })];
  items.forEach((x, i) => {
    const cx = pad + i * bw;
    if (x.p) kids.push(svg('rect', { x: cx + bw * 0.15, y: y(x.p), width: bw * 0.7, height: H - 18 - y(x.p), rx: 3, class: 'bc-plan' }));
    if (x.v) kids.push(svg('rect', { x: cx + bw * 0.25, y: y(x.v), width: bw * 0.5, height: H - 18 - y(x.v), rx: 3, class: 'bc-bar' }, svg('title', {}, `${x.t}: ${fmtNum(x.v)}${x.p ? ` / ${fmtNum(x.p)}` : ''}`)));
    if (i % labelEvery === 0) kids.push(svg('text', { x: cx + bw / 2, y: H - 4, 'text-anchor': 'middle', class: 'bc-l' }, x.t));
  });
  if (line) kids.push(svg('polyline', { points: items.map((x, i) => `${pad + i * bw + bw / 2},${y(x.l)}`).join(' '), class: 'bc-line', fill: 'none' }));
  kids.push(svg('text', { x: 0, y: 12, class: 'bc-l' }, fmtNum(max)));
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bchart', role: 'img', 'aria-label': items.map((x) => `${x.t} ${x.v || 0}`).join(', ') }, kids);
}
// Daily good pcs this month, with a 7-day average line.
function monthDays(live) {
  const rows = (live.actual && live.actual.rows) || [];
  const days = Number(live.today.slice(8, 10));
  const out = [];
  for (let i = 1; i <= days; i++) {
    const iso = `${live.today.slice(0, 8)}${String(i).padStart(2, '0')}`;
    out.push({ t: String(i), iso, v: sumBy(rows.filter((x) => x.date === iso), 'good_qty') });
  }
  out.forEach((x, i) => { const w = out.slice(Math.max(0, i - 6), i + 1); x.l = sumBy(w, 'v') / w.length; });
  return out;
}
const todayGood = (live) => sumBy(((live.actual && live.actual.rows) || []).filter((x) => x.date === live.today), 'good_qty');
function todayCard(live, cardClass) {
  const hrs = hourTotals(live);
  const act = todayGood(live), plan = sumBy(hrs, 'plan');
  const ops = new Set(((live.hourly && live.hourly.rows) || []).map((x) => x.operator)).size;
  const shifts = (live.wt && live.wt.shifts) || [];
  return h('section', { class: cardClass },
    h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('clock')), h('h2', {}, 'Today on the floor'), h('a', { href: '#/hourly' }, 'Hourly output')),
    h('div', { class: 'live-nums' },
      h('div', {}, h('strong', {}, fmtNum(act)), h('small', {}, 'good pcs today')),
      h('div', {}, h('strong', {}, plan ? fmtPct((act / plan) * 100) : '—'), h('small', {}, plan ? `of ${fmtNum(plan)} planned` : 'no roster plan')),
      h('div', {}, h('strong', {}, String(ops)), h('small', {}, 'operators on roster'))),
    hrs.length ? barChart(hrs.map((x) => ({ t: x.label.slice(0, 5), v: x.actual, p: x.plan })), { height: 150, width: 420, labelEvery: hrs.length > 9 ? 2 : 1 }) : null,
    h('p', { class: 'muted small' }, shifts.map((x) => `${x.name} ${x.start_time}–${x.end_time}`).join(' · ') || 'No shift set. Admin sets it in Working time.',
      plan ? ' · light bars: plan, dark bars: actual' : ''));
}
function monthCard(live, cardClass) {
  const days = monthDays(live);
  const rows = (live.actual && live.actual.rows) || [];
  const good = sumBy(rows, 'good_qty'), rej = sumBy(rows, 'reject_qty');
  const month = new Date(`${live.today}T00:00:00Z`).toLocaleString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return h('section', { class: cardClass },
    h('div', { class: 'dcard-h' }, h('span', { class: 'dcard-i' }, icon('pulse')), h('h2', {}, `Actual output · ${month}`), h('a', { href: '#/actual' }, 'Actual output')),
    h('div', { class: 'live-nums' },
      h('div', {}, h('strong', {}, fmtNum(good)), h('small', {}, 'good pcs')),
      h('div', {}, h('strong', {}, fmtNum(rej)), h('small', {}, 'reject pcs')),
      h('div', {}, h('strong', {}, good + rej ? fmtPct((good / (good + rej)) * 100) : '—'), h('small', {}, 'yield'))),
    barChart(days, { line: true, height: 170, width: 420, labelEvery: days.length > 16 ? 3 : 1 }),
    h('p', { class: 'muted small' }, 'Bars: good pcs per day. Line: 7-day average.'));
}

// ---------- Kit dashboard (light cards, purple accents) ----------------------------

function viewKit(d) {
  const k = d.kpi, pr = d.production, live = d.live;
  const rows = (live.actual && live.actual.rows) || [];
  const days = monthDays(live);
  const hrs = hourTotals(live);
  const tile = (ic, v, l, href) => h('a', { class: 'kit-tile', href }, h('span', { class: 'kit-ti' }, icon(ic)), h('div', {}, h('strong', {}, v), h('small', {}, l)));
  const card = (cls, ...kids) => h('section', { class: `kit-card ${cls}` }, kids);
  // Wave of cumulative good pcs this month.
  let run = 0;
  const cum = days.map((x) => (run += x.v));
  const max = Math.max(1, ...cum);
  const pts = cum.map((v, i) => `${(i / Math.max(1, cum.length - 1)) * 320},${80 - (v / max) * 64}`);
  const wave = svg('svg', { viewBox: '0 0 320 84', class: 'kit-wave', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('path', { d: `M0,84 L${pts.join(' L')} L320,84 Z`, class: 'kit-wave-a' }), svg('polyline', { points: pts.join(' '), class: 'kit-wave-l', fill: 'none' }));
  const topProcs = d.processes.slice(0, 3);
  const week = days.slice(-7);
  const live7 = d.live.today;
  const jtCount = (st) => d.projectProgress.reduce((n, p) => n + ((p.job_travellers && p.job_travellers[st]) || 0), 0);
  const statusParts = [['Planned', 'var(--ring-3)'], ['In progress', 'var(--ring-1)'], ['Completed', 'var(--ring-2)'], ['On hold', 'var(--ring-4)']]
    .map(([label, colour]) => ({ label, colour, n: jtCount(label) }));
  return [
    pageHead('Dashboard', 'grid', `${fmtDate(live7)} · net ${d.minutesPerDay} working min/day`, viewSwitch()),
    h('div', { class: 'kit' },
      card('kit-tiles span-6',
        tile('folder', fmtNum(k.active_projects), 'Active projects', '#/r/projects'),
        tile('box', fmtNum(k.parts), 'Parts', '#/r/parts'),
        tile('jt', fmtNum(d.projectProgress.reduce((n, p) => n + Object.values(p.job_travellers || {}).reduce((a, b) => a + b, 0), 0)), 'Job Travellers', '#/r/job_travellers'),
        tile('check', fmtNum(pr.good), 'Good pcs', '#/actual'),
        tile('alert', fmtNum(k.open_ncrs), 'Open NCR', '#/r/ncrs'),
        tile('chat', fmtNum(k.open_issues), 'Open issues', '#/r/issues')),
      card('span-6 row-2',
        h('div', { class: 'kit-h' }, h('h2', {}, 'Actual output this month'), h('a', { href: '#/actual' }, 'Details')),
        h('div', { class: 'kit-big' }, h('div', {}, h('strong', {}, fmtNum(sumBy(rows, 'good_qty'))), h('small', {}, 'Good pcs')),
          h('div', {}, h('strong', {}, fmtNum(sumBy(rows, 'reject_qty'))), h('small', {}, 'Reject pcs')),
          h('div', {}, h('strong', {}, fmtNum(sumBy(days, 'v') / Math.max(1, days.filter((x) => x.v).length))), h('small', {}, 'Average a working day'))),
        barChart(days, { line: true, height: 230, width: 560, labelEvery: days.length > 16 ? 3 : 1 }),
        h('div', { class: 'kit-legend' }, h('span', { class: 'sw bar' }), 'Good pcs per day', h('span', { class: 'sw line' }), '7-day average')),
      card('span-3 kit-wavecard',
        h('div', { class: 'kit-pad' }, h('div', { class: 'kit-n' }, fmtPct(pr.completion)), h('a', { href: '#/r/job_travellers' }, 'Completion'),
          h('p', {}, `${fmtNum(pr.good)} of ${fmtNum(pr.target)} pcs made across every process.`)),
        wave,
        h('div', { class: 'kit-strip' }, topProcs.map((p) => h('div', {}, h('strong', {}, fmtPct(p.completion)), h('small', {}, p.name))))),
      card('span-3',
        h('div', { class: 'kit-pad' }, h('div', { class: 'kit-n' }, fmtNum(todayGood(live))), h('a', { href: '#/hourly' }, 'Good pcs today'),
          h('p', {}, 'Good pcs made today, hour by hour.')),
        h('div', { class: 'kit-three' },
          h('div', {}, h('strong', {}, fmtNum(sumBy(week, 'v'))), h('small', {}, 'Last 7 days')),
          h('div', {}, h('strong', {}, fmtNum(pr.balance)), h('small', {}, 'Pcs to make')),
          h('div', {}, h('strong', {}, fmtNum(pr.remaining_min / 60, 1)), h('small', {}, 'Hours left'))),
        barChart(hrs.map((x) => ({ t: x.label.slice(0, 2), v: x.actual, p: x.plan })), { height: 110, width: 260 })),
      card('span-6',
        h('div', { class: 'kit-h' }, h('h2', {}, 'Job Traveller status'), h('a', { href: '#/r/job_travellers' }, 'All')),
        h('p', { class: 'muted small' }, 'Every Job Traveller by its status, across all projects.'),
        donut(statusParts)),
      h('div', { class: 'kit-colour span-6' },
        h('a', { class: 'kit-c', href: '#/plan' }, h('div', {}, h('small', {}, 'Hours of work left'), h('strong', {}, fmtNum(pr.remaining_min / 60, 1))), icon('clock')),
        h('a', { class: 'kit-c fill', href: '#/actual' }, h('div', {}, h('small', {}, 'First-pass yield'), h('strong', {}, fmtPct(pr.yield))), icon('check')),
        h('a', { class: 'kit-c fill', href: '#/r/machines' }, h('div', {}, h('small', {}, 'Machines down'), h('strong', {}, fmtNum(k.machines_down))), icon('gear')),
        h('a', { class: 'kit-c', href: '#/r/maint_orders' }, h('div', {}, h('small', {}, 'Open maintenance'), h('strong', {}, fmtNum(k.open_work_orders))), icon('wrench'))),
      projectProgressCard(d.projectProgress, 'kit-card span-12'),
      processCard(d.processes, d.minutesPerDay, 'kit-card span-12'),
      scheduleCard(d.schedules, d.projectProgress, 'kit-card span-12'))];
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
  if (resName === 'nestings') opts.rowActions = (r) => h('a', { class: 'btn small', href: `#/nesting/${r.id}` }, `Parts (${r.part_count || 0})`);
  if (resName === 'plates') opts.noneLabel = { project_id: 'General stock' };
  const head = pageHead(res.label, PAGE_ICONS[resName], res.slicers ? `Split by ${res.slicers.map((n) => res.fields.find((f) => f.name === n).label.toLowerCase()).join(' and ')}` : null);
  opts.slicerSlot = head;
  return [head, recordTable(resName, opts)];
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
  // preset is read when files are sent, so a project picked later still applies.
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

async function viewDrawings() {
  const head = pageHead('Drawings and 3D models', 'draw', 'Upload and find drawings by project');
  const table = recordTable('drawings', { rowActions: drawingActions, slicerSlot: head });
  if (!right('drawings', 'upload')) return [head, table];
  const projects = await api('GET', '/api/projects');
  const pick = h('select', { 'aria-label': 'Project for the upload' }, h('option', { value: '' }, '— choose project —'),
    projects.map((p) => h('option', { value: p.id }, `${p.code} · ${p.name}`)));
  const preset = {};
  pick.addEventListener('change', () => { if (pick.value) preset.project_id = pick.value; else delete preset.project_id; });
  return [head, h('div', { class: 'panel upload-panel' }, h('div', { class: 'field' }, h('label', {}, 'Upload to project'), pick), uploadBox(() => table.reload(), preset)), table];
}

async function viewNesting(id) {
  const n = await api('GET', `/api/nestings/${id}`);
  const head = pageHead(`Nesting ${n.program}`, 'nest', `${n.project_id__label || ''} · ${n.material || ''} ${n.thickness ? `${n.thickness} mm` : ''} · ${n.sheets || 0} sheet(s)`);
  const kpi = (v, l) => h('div', { class: 'kpi' }, h('div', { class: 'n' }, fmtNum(v)), h('div', { class: 'l' }, l));
  const stats = h('div', { class: 'kpis' });
  const table = recordTable('nesting_parts', { filter: { nesting_id: id }, onLoad: (rows) => stats.replaceChildren(
    kpi(new Set(rows.map((r) => r.part_no)).size, 'Part numbers'), kpi(rows.reduce((t, r) => t + (r.total_qty || 0), 0), 'Total pcs'),
    kpi(n.sheets || 0, 'Sheets'), kpi((n.cut_min || 0) * (n.sheets || 0), 'Cut time (min)')) });
  return [head, h('p', {}, h('a', { href: '#/r/nestings' }, '‹ All nesting programs')), stats, h('h2', {}, 'Part numbers in this nesting'), table];
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
    pageHead('Daily board', 'grid', 'What each process did and handed over',
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
    pageHead('Shop-floor layout', 'layout', 'Sheet metal area, drawn to scale', pick),
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
    h('div', {}, h('label', {}, 'Hour slot'), slotSelect(v.slot, !row)),
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

// Hour slots from Working time, e.g. "Day 08:30-09:30". A new entry starts on the current hour.
function slotSelect(value, pickNow) {
  const wt = state.worktime || { shifts: [] };
  const all = wt.shifts.flatMap((sh) => sh.slots.map((x) => `${sh.name} ${x.label}`));
  if (!value && pickNow) {
    const d = new Date(), now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    value = all.find((x) => { const [a, b] = x.split(' ').pop().split('-'); return a <= b ? now >= a && now < b : now >= a || now < b; }) || '';
  }
  return h('select', { name: 'slot', 'aria-label': 'Hour slot' }, h('option', { value: '' }, '—'),
    value && !all.includes(value) ? h('option', { value, selected: true }, value) : null,
    wt.shifts.map((sh) => h('optgroup', { label: `${sh.name} shift` }, sh.slots.map((x) => {
      const v = `${sh.name} ${x.label}`;
      return h('option', { value: v, selected: v === value }, `${x.label}${x.minutes < 60 ? ` (${x.minutes} min)` : ''}`);
    }))));
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
  ['galaxy', 'Galaxy', 'Purple glass cards with colour rings. Opens the Cockpit dashboard.', ['#17123f', '#7c3aed', '#f472b6', '#2dd4bf']],
  ['kit', 'Kit', 'Light cards with purple accents and a dark menu. Opens the Kit dashboard.', ['#1c232f', '#5b4fd8', '#f4f7fa', '#ffffff']],
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

// Side menu link: an icon bubble and the page name, with the same icons as the page titles.
function navLink(href, label) {
  const key = href.replace(/^#\/(r\/)?/, '');
  return h('a', { href }, h('span', { class: 'nav-i' }, icon(PAGE_ICONS[key] || 'grid')), h('span', { class: 'nav-t' }, label));
}

function renderShell() {
  const groups = {};
  for (const [name, r] of Object.entries(state.meta.resources)) {
    if (name === 'drawings' || r.nav === false) continue;
    (groups[r.group] = groups[r.group] || []).push([`#/r/${name}`, r.label]);
  }
  groups.Engineering = [['#/drawings', 'Drawings'], ['#/pm', 'PM check log'], ...(groups.Engineering || [])];
  const daily = [['#/daily', 'Daily board'], ...(groups['Daily work'] || [])];
  groups.Production = [['#/operator', 'Operator form'], ['#/roster', 'Operator roster'], ['#/hourly', 'Hourly output'], ['#/actual', 'Actual output'], ['#/layout', 'Shop-floor layout'], ...(groups.Production || [])];
  groups.Planning = [['#/plan', 'Production schedule'], ...(groups.Planning || [])];
  if (right('projects', 'create')) groups.Planning = [['#/project-new', 'New project (parts)'], ...groups.Planning];
  delete groups['Daily work'];
  const sections = Object.entries({ 'Daily work': daily, ...groups });
  if (state.user.role === 'admin') sections.push(['Admin', [['#/users', 'Users'], ['#/rights', 'Access rights'], ['#/worktime', 'Working time'], ['#/database', 'Database & backup'], ['#/audit', 'Activity log']]]);
  sections.push(['Account', [['#/account', 'My account']]]);
  // Menu slicer: chips that show one menu group at a time, plus a quick filter by page name.
  let pick = 'All';
  try { pick = localStorage.getItem('smm-menu') || 'All'; } catch (e) { /* storage blocked */ }
  if (pick !== 'All' && !sections.some(([g]) => g === pick)) pick = 'All';
  const blocks = sections.map(([g, links]) => {
    const items = links.map(([href, label]) => navLink(href, label));
    return { g, el: h('div', { class: 'nav-group' }, h('h4', {}, g), items), items };
  });
  const filter = h('input', { type: 'search', class: 'nav-find', placeholder: 'Filter menu…', 'aria-label': 'Filter menu' });
  const chips = h('div', { class: 'nav-chips', role: 'group', 'aria-label': 'Menu groups' });
  function applyMenu() {
    const q = filter.value.trim().toLowerCase();
    chips.replaceChildren(...['All', ...sections.map(([g]) => g)].map((g) => h('button', { type: 'button', class: `nav-chip${pick === g ? ' on' : ''}`, 'aria-pressed': String(pick === g),
      onclick: () => { pick = g; try { localStorage.setItem('smm-menu', g); } catch (e) { /* storage blocked */ } applyMenu(); } }, g)));
    for (const b of blocks) {
      let shown = 0;
      for (const a of b.items) { const ok = !q || a.textContent.toLowerCase().includes(q); a.hidden = !ok; if (ok) shown++; }
      b.el.hidden = !shown || (!q && pick !== 'All' && b.g !== pick);
    }
  }
  filter.addEventListener('input', applyMenu);
  applyMenu();
  const nav = h('nav', { class: 'side', id: 'side' },
    h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), h('div', {}, 'Sheet Metal Manager', h('div', { class: 'brand-sub' }, state.meta.company))),
    h('div', { class: 'nav-slicer' }, filter, chips),
    navLink('#/', 'Dashboard'),
    blocks.map((b) => b.el));
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
  projCache = null;
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  if (a !== 'layout') window.onbeforeunload = null;
  let view;
  try {
    if (!a) view = await viewDashboard();
    else if (a === 'r') view = viewList(b);
    else if (a === 'drawings') view = await viewDrawings();
    else if (a === 'pm') view = await viewPm();
    else if (a === 'plan') view = await viewPlan();
    else if (a === 'worktime') view = await viewWorktime();
    else if (a === 'database') view = await viewDatabase();
    else if (a === 'hourly') view = await viewHourly();
    else if (a === 'actual') view = await viewActual();
    else if (a === 'roster') view = await viewRoster();
    else if (a === 'nesting') view = await viewNesting(Number(b));
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
  const nodesOut = [view].flat(Infinity).filter((v) => v !== null && v !== undefined && v !== false);
  // Pages that start with a plain title get the title card with their icon.
  if (nodesOut[0] instanceof HTMLElement && nodesOut[0].tagName === 'H1') nodesOut[0] = pageHead(nodesOut[0].textContent, PAGE_ICONS[a || '']);
  content().replaceChildren(...nodesOut);
  window.scrollTo(0, 0);
}

async function start() {
  const [me, meta] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/meta')]);
  Object.assign(state, { user: me.user, rights: me.rights, version: me.version, meta });
  state.worktime = await api('GET', '/api/worktime').catch(() => null);
  applyTheme(me.user.theme);
  renderShell();
  await route();
}

window.addEventListener('hashchange', route);
start().catch(() => { if (!state.user) renderLogin(); });
