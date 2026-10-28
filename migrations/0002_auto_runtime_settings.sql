-- 运行期开关：录音库落盘位置、自动转录与自动重连。
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('auto_transcribe', '1'),
  ('auto_connect', '1'),
  ('auto_connect_minutes', '3'),
  ('library_dir', '');
