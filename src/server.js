'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const config = require('./config');
const { analyze } = require('./lib/analyzer');
const { parseCatalog } = require('./lib/catalog');
const icu = require('./lib/icu');
const report = require('./lib/report');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- helpers ----------

function getProjectOr404(req, res) {
  const id = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return null;
  }
  return project;
}

function persistLocales(projectId, locales) {
  const upsert = db.prepare(`
    INSERT INTO locales (project_id, code, label, raw_json, parse_ok, parse_error, updated_at)
    VALUES (@projectId, @code, @label, @rawJson, @parseOk, @parseError, datetime('now'))
    ON CONFLICT(project_id, code) DO UPDATE SET
      label = excluded.label,
      raw_json = excluded.raw_json,
      parse_ok = excluded.parse_ok,
      parse_error = excluded.parse_error,
      updated_at = datetime('now')
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) upsert.run(r);
  });
  // Inputs are raw {code,label,content} objects; determine JSON validity
  // here (ICU-level validity is derived per report in the analyzer).
  tx(locales.map((l) => {
    const parsed = parseCatalog(l.content);
    return {
      projectId,
      code: l.code,
      label: l.label || '',
      rawJson: l.content,
      parseOk: parsed.ok ? 1 : 0,
      parseError: parsed.ok ? null : parsed.error.message,
    };
  }));
}

function saveReport(projectId, refLocale, result) {
  const insert = db.prepare(`
    INSERT INTO reports (project_id, ref_locale, result_json, summary_json)
    VALUES (?, ?, ?, ?)
  `);
  const insertFinding = db.prepare(`
    INSERT INTO findings (report_id, key_path, locale, severity, code, message, marks_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return db.transaction(() => {
    const info = insert.run(
      projectId,
      refLocale,
      JSON.stringify(result),
      JSON.stringify(result.summary)
    );
    const reportId = info.lastInsertRowid;
    for (const f of result.findings) {
      insertFinding.run(
        reportId,
        f.keyPath,
        f.locale,
        f.severity,
        f.code,
        f.message,
        JSON.stringify(f.marks || [])
      );
    }
    return reportId;
  })();
}

// ---------- projects ----------

app.get('/api/projects', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM locales l WHERE l.project_id = p.id) AS locale_count,
      (SELECT r.id FROM reports r WHERE r.project_id = p.id ORDER BY r.id DESC LIMIT 1) AS last_report_id
    FROM projects p ORDER BY p.updated_at DESC, p.id DESC
  `).all();
  res.json({ projects: rows });
});

app.post('/api/projects', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || '未命名项目';
  const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
  touchProject(info.lastInsertRowid);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid) });
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const locales = db.prepare('SELECT id, code, label, parse_ok, parse_error, updated_at FROM locales WHERE project_id = ? ORDER BY id').all(project.id);
  const reports = db.prepare('SELECT id, ref_locale, summary_json, created_at FROM reports WHERE project_id = ? ORDER BY id DESC LIMIT 20').all(project.id);
  res.json({ project, locales, reports });
});

app.delete('/api/projects/:id', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  res.json({ ok: true });
});

app.put('/api/projects/:id', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const name = req.body && req.body.name != null ? String(req.body.name) : project.name;
  const refLocale = req.body && 'refLocale' in req.body
    ? (req.body.refLocale == null ? null : String(req.body.refLocale))
    : project.ref_locale;
  db.prepare('UPDATE projects SET name = ?, ref_locale = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(name, refLocale, project.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) });
});

// ---------- locales ----------

app.get('/api/projects/:id/locales', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const rows = db.prepare('SELECT id, code, label, raw_json, parse_ok, parse_error FROM locales WHERE project_id = ? ORDER BY id').all(project.id);
  res.json({ locales: rows });
});

app.post('/api/projects/:id/locales', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: '语言代码不能为空,例如 en、zh-CN' });
  const content = String((req.body && req.body.content) || '');
  const label = String((req.body && req.body.label) || '');
  const parsed = parseCatalog(content);
  try {
    db.prepare(`
      INSERT INTO locales (project_id, code, label, raw_json, parse_ok, parse_error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(project.id, code, label, content, parsed.ok ? 1 : 0, parsed.ok ? null : parsed.error.message);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) {
      return res.status(409).json({ error: `语言 “${code}” 已存在` });
    }
    throw err;
  }
  touchProject(project.id);
  res.json({ ok: true });
});

