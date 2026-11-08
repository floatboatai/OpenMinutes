-- 场景层（拾贝 & 串珠 P1）：按天切分的场景、场景模板与按模板抽取的结果。
-- 文件级归类（recordings.title/summary/category）保持不变；场景是另一层视图。

CREATE TABLE templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  definition_json TEXT    NOT NULL,
  origin          TEXT    NOT NULL DEFAULT 'builtin',
  status          TEXT    NOT NULL DEFAULT 'active',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (slug, version)
);

-- 每天一行：处理状态，以及生成时所用的转录版本，用于判断结果是否过期。
CREATE TABLE scene_days (
  day                  TEXT PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'idle',
  message              TEXT,
  error_code           TEXT,
  source_versions_json TEXT NOT NULL DEFAULT '{}',
  engine               TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE scenes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  day              TEXT    NOT NULL REFERENCES scene_days(day) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  start_at         TEXT    NOT NULL,
  end_at           TEXT    NOT NULL,
  utterances_json  TEXT    NOT NULL DEFAULT '[]',
  scene_type       TEXT    NOT NULL DEFAULT '',
  template_slug    TEXT    NOT NULL,
  template_version INTEGER NOT NULL,
  confidence       REAL    NOT NULL DEFAULT 0,
  title            TEXT    NOT NULL DEFAULT '',
  summary          TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_scenes_day ON scenes(day, seq);

CREATE TABLE extractions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id         INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  template_slug    TEXT    NOT NULL,
  template_version INTEGER NOT NULL,
  fields_json      TEXT    NOT NULL DEFAULT '{}',
  status           TEXT    NOT NULL DEFAULT 'done',
  error            TEXT,
  model            TEXT,
  engine           TEXT    NOT NULL DEFAULT 'builtin-llm',
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_extractions_scene ON extractions(scene_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('scene_bots_enabled', '1');
