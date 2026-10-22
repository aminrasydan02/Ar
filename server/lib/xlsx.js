'use strict';
// Minimal .xlsx reader (no packages): returns [{ name, rows: [[cell, ...], ...] }].
// Formula cells give the value Excel saved with the file.
const zlib = require('node:zlib');

function unzip(buf) {
  // Central directory: find the end record, then walk each entry.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not an .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx file');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + skip;
  }
  return files;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
const text = (xml) => unescape([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function readXlsx(buf) {
  const files = unzip(buf);
  const get = (n) => (files[n] ? files[n]() : '');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]));
  const rels = {};
  for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]);
    const target = /Target="([^"]+)"/.exec(m[0]);
    if (id && target) rels[id[1]] = target[1].replace(/^\/?(xl\/)?/, 'xl/');
  }
  const sheets = [];
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(/name="([^"]*)"/.exec(m[0])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[0]);
    const xml = rid && rels[rid[1]] ? get(rels[rid[1]]) : '';
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row = [];
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(c[1]);
        if (!ref) continue;
        const type = (/t="(\w+)"/.exec(c[1]) || [])[1];
        const body = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        let val = null;
        if (type === 's' && v) val = shared[Number(v[1])];
        else if (type === 'inlineStr') val = text(body);
        else if (v) val = type === 'str' || type === 'e' ? unescape(v[1]) : (type === 'b' ? v[1] === '1' : Number(v[1]));
        row[colIndex(ref[1])] = val;
      }
      rows[Number(r[1]) - 1] = row;
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

module.exports = { readXlsx };
