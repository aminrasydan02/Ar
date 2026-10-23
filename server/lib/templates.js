'use strict';
// Excel templates, Excel export and template import for every module, built from
// the module definitions in resources.js. Columns are matched by their label.
const { resources } = require('./resources');
const { readXlsx, writeXlsx } = require('./xlsx');
const { parseCsv } = require('./jtimport');

// Fields a person fills in: not set by the server, not hidden, not free-form JSON.
const inputFields = (name) => resources[name].fields.filter((f) => !f.readonly && !f.hidden && f.type !== 'json');
const header = (f) => `${f.label}${f.required ? ' *' : ''}`;
const plain = (h) => String(h ?? '').replace(/\s*\*\s*$/, '').trim().toLowerCase();

function guideRows(db, name) {
  return [['Column', 'Required', 'Type', 'Allowed values / format', 'Notes'],
    ...inputFields(name).map((f) => {
      let allowed = '';
      if (f.type === 'select') allowed = f.options.join(', ');
      else if (f.type === 'date') allowed = 'DD/MM/YYYY or YYYY-MM-DD';
      else if (f.type === 'number') allowed = 'Number';
      else if (f.type === 'ref') {
        const disp = resources[f.ref].display;
        const vals = db.prepare(`SELECT ${disp} AS v FROM ${f.ref} ORDER BY id LIMIT 30`).all().map((r) => r.v).filter((v) => v != null);
        allowed = `${resources[f.ref].singular} (${resources[f.ref].fields.find((x) => x.name === disp)?.label || disp})${vals.length ? `: ${vals.join(', ')}` : ''}`;
      }
      return [f.label, f.required ? 'Yes' : '', f.type === 'ref' ? 'Link' : f.type, allowed, f.help || ''];
    })];
}

function cellOut(f, row) {
  const v = f.type === 'ref' ? row[`${f.name}__label`] : row[f.name];
  if (v === null || v === undefined) return '';
  if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`;
  return v;
}

const widths = (fields) => fields.map((f) => Math.min(40, Math.max(12, header(f).length + 2, f.type === 'textarea' ? 30 : 0)));

// Blank template with one example row taken from the newest record, if there is one.
function templateXlsx(db, name, { company, sample }) {
  const fields = inputFields(name);
  const res = resources[name];
  const rows = [fields.map(header)];
  if (sample) rows.push(fields.map((f) => cellOut(f, sample)));
  return writeXlsx([
    { name: 'Data', title: `${company} · ${res.label} template`, rows, widths: widths(fields) },
    { name: 'Guide', title: `How to fill the ${res.label} template`, rows: guideRows(db, name), widths: [26, 10, 10, 60, 40] },
  ]);
}

function exportXlsx(name, rows, { company }) {
  const fields = resources[name].fields.filter((f) => !f.hidden && f.type !== 'json');
  const today = new Date().toISOString().slice(0, 10);
  return writeXlsx([{
    name: resources[name].label,
    title: `${company} · ${resources[name].label} · exported ${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`,
    rows: [['ID', ...fields.map((f) => f.label)], ...rows.map((r) => [r.id, ...fields.map((f) => cellOut(f, r))])],
    widths: [8, ...widths(fields)],
  }]);
}

function toIsoDate(v) {
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); // Excel serial date
  const s = String(v).trim();
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}

// Reads a filled template into plain input objects; links are resolved by their display value.
function readTemplate(db, name, buf, filename) {
  const sheets = /\.csv$/i.test(filename) ? [{ rows: parseCsv(buf.toString('utf8')) }] : readXlsx(buf);
  const fields = inputFields(name);
  const byLabel = new Map(fields.map((f) => [plain(f.label), f]));
  for (const sheet of sheets) {
    const hi = sheet.rows.findIndex((r) => r && r.filter((c) => byLabel.has(plain(c))).length >= Math.min(2, fields.length));
    if (hi < 0) continue;
    const cols = Array.from(sheet.rows[hi], (c) => byLabel.get(plain(c)) || null);
    const out = [];
    for (let i = hi + 1; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      if (!row || !row.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) continue;
      const input = {};
      const errors = [];
      cols.forEach((f, c) => {
        if (!f) return;
        let v = row[c];
        if (v === null || v === undefined || String(v).trim() === '') return;
        if (f.type === 'date') v = toIsoDate(v);
        if (f.type === 'ref') {
          const disp = resources[f.ref].display;
          const hit = db.prepare(`SELECT id FROM ${f.ref} WHERE CAST(${disp} AS TEXT) = ? COLLATE NOCASE`).get(String(v).trim());
          if (!hit) { errors.push(`${f.label} "${v}" not found`); return; }
          v = hit.id;
        }
        input[f.name] = v;
      });
      out.push({ line: i + 1, input, errors });
    }
    return out;
  }
  throw new Error('No header row matching this template was found. Download the template and keep its column names.');
}

module.exports = { templateXlsx, exportXlsx, readTemplate, inputFields };
