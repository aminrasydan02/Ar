'use strict';
// Reads Job Traveller lines from a schedule report (.xlsx or .csv) shaped like the
// NEWAYS reports: the best table with a "Part Number" column and a quantity column.
const { readXlsx } = require('./xlsx');

const clean = (v) => String(v ?? '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
const heading = (v) => clean(v).replace(/_/g, ' ');
const COLS = {
  part: (h) => /^(drawing \/ |master )?part (number|no\.?)$/i.test(h),
  process: (h) => /^(machine cell|process)$/i.test(h),
  stage: (h) => /^stage( order)?$/i.test(h),
  good: (h) => /^live actual good pcs$|^actual good qty$/i.test(h),
  label: (h) => /^order \/ part label$/i.test(h),
  drawing: (h) => /^drawing (no\.?|number)$/i.test(h),
  material: (h) => /^material( type)?$/i.test(h),
  thickness: (h) => /^thickness/i.test(h),
  cycle: (h) => /cycle time/i.test(h) && /min/i.test(h),
};
// Quantity columns, best first.
const QTY = [/^process target pcs/i, /^required qty/i, /^planned qty/i, /^total parts \(qty\)/i, /^order qty/i, /^qty/i];

function parseCsv(textIn) {
  return textIn.replace(/^﻿/, '').split(/\r?\n/).map((line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((v) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : v));
  });
}

function findTables(sheets) {
  const tables = [];
  sheets.forEach((sheet, si) => sheet.rows.forEach((row, ri) => {
    if (!row) return;
    const head = Array.from(row, heading);
    const col = {};
    for (const [k, test] of Object.entries(COLS)) { const i = head.findIndex((h) => h && test(h)); if (i >= 0) col[k] = i; }
    for (const re of QTY) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) { col.qty = i; break; } }
    if (col.part === undefined || col.qty === undefined) return;
    const score = (col.process !== undefined ? 4 : 0) + (col.cycle !== undefined ? 2 : 0) + (col.material !== undefined ? 1 : 0);
    tables.push({ si, ri, col, score });
  }));
  return tables.sort((a, b) => b.score - a.score || a.si - b.si || a.ri - b.ri);
}

const MATERIAL_NAMES = [[/alu/i, 'Aluminium'], [/stainless|^ss\b/i, 'SS'], [/spcc/i, 'SPCC'], [/secc/i, 'SECC'], [/^gi\b|galv/i, 'GI'], [/copper/i, 'Copper']];

function lines(sheets, table) {
  const out = [];
  const { col } = table;
  const rows = sheets[table.si].rows;
  for (let r = table.ri + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) break;
    const part = clean(row[col.part]);
    if (!part || /total|grand/i.test(part) || /^total/i.test(clean(row[0]))) break;
    const qty = Number(row[col.qty]);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const label = col.label !== undefined ? clean(row[col.label]) : '';
    const matText = col.material !== undefined ? clean(row[col.material]) : '';
    const thk = col.thickness !== undefined ? Number(row[col.thickness]) : Number((/(\d+(\.\d+)?)\s*mm/i.exec(matText) || [])[1]);
    const cycle = col.cycle !== undefined ? Number(row[col.cycle]) : NaN;
    out.push({
      // "606118901 part 2" becomes 606118901_PART_2, the part number used elsewhere.
      part_no: label ? label.replace(/\s+part\s+/i, '_PART_').toUpperCase() : part,
      drawing_no: label ? part : (col.drawing !== undefined ? clean(row[col.drawing]) : ''),
      material: (MATERIAL_NAMES.find(([re]) => re.test(matText)) || [null, matText ? 'Other' : null])[1],
      thickness: Number.isFinite(thk) ? thk : null,
      qty,
      cycle_min: Number.isFinite(cycle) ? Math.round(cycle * 1000) / 1000 : null,
      process_text: col.process !== undefined ? clean(row[col.process]) : null,
      seq: col.stage !== undefined ? Number((/\d+/.exec(clean(row[col.stage])) || [])[0]) * 10 || null : null,
      good: col.good !== undefined ? Number(row[col.good]) || 0 : 0,
    });
  }
  return out;
}

function matchProcess(textIn, processes) {
  const t = String(textIn || '').toUpperCase();
  return processes.find((p) => t.includes(p.name.toUpperCase())) || processes.find((p) => t.includes(p.code.toUpperCase())) || null;
}

// processes: [{ id, code, name, seq }]. Each line gets its process: from its own row
// (combined dashboard Fact_Production table) or from the report title.
function readJobTravellers(buf, filename, processes) {
  const isCsv = /\.csv$/i.test(filename);
  const sheets = isCsv ? [{ name: filename, rows: parseCsv(buf.toString('utf8')) }] : readXlsx(buf);
  // The process is named in the report title, e.g. "... FOR LASER CUTTING MACHINE".
  const title = [filename, ...sheets.slice(0, 1).flatMap((s) => s.rows.slice(0, 6).flat())].map(clean).join(' ').toUpperCase();
  const table = findTables(sheets)[0];
  if (!table) throw new Error('No table with "Part Number" and a quantity column was found');
  const fileProcess = table.col.process === undefined ? matchProcess(title, processes) : null;
  const seen = new Set();
  const out = lines(sheets, table).map((l) => {
    const p = l.process_text ? matchProcess(l.process_text, processes) : fileProcess;
    return { ...l, seq: l.seq ?? (p && p.seq) ?? null, process_id: p ? p.id : null, process: p ? p.name : l.process_text };
  }).filter((l) => { const k = `${l.part_no}|${l.process}`; return !seen.has(k) && seen.add(k); });
  return { sheet: sheets[table.si].name, lines: out };
}

module.exports = { readJobTravellers, parseCsv };
