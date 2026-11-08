-- 断点续转与重启恢复：按 5 分钟块保存已识别结果；转录/归类的排队意图落库，重启后重新排队。

-- 每完成一块写一行；源文件或识别参数变化时整条录音的检查点作废。成功写入 transcripts 后删除。
CREATE TABLE IF NOT EXISTS transcribe_checkpoints (
  recording_id       INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  chunk_index        INTEGER NOT NULL,
  offset_ms          INTEGER NOT NULL,
  end_ms             INTEGER NOT NULL,
  segments_json      TEXT    NOT NULL DEFAULT '[]',
  source_size        INTEGER NOT NULL,
  source_mtime_ms    INTEGER NOT NULL,
  params_fingerprint TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (recording_id, chunk_index)
);

-- 排队意图：入队时写入，任务结束（成功或失败）时删除；等待重试期间保留。
CREATE TABLE IF NOT EXISTS queued_tasks (
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('transcribe', 'organize')),
  queued_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (recording_id, kind)
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('asr_concurrency', '3');
