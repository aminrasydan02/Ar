'use strict';
const path = require('node:path');

const FORMATS = ['pdf', 'dwg', 'idw', 'slddrw', 'ipt', 'iam', 'sldprt', 'sldasm', 'dxf'];

const MIME = {
  pdf: 'application/pdf',
  dxf: 'image/vnd.dxf',
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

function safeFilename(name) {
  return path.basename(String(name || 'file')).replace(/[^\w .()-]/g, '_').slice(0, 200) || 'file';
}

module.exports = { FORMATS, MIME, parseDrawingName, safeFilename };
