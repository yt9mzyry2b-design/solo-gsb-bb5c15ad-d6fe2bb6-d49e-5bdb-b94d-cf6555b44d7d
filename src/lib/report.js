'use strict';

/** JSON / CSV report export helpers. */

function toJSON(result, meta = {}) {
  return JSON.stringify({ tool: 'LocaleContract', ...meta, result }, null, 2);
}

function toCSV(result) {
  const header = ['key_path', 'locale', 'severity', 'code', 'message', 'positions'];
  const rows = [...(result.findings || [])].sort(compareFinding).map(f => [
    f.keyPath || '',
    f.locale || '',
    f.severity,
    f.code,
    f.message,
    formatMarks(f.marks),
  ]);
  const lines = [header, ...rows].map(cols => cols.map(csvCell).join(','));
  // BOM helps Excel detect UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function formatMarks(marks) {
  if (!marks || !marks.length) return '';
  return marks.map(m => `${m.start}-${m.end}`).join(';');
}

function compareFinding(a, b) {
  if (a.keyPath !== b.keyPath) return (a.keyPath || '') < (b.keyPath || '') ? -1 : 1;
  if (a.locale !== b.locale) return (a.locale || '') < (b.locale || '') ? -1 : 1;
  return 0;
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = { toJSON, toCSV };
