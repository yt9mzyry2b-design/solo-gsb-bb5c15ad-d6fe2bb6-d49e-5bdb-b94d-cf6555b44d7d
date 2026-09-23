import db from './db.js';

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function getFindings(projectId, filters = {}) {
  const where = ['project_id = ?'];
  const params = [projectId];
  if (filters.severity) {
    where.push('severity = ?');
    params.push(filters.severity);
  }
  if (filters.locale) {
    where.push('locale_code = ?');
    params.push(filters.locale);
  }
  if (filters.search) {
    where.push('(key LIKE ? OR message LIKE ? OR code LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  return db
    .prepare(
      `SELECT * FROM findings WHERE ${where.join(' AND ')}
       ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                key, locale_code, id`
    )
    .all(...params);
}

/** 完整 JSON 报告 */
export function buildJsonReport(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;

  const locales = db
    .prepare('SELECT code, source, created_at FROM locales WHERE project_id = ? ORDER BY code')
    .all(projectId);
  const findings = getFindings(projectId);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const byLocale = {};
  for (const f of findings) {
    const lc = f.locale_code || '(all)';
    if (!byLocale[lc]) byLocale[lc] = { error: 0, warning: 0, info: 0 };
    byLocale[lc][f.severity]++;
  }

  return {
    tool: 'LocaleContract',
    generatedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      baseLocale: project.base_locale,
    },
    locales: locales.map((l) => l.code),
    summary: {
      total: findings.length,
      ...counts,
      byLocale,
    },
    findings: findings.map((f) => ({
      severity: f.severity,
      code: f.code,
      key: f.key,
      locale: f.locale_code,
      message: f.message,
      detail: f.detail,
      expected: f.expected,
      actual: f.actual,
      location: f.location ? safeParse(f.location) : null,
    })),
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const CSV_COLUMNS = [
  ['severity', '严重级别'],
  ['code', '问题代码'],
  ['locale_code', '语言'],
  ['key', '消息键'],
  ['message', '问题描述'],
  ['expected', '基准值'],
  ['actual', '当前值'],
  ['detail', '位置路径'],
  ['location', '源码位置'],
];

/** CSV 报告（带 UTF-8 BOM，Excel 友好） */
export function buildCsvReport(projectId) {
  const findings = getFindings(projectId);
  const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
  const lines = [header];
  for (const f of findings) {
    lines.push(
      CSV_COLUMNS.map(([col]) => {
        if (col === 'location') {
          if (!f.location) return '';
          const loc = safeParse(f.location);
          if (loc && typeof loc === 'object' && loc.excerpt) {
            return `${loc.line}:${loc.column}  ${loc.excerpt}`;
          }
          if (loc && typeof loc === 'object' && loc.start) {
            return `${loc.start.line}:${loc.start.column}`;
          }
          return csvEscape(typeof loc === 'string' ? loc : '');
        }
        return csvEscape(f[col]);
      }).join(',')
    );
  }
  return '﻿' + lines.join('\r\n');
}
