'use strict';

/**
 * Parse and flatten JSON message catalogs.
 *
 * Nested objects are flattened with dot-separated keys (e.g. a.b.c).
 * Arrays are indexed numerically (a.0.title). Non-object values other
 * than strings are kept but flagged by the analyzer.
 */

/**
 * @param {string} text
 * @returns {{ok:true, value:*} | {ok:false, error:{message:string, line?:number, column?:number, position?:number}}}
 */
function parseCatalog(text) {
  if (text == null || String(text).trim() === '') {
    return { ok: false, error: { message: '内容为空' } };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: extractJsonError(err, String(text)) };
  }
}

function extractJsonError(err, text) {
  const message = err && err.message ? String(err.message) : '无法解析 JSON';
  let position = null;
  let line = null;
  let column = null;

  const posMatch = message.match(/position\s+(\d+)/i);
  if (posMatch) position = Number(posMatch[1]);

  const lineColMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColMatch) {
    line = Number(lineColMatch[1]);
    column = Number(lineColMatch[2]);
  }

  if (position == null && line != null && column != null) {
    const lines = text.split('\n');
    position = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      position += lines[i].length + 1;
    }
    position += Math.max(0, column - 1);
  }

  return { message, line, column, position };
}

/**
 * Flatten a parsed JSON value into ordered [keyPath, value] pairs.
 */
function flatten(value, prefix = '') {
  const out = [];
  walk(value, prefix, out);
  return out;
}

function walk(value, prefix, out) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walk(item, joinKey(prefix, String(i)), out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walk(v, joinKey(prefix, k), out);
    }
    return;
  }
  out.push([prefix || '$', value]);
}

function joinKey(prefix, part) {
  if (!prefix) return part;
  return `${prefix}.${part}`;
}

module.exports = { parseCatalog, flatten };