app.put('/api/projects/:id/locales/:code', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const code = req.params.code;
  const content = req.body && 'content' in req.body ? String(req.body.content) : null;
  const label = req.body && 'label' in req.body ? String(req.body.label) : null;
  const row = db.prepare('SELECT * FROM locales WHERE project_id = ? AND code = ?').get(project.id, code);
  if (!row) return res.status(404).json({ error: '语言不存在' });
  let parseOk = row.parse_ok;
  let parseError = row.parse_error;
  if (content != null) {
    const parsed = parseCatalog(content);
    parseOk = parsed.ok ? 1 : 0;
    parseError = parsed.ok ? null : parsed.error.message;
  }
  db.prepare(`
    UPDATE locales
    SET label = COALESCE(?, label),
        raw_json = COALESCE(?, raw_json),
        parse_ok = ?,
        parse_error = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(label, content, parseOk, parseError, row.id);
  touchProject(project.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/locales/:code', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  db.prepare('DELETE FROM locales WHERE project_id = ? AND code = ?').run(project.id, req.params.code);
  touchProject(project.id);
  res.json({ ok: true });
});

// ---------- analyze / reports ----------

app.post('/api/projects/:id/analyze', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;

  const refLocale = req.body && req.body.refLocale ? String(req.body.refLocale) : null;
  let inputs;
  if (Array.isArray(req.body && req.body.locales)) {
    // Ad-hoc analysis of submitted contents (also persisted before analysis).
    inputs = req.body.locales
      .map(l => ({ code: String(l.code || '').trim(), label: String(l.label || ''), content: String(l.content || '') }))
      .filter(l => l.code);
    if (inputs.length) persistLocales(project.id, inputs);
  } else {
    inputs = db.prepare('SELECT code, label, raw_json AS content FROM locales WHERE project_id = ? ORDER BY id')
      .all(project.id);
  }

  if (!inputs.length) return res.status(400).json({ error: '请至少添加一种语言的 JSON' });

  const result = analyze(inputs, { refLocale: refLocale || project.ref_locale || undefined });
  if (refLocale) {
    db.prepare('UPDATE projects SET ref_locale = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(refLocale, project.id);
  }
  const reportId = saveReport(project.id, result.refLocale, result);
  touchProject(project.id);
  res.json({ reportId, result });
});

app.get('/api/projects/:id/reports', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const rows = db.prepare('SELECT id, ref_locale, summary_json, created_at FROM reports WHERE project_id = ? ORDER BY id DESC').all(project.id);
  res.json({ reports: rows });
});

app.get('/api/projects/:id/reports/:reportId', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const row = db.prepare('SELECT * FROM reports WHERE id = ? AND project_id = ?')
    .get(Number(req.params.reportId), project.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  res.json({
    reportId: row.id,
    createdAt: row.created_at,
    refLocale: row.ref_locale,
    summary: JSON.parse(row.summary_json),
    result: JSON.parse(row.result_json),
  });
});

app.get('/api/projects/:id/reports/:reportId/export', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const row = db.prepare('SELECT * FROM reports WHERE id = ? AND project_id = ?')
    .get(Number(req.params.reportId), project.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  const result = JSON.parse(row.result_json);
  const meta = {
    project: { id: project.id, name: project.name },
    reportId: row.id,
    refLocale: row.ref_locale,
    createdAt: row.created_at,
  };
  const format = String(req.query.format || 'json').toLowerCase();
  const slug = String(project.name || 'project').replace(/[^\w一-龥-]+/g, '_');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="localecontract-${slug}-${row.id}.csv"`);
    return res.send(report.toCSV(result));
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="localecontract-${slug}-${row.id}.json"`);
  res.send(report.toJSON(result, meta));
});

// ---------- live preview (no persistence) ----------

app.post('/api/preview', (req, res) => {
  const source = String((req.body && req.body.message) || '');
  const locale = String((req.body && req.body.locale) || 'en');
  const values = (req.body && req.body.values) || {};
  if (!source) return res.json({ ok: false, error: '消息为空' });
  const result = icu.renderMessage(source, locale, values);
  res.json(result);
});

// ---------- saved sample variables ----------

app.get('/api/projects/:id/samples', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const rows = db.prepare('SELECT key_path, vars_json FROM samples WHERE project_id = ?').all(project.id);
  const samples = {};
  for (const r of rows) samples[r.key_path] = JSON.parse(r.vars_json);
  res.json({ samples });
});

app.put('/api/projects/:id/samples/:keyPath', (req, res) => {
  const project = getProjectOr404(req, res);
  if (!project) return;
  const varsJson = JSON.stringify((req.body && req.body.vars) || {});
  db.prepare(`
    INSERT INTO samples (project_id, key_path, vars_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, key_path) DO UPDATE SET vars_json = excluded.vars_json, updated_at = datetime('now')
  `).run(project.id, req.params.keyPath, varsJson);
  res.json({ ok: true });
});

function touchProject(id) {
  db.prepare('UPDATE projects SET updated_at = datetime(\'now\') WHERE id = ?').run(id);
}

// ---------- error handler ----------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(config.port, config.host, () => {
  console.log(`LocaleContract running at http://localhost:${config.port}`);
});

module.exports = app;
