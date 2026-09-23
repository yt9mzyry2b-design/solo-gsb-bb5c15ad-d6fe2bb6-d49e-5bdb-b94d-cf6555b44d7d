import IMF from 'intl-messageformat';
import db from './db.js';
import { parseMessage, buildModel } from './icu.js';

const { IntlMessageFormat } = IMF;

/** 返回某条消息需要的变量及其推断类型，供前端生成表单 */
export function describeVariables(ast) {
  const model = buildModel(ast);
  return [...model.args.values()]
    .map((a) => {
      const kinds = [...new Set(a.occurrences.map((o) => o.kind))];
      const styles = [...new Set(a.occurrences.map((o) => o.style))];
      const kind = kinds[0];
      const style = styles.find((s) => s != null) ?? null;
      return {
        name: a.name,
        kind,
        allKinds: kinds,
        style,
        inputType:
          kind === 'number' || kind === 'plural' || kind === 'selectordinal'
            ? 'number'
            : kind === 'date' || kind === 'time'
              ? 'datetime-local'
              : 'text',
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

function listTags(ast) {
  const tags = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 8) {
        tags.add(n.value);
        walk(n.children);
      } else if (n.type === 5 || n.type === 6) {
        for (const opt of Object.values(n.options)) walk(opt.value);
      }
    }
  };
  walk(ast);
  return [...tags];
}

function coerceValues(raw, variables) {
  const out = {};
  for (const v of variables) {
    const val = raw[v.name];
    if (val === undefined || val === null || val === '') continue;
    if (v.kind === 'number' || v.kind === 'plural' || v.kind === 'selectordinal') {
      const num = Number(val);
      if (Number.isNaN(num)) {
        out[v.name] = val;
      } else {
        out[v.name] = num;
      }
    } else if (v.kind === 'date' || v.kind === 'time') {
      const d = new Date(val);
      out[v.name] = Number.isNaN(d.getTime()) ? val : d;
    } else {
      out[v.name] = val;
    }
  }
  return out;
}

/** 渲染单条消息 */
export function renderMessage(text, locale, rawValues) {
  const parsed = parseMessage(text);
  if (!parsed.ok) {
    return { ok: false, stage: 'parse', error: parsed.error };
  }
  const variables = describeVariables(parsed.ast);
  const values = coerceValues(rawValues || {}, variables);

  // 自动为所有富文本标签提供处理器，输出可直接展示的 HTML
  for (const tag of listTags(parsed.ast)) {
    if (!(tag in values)) {
      values[tag] = (chunks) => `<${tag}>${chunks.join('')}</${tag}>`;
    }
  }

  try {
    const formatter = new IntlMessageFormat(parsed.ast, locale || 'en');
    const parts = formatter.formatToParts(values);
    const html = parts
      .map((p) => (p.type === 'literal' ? escapeHtml(p.value) : String(p.value)))
      .join('');
    const plain = new IntlMessageFormat(parsed.ast, locale || 'en').format(values);
    return { ok: true, output: plain, html, variables };
  } catch (err) {
    return { ok: false, stage: 'render', error: err.message, variables };
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

/** 从数据库读取消息并渲染（预览接口使用） */
export function renderStored(projectId, localeCode, key, rawValues) {
  const m = db
    .prepare(
      'SELECT * FROM messages WHERE project_id = ? AND locale_code = ? AND key = ?'
    )
    .get(projectId, localeCode, key);
  if (!m) return { ok: false, stage: 'lookup', error: '未找到该消息' };
  if (m.value_type !== 'string') {
    return { ok: true, output: String(m.message), html: escapeHtml(String(m.message)), variables: [] };
  }
  return renderMessage(m.message, localeCode, rawValues);
}
