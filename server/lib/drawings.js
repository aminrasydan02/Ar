'use strict';
const path = require('node:path');

const FORMATS = ['pdf', 'dwg', 'idw', 'slddrw', 'ipt', 'iam', 'sldprt', 'sldasm', 'dxf', 'step', 'stp', 'png', 'jpg', 'jpeg'];
const MODEL_FORMATS = ['step', 'stp', 'ipt', 'iam', 'sldprt', 'sldasm'];

const MIME = {
  pdf: 'application/pdf',
  dxf: 'image/vnd.dxf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

// "606118901_PART_1 Rev C.pdf" -> { part_no: '606118901_PART_1', rev: 'C', format: 'pdf' }
function parseDrawingName(filename) {
  const base = path.basename(String(filename || '')).trim();
  const ext = path.extname(base).slice(1).toLowerCase();
  const stem = base.slice(0, base.length - (ext ? ext.length + 1 : 0)).trim();
  const m = stem.match(/^(.*?)[\s_-]+rev(?:ision)?[\s_.-]*([A-Za-z0-9]+)$/i);
  return {
    part_no: (m ? m[1] : stem).trim(),
    rev: m ? m[2].toUpperCase() : '',
    format: ext,
  };
}

// The file content must match its type, so a script or program cannot be uploaded
// under a drawing name. Returns an error message, or null when the file is fine.
const MAGIC = {
  pdf: (b) => b.toString('latin1', 0, 5) === '%PDF-',
  png: (b) => b.readUInt32BE(0) === 0x89504e47,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  step: (b) => /^\s*ISO-10303-21/.test(b.toString('latin1', 0, 64).replace(/^\uFEFF|^\xEF\xBB\xBF/, '')),
  dwg: (b) => /^AC\d{4}/.test(b.toString('latin1', 0, 6)),
  dxf: (b) => /^\s*(0|999)\s*\r?\n/.test(b.toString('latin1', 0, 64)) || b.toString('latin1', 0, 22) === 'AutoCAD Binary DXF\r\n\x1a',
};
MAGIC.jpeg = MAGIC.jpg;
MAGIC.stp = MAGIC.step;

function checkContent(format, buf) {
  const head = buf.toString('latin1', 0, 512);
  if (/^MZ|^\x7fELF|^#!/.test(head) || /^\s*</.test(head) || /<script|<html|<svg|<\?php|javascript:/i.test(head)) {
    return 'File content looks like a program or web page. Only drawings and 3D files are allowed';
  }
  if (MAGIC[format] && !MAGIC[format](buf)) return `File content is not a valid ${format.toUpperCase()} file`;
  return null;
}

function safeFilename(name) {
  return path.basename(String(name || 'file')).replace(/[^\w .()-]/g, '_').slice(0, 200) || 'file';
}

module.exports = { FORMATS, MODEL_FORMATS, MIME, parseDrawingName, safeFilename, checkContent };
