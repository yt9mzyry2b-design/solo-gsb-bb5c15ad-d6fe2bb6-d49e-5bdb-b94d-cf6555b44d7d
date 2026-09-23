import db from './db.js';
import { parseMessage, buildModel, compareModels, snippetAt } from './icu.js';

/** 将嵌套 JSON 扁平化为 dotted key -> { value, valueType } */
export function flattenJSON(obj) {
  const out = new Map();
  const walk = (prefix, value) => {
    if (value === null) {
      out.set(prefix || '$', { value: null, valueType: 'null' });
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) out.set(prefix || '$', { value: '[]', valueType: 'array' });
      value.forEach((item, i) => walk(prefix ? `${prefix}[${i}]` : `[${i}]`, item));
      return;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length === 0) out.set(prefix || '$', { value: '{}', valueType: 'object' });
      for (const [k, v] of entries) {
        const next = prefix ? `${prefix}.${k}` : k;
        walk(next, v);
      }
      return;
    }
    const t = typeof value;
    out.set(prefix || '$', {
      value: t === 'string' ? value : JSON.stringify(value),
      valueType: t === 'string' ? 'string' : t,
    });
  };
  walk('', obj);
  return out;
}

export function parseCatalog(text) {
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object') {
      return { ok: false, error: 'JSON 根节点必须是对象（或数组）' };
    }
    return { ok: true, flat: flattenJSON(data) };
  } catch (err) {
    let position = null;
    const m = /position\s+(\d+)/i.exec(err.message);
    if (m) {
      const offset = Number(m[1]);
      const before = text.slice(0, offset);
      const line = before.split('\n').length;
      const column = offset - before.lastIndexOf('\n');
      position = { start: { offset, line, column }, end: null };
    }
    return { ok: false, error: `JSON 解析失败：${err.message}`, location: position };
  }
}

const replaceLocale = db.transaction((projectId, code, flat, source) => {
  db.prepare('DELETE FROM messages WHERE project_id = ? AND locale_code = ?').run(projectId, code);
  db.prepare(
    `INSERT INTO locales (project_id, code, source) VALUES (?, ?, ?)
     ON CONFLICT(project_id, code) DO UPDATE SET source = excluded.source`
  ).run(projectId, code, source);

  const stmt = db.prepare(
    `INSERT INTO messages (project_id, locale_code, key, message, value_type, parse_ok, parse_error, error_location, ast_json)
     VALUES (@project_id, @locale_code, @key, @message, @value_type, @parse_ok, @parse_error, @error_location, @ast_json)`
  );
  for (const [key, entry] of flat) {
    const isString = entry.valueType === 'string';
    let parsed = null;
    if (isString) {
      parsed = parseMessage(entry.value);
    }
    stmt.run({
      project_id: projectId,
      locale_code: code,
      key,
      message: entry.value,
      value_type: entry.valueType,
      parse_ok: isString ? (parsed.ok ? 1 : 0) : 0,
      parse_error: isString ? (parsed.ok ? null : parsed.error) : null,
      error_location: isString && parsed.location ? JSON.stringify(parsed.location) : null,
      ast_json: isString && parsed?.ok ? JSON.stringify(parsed.ast) : null,
    });
  }
});

export function ingestLocale(projectId, code, text, source = 'pasted') {
  const result = parseCatalog(text);
  if (!result.ok) return result;
  replaceLocale(projectId, code, result.flat, source);
  return { ok: true, keyCount: result.flat.size };
}

function addFinding(f) {
  db.prepare(
    `INSERT INTO findings (project_id, key, locale_code, severity, code, message, detail, location, expected, actual)
     VALUES (@project_id, @key, @locale_code, @severity, @code, @message, @detail, @location, @expected, @actual)`
  ).run(f);
}

