import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { ingestLocale, analyzeProject } from './analyze.js';
import { renderStored, renderMessage } from './render.js';
import { getFindings, buildJsonReport, buildCsvReport } from './reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ---------- 项目 ----------
app.get('/api/projects', (req, res) => {
  const projects = db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM locales WHERE project_id = p.id) AS locale_count,
        (SELECT COUNT(DISTINCT key) FROM messages WHERE project_id = p.id) AS key_count
       FROM projects p ORDER BY p.updated_at DESC, p.id DESC`
    )
    .all();
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const name = (req.body?.name || '').trim() || '未命名项目';
  const baseLocale = req.body?.baseLocale || null;
  const info = db.prepare('INSERT INTO projects (name, base_locale) VALUES (?, ?)').run(name, baseLocale);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.get('/api/projects/:id', (req, res) => {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ ok: false, error: '项目不存在' });

  const locales = db
    .prepare(
      `SELECT l.code, l.source, l.created_at,
        (SELECT COUNT(*) FROM messages WHERE project_id = l.project_id AND locale_code = l.code) AS key_count,
        (SELECT COUNT(*) FROM messages WHERE project_id = l.project_id AND locale_code = l.code AND parse_ok = 0 AND value_type = 'string') AS parse_error_count
       FROM locales l WHERE project_id = ? ORDER BY l.code`
    )
    .all(projectId);

  const keys = db
    .prepare(
      `SELECT key,
        GROUP_CONCAT(locale_code) AS locales,
        SUM(CASE WHEN parse_ok = 0 AND value_type = 'string' THEN 1 ELSE 0 END) AS parse_errors,
        SUM(CASE WHEN value_type != 'string' THEN 1 ELSE 0 END) AS non_strings
       FROM messages WHERE project_id = ? GROUP BY key ORDER BY key`
    )
    .all(projectId)
    .map((k) => ({ ...k, locales: k.locales ? k.locales.split(',') : [] }));

  const summary = db
    .prepare('SELECT severity, COUNT(*) AS n FROM findings WHERE project_id = ? GROUP BY severity')
    .all(projectId)
    .reduce((acc, r) => ((acc[r.severity] = r.n), acc), {});

  res.json({
    ...project,
    locales,
    keys,
    summary: { error: summary.error || 0, warning: summary.warning || 0, info: summary.info || 0 },
  });
});

app.delete('/api/projects/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: info.changes > 0 });
});

app.patch('/api/projects/:id', (req, res) => {
  const { name, baseLocale } = req.body || {};
  if (name !== undefined) {
    db.prepare('UPDATE projects SET name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      String(name),
      Number(req.params.id)
    );
  }
  if (baseLocale !== undefined) {
    db.prepare('UPDATE projects SET base_locale = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      baseLocale || null,
      Number(req.params.id)
    );
  }
  res.json({ ok: true });
});

// ---------- 语言目录 ----------
function guessLocaleFromFilename(filename) {
  const base = filename.replace(/\.json$/i, '');
  const m = base.match(/([a-z]{2,3}(?:[-_][A-Za-z0-9]+)*)$/);
  return (m ? m[1] : base).replace(/_/g, '-');
}

app.post('/api/projects/:id/locales', (req, res) => {
  const projectId = Number(req.params.id);
  const code = (req.body?.locale || '').trim();
  const content = req.body?.content ?? '';
  if (!code) return res.status(400).json({ ok: false, error: '请填写语言代码，例如 en、zh-CN' });
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ ok: false, error: '内容为空' });
  }
  const result = ingestLocale(projectId, code, content, req.body?.source || 'pasted');
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error, location: result.location || null });
  }
  const analysis = analyzeProject(projectId);
  res.json({ ok: true, ingested: result.keyCount, analysis });
});

app.post('/api/projects/:id/locales/upload', upload.array('files', 20), (req, res) => {
  const projectId = Number(req.params.id);
  const results = [];
  for (const file of req.files || []) {
    const code = (
      req.body?.[`locale:${file.originalname}`] || guessLocaleFromFilename(file.originalname)
    ).trim();
    const content = file.buffer.toString('utf8');
    const result = ingestLocale(projectId, code, content, `file:${file.originalname}`);
    results.push({ file: file.originalname, locale: code, ...result });
  }
  const failed = results.filter((r) => !r.ok);
  const analysis = results.some((r) => r.ok) ? analyzeProject(projectId) : null;
  res.status(failed.length && !analysis ? 400 : 200).json({ ok: !failed.length, results, analysis });
});

app.delete('/api/projects/:id/locales/:code', (req, res) => {
  const projectId = Number(req.params.id);
  const code = req.params.code;
  db.prepare('DELETE FROM messages WHERE project_id = ? AND locale_code = ?').run(projectId, code);
  db.prepare('DELETE FROM locales WHERE project_id = ? AND code = ?').run(projectId, code);
  const analysis = analyzeProject(projectId);
  res.json({ ok: true, analysis });
});

app.get('/api/projects/:id/messages', (req, res) => {
  const { locale, key } = req.query;
  const rows = db
    .prepare(
      `SELECT locale_code, key, message, value_type, parse_ok, parse_error, error_location
       FROM messages WHERE project_id = ? AND (? IS NULL OR locale_code = ?) AND (? IS NULL OR key = ?)
       ORDER BY locale_code, key`
    )
    .all(Number(req.params.id), locale || null, locale || null, key || null, key || null);
  res.json(rows);
});

// ---------- 审查结果 ----------
app.get('/api/projects/:id/findings', (req, res) => {
  const rows = getFindings(Number(req.params.id), {
    severity: req.query.severity || null,
    locale: req.query.locale || null,
    search: req.query.search || null,
  });
  res.json(
    rows.map((r) => ({
      ...r,
      location: r.location ? safeJson(r.location) : null,
    }))
  );
});

app.post('/api/projects/:id/analyze', (req, res) => {
  const analysis = analyzeProject(Number(req.params.id), req.body?.baseLocale || null);
  if (!analysis.ok) return res.status(404).json(analysis);
  res.json(analysis);
});

// ---------- 预览 ----------
app.post('/api/projects/:id/preview', (req, res) => {
  const { locale, key, values, inlineMessage } = req.body || {};
  let result;
  if (inlineMessage) {
    result = renderMessage(String(inlineMessage), locale || 'en', values || {});
  } else {
    if (!locale || key === undefined || key === null) {
      return res.status(400).json({ ok: false, error: '缺少 locale 或 key' });
    }
    result = renderStored(Number(req.params.id), locale, key, values || {});
  }
  res.json(result);
});

// ---------- 导出 ----------
app.get('/api/projects/:id/report.json', (req, res) => {
  const report = buildJsonReport(Number(req.params.id));
  if (!report) return res.status(404).json({ ok: false, error: '项目不存在' });
  res.setHeader('Content-Disposition', `attachment; filename="locale-contract-report-${req.params.id}.json"`);
  res.json(report);
});

app.get('/api/projects/:id/report.csv', (req, res) => {
  const csv = buildCsvReport(Number(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="locale-contract-report-${req.params.id}.csv"`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`LocaleContract running at http://localhost:${PORT}`);
});
