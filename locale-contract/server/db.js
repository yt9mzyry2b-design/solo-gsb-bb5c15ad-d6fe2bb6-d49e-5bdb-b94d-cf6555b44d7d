import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'localecontract.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  base_locale TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'pasted',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  locale_code TEXT NOT NULL,
  key         TEXT NOT NULL,
  message     TEXT,
  value_type  TEXT NOT NULL DEFAULT 'string',
  parse_ok    INTEGER NOT NULL DEFAULT 1,
  parse_error TEXT,
  error_location TEXT,
  ast_json    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, locale_code, key)
);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT,
  locale_code TEXT,
  severity    TEXT NOT NULL,
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      TEXT,
  location    TEXT,
  expected    TEXT,
  actual      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_lookup  ON messages(project_id, key, locale_code);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_filter  ON findings(project_id, severity, locale_code, key);
`);

export default db;