/** 全项目分析：解析校验 + 跨语言对比，重建 findings */
export function analyzeProject(projectId, preferredBase = null) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { ok: false, error: '项目不存在' };

  const started = Date.now();
  db.prepare('DELETE FROM findings WHERE project_id = ?').run(projectId);

  const locales = db.prepare('SELECT code FROM locales WHERE project_id = ? ORDER BY code').all(projectId);
  const messages = db
    .prepare('SELECT * FROM messages WHERE project_id = ?')
    .all(projectId);

  const byLocale = new Map();
  for (const l of locales) {
    byLocale.set(l.code, new Map());
  }
  for (const m of messages) {
    byLocale.get(m.locale_code)?.set(m.key, m);
  }

  const insert = (f) =>
    addFinding({
      project_id: projectId,
      key: null,
      locale_code: null,
      severity: 'info',
      code: '',
      message: '',
      detail: null,
      location: null,
      expected: null,
      actual: null,
      ...f,
    });

  // 各 locale 独立校验，并构建 model
  const models = new Map(); // code -> Map(key -> model)
  for (const [code, map] of byLocale) {
    const modelByKey = new Map();
    for (const [key, m] of map) {
      if (m.value_type !== 'string') {
        insert({
          key,
          locale_code: code,
          severity: 'info',
          code: 'NON_STRING_VALUE',
          message: `该键的值不是字符串（类型：${m.value_type}），未参与 ICU 对比`,
          actual: String(m.message),
        });
        continue;
      }
      if (!m.parse_ok) {
        let loc = null;
        try {
          loc = m.error_location ? JSON.parse(m.error_location) : null;
        } catch {
          loc = null;
        }
        insert({
          key,
          locale_code: code,
          severity: 'error',
          code: 'PARSE_ERROR',
          message: m.parse_error || 'ICU 语法无法解析',
          location: JSON.stringify(snippetAt(m.message, loc)),
        });
        continue;
      }
      const ast = JSON.parse(m.ast_json);
      const model = buildModel(ast);
      modelByKey.set(key, model);
      for (const c of model.localConflicts) {
        insert({
          key,
          locale_code: code,
          severity: c.severity,
          code: c.code,
          message: c.message,
          actual: c.actual ?? null,
          location: c.location ? JSON.stringify(c.location) : null,
        });
      }
    }
    models.set(code, modelByKey);
  }

  // 选择基准语言：优先指定/项目设置，其次首个“有可解析消息”的语言
  const codes = [...byLocale.keys()].sort();
  let refCode = preferredBase || project.base_locale;
  if (!refCode || !models.has(refCode) || models.get(refCode).size === 0) {
    refCode = codes.find((c) => models.get(c) && models.get(c).size > 0) || null;
  }

  if (refCode) {
    db.prepare('UPDATE projects SET base_locale = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      refCode,
      projectId
    );
  }

  const refKeys = refCode ? new Set(byLocale.get(refCode).keys()) : new Set();

  for (const code of codes) {
    if (code === refCode) continue;
    const map = byLocale.get(code);

    // 缺失 / 多余的键
    for (const key of refKeys) {
      if (!map.has(key)) {
        insert({
          key,
          locale_code: code,
          severity: 'error',
          code: 'KEY_MISSING',
          message: `缺少键 "${key}"（基准语言 ${refCode} 中存在）`,
        });
      }
    }
    for (const key of map.keys()) {
      if (!refKeys.has(key)) {
        insert({
          key,
          locale_code: code,
          severity: 'warning',
          code: 'KEY_EXTRA',
          message: `多出基准语言 ${refCode} 中不存在的键 "${key}"`,
        });
      }
    }

    // ICU 结构对比
    const refModels = models.get(refCode);
    const tgtModels = models.get(code);
    for (const key of refKeys) {
      const a = refModels?.get(key);
      const b = tgtModels?.get(key);
      if (!a || !b) continue;
      const findings = compareModels(a, b, code);
      for (const f of findings) {
        insert({
          key,
          locale_code: f.locale_code,
          severity: f.severity,
          code: f.code,
          message: f.message,
          detail: f.detail ?? null,
          expected: f.expected ?? null,
          actual: f.actual ?? null,
          location: f.location ? JSON.stringify(f.location) : null,
        });
      }
    }
  }

  const counts = db
    .prepare(
      `SELECT severity, COUNT(*) AS n FROM findings WHERE project_id = ? GROUP BY severity`
    )
    .all(projectId)
    .reduce((acc, r) => ((acc[r.severity] = r.n), acc), {});

  return {
    ok: true,
    baseLocale: refCode,
    localeCount: locales.length,
    keyCount: new Set(messages.map((m) => m.key)).size,
    summary: {
      error: counts.error || 0,
      warning: counts.warning || 0,
      info: counts.info || 0,
    },
    durationMs: Date.now() - started,
  };
}
