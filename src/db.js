'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dataDir = config.dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const dbFile = config.dbFile || path.join(dataDir, 'localecontract.db');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  ref_locale  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locales (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  label       TEXT,
  raw_json    TEXT,
  parse_ok    INTEGER NOT NULL DEFAULT 0,
  parse_error TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ref_locale  TEXT,
  result_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  key_path    TEXT,
  locale      TEXT,
  severity    TEXT NOT NULL,
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  marks_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_findings_report ON findings(report_id);

CREATE TABLE IF NOT EXISTS samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_path    TEXT NOT NULL,
  vars_json   TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, key_path)
);
`);

module.exports = db;
