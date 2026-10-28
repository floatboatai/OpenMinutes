-- 录音笔工作台：录音资产管理中枢的业务表结构。
-- 时间统一使用 UTC ISO8601 文本（strftime），便于 JSON 与页面直接消费。

CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial        TEXT    NOT NULL UNIQUE,
  model         TEXT    NOT NULL DEFAULT 'MemoTalk S1',
  firmware      TEXT,
  storage_format TEXT,
  battery_pct   INTEGER,
  free_space_pct INTEGER,
  last_seen_at  TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#237a63',
  icon        TEXT    NOT NULL DEFAULT 'folder',
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS recordings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT    NOT NULL,
  dedupe_key     TEXT    NOT NULL UNIQUE,
  device_serial  TEXT,
  source         TEXT    NOT NULL DEFAULT 'folder_import',
  storage_path   TEXT,
  size_bytes     INTEGER,
  duration_sec   INTEGER,
  recorded_at    TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending',
  category_id    INTEGER REFERENCES categories(id),
  title          TEXT,
  summary        TEXT,
  transcript_text TEXT,
  importance     INTEGER,
  sentiment      TEXT,
  language       TEXT,
  speaker_count  INTEGER,
  is_favorite    INTEGER NOT NULL DEFAULT 0,
  is_archived    INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_recordings_status      ON recordings(status);
CREATE INDEX IF NOT EXISTS idx_recordings_category    ON recordings(category_id);
CREATE INDEX IF NOT EXISTS idx_recordings_recorded_at ON recordings(recorded_at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id INTEGER NOT NULL REFERENCES recordings(id),
  engine       TEXT    NOT NULL DEFAULT 'host-asr',
  language     TEXT,
  text         TEXT    NOT NULL DEFAULT '',
  segments_json TEXT   NOT NULL DEFAULT '[]',
  char_count   INTEGER NOT NULL DEFAULT 0,
  audio_ms     INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_transcripts_recording ON transcripts(recording_id);

CREATE TABLE IF NOT EXISTS analyses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id INTEGER NOT NULL REFERENCES recordings(id),
  model        TEXT,
  title        TEXT,
  summary      TEXT,
  category_slug TEXT,
  key_points_json   TEXT NOT NULL DEFAULT '[]',
  action_items_json TEXT NOT NULL DEFAULT '[]',
  tags_json         TEXT NOT NULL DEFAULT '[]',
  importance   INTEGER,
  sentiment    TEXT,
  raw_json     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_analyses_recording ON analyses(recording_id);

CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS recording_tags (
  recording_id INTEGER NOT NULL REFERENCES recordings(id),
  tag_id       INTEGER NOT NULL REFERENCES tags(id),
  source       TEXT    NOT NULL DEFAULT 'ai',
  PRIMARY KEY (recording_id, tag_id)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL,
  recording_id INTEGER,
  status       TEXT    NOT NULL DEFAULT 'running',
  message      TEXT,
  detail_json  TEXT,
  started_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_runs_recording ON job_runs(recording_id, id DESC);

CREATE TABLE IF NOT EXISTS sdk_commands (
  cmd_code   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  direction  TEXT NOT NULL,
  channel    TEXT NOT NULL,
  request_hex TEXT NOT NULL,
  response_rule TEXT NOT NULL,
  caution    INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------- 种子数据

INSERT OR IGNORE INTO categories (slug, name, color, icon, description, sort_order, is_system) VALUES
  ('meeting',      '会议纪要', '#2563eb', 'users',       '多人会议、周会、评审会',        10, 1),
  ('interview',    '客户访谈', '#7c3aed', 'mic',         '客户沟通、用户访谈、电话录音',  20, 1),
  ('idea',         '灵感想法', '#d97706', 'lightbulb',   '随手记下的点子与思考',          30, 1),
  ('todo',         '待办事项', '#dc2626', 'check-square','需要跟进的任务与承诺',          40, 1),
  ('study',        '课程学习', '#0891b2', 'graduation-cap','课程、讲座、培训录音',       50, 1),
  ('personal',     '私人生活', '#be185d', 'heart',       '个人备忘与生活记录',            60, 1),
  ('uncategorized','未分类',   '#64748b', 'inbox',       '等待归类的录音',                99, 1);

INSERT OR IGNORE INTO sdk_commands (cmd_code, name, direction, channel, request_hex, response_rule, caution, sort_order) VALUES
  ('0x01','读取电量（兼保活心跳）','read','FFF1','5A 03 01 C0 80','FFF2: 5A 04 01 [0~10] [CRC]，数值 ×10%',0,10),
  ('0x02','读取录音状态与 MAC','read','FFF1','5A 03 02 80 81','FFE2: 5A 12 02 [状态] [结果] [6B MAC] [7B BCD] [CRC]',0,20),
  ('0x03','读取动态 FTP 地址','read','FFF1','5A 03 03 41 41','FFF2: UTF-8 IP 字符串；须先开启 Wi-Fi 热点',0,30),
  ('0x04','读取动态 FTP 端口','read','FFF1','5A 03 04 00 83','FFF2: UTF-8 端口字符串，如 "2121"',0,40),
  ('0x05','读取 FTP 账号','read','FFF1','5A 03 05 C1 43','FFF2: UTF-8 用户名，如 "fulltech"',0,50),
  ('0x06','读取 FTP 密码','read','FFF1','5A 03 06 81 42','FFF2: 密文逐字节 ^0xFF 后按 UTF-8 解码',0,60),
  ('0x09','读取固件版本','read','FFF1','5A 03 09 C1 46','FFF2: 3 字节 ASCII，如 "206" = V2.0.6',0,70),
  ('0x0B','读取 Wi-Fi 热点 SSID','read','FFF1','5A 03 0B 40 87','FFF2: UTF-8 热点名，如 "MemoTalk-S1-JzYV"',0,80),
  ('0x0C','读取 Wi-Fi 热点密码','read','FFF1','5A 03 0C 01 45','FFF2: 8 字节密文，逐字节 ^0xFF 解密',0,90),
  ('0x0D','读取是否有导入文件','read','FFF1','5A 03 0D C0 85','FFF2: 0x00 无 / 0x01 有 / 0xFF 不支持 Wi-Fi',0,100),
  ('0x0F','查询剩余存储空间','read','FFF1','5A 03 0F 41 44','FFF2: 5A 05 0F [状态 01] [百分比 0~100] [CRC]',0,110),
  ('0x13','查询本地音频文件列表','read','FFF1','5A 03 13 40 8D','FFF2: 0xFF 分包流（首包 0x13 / 续包 0x1D / 尾包 0x2D）',0,120),
  ('0x14','读取设备 SN 与存储格式','read','FFF1','5A 03 14 01 4F','FFF2: [16B ASCII SN] + [1B 格式 0x00=MP3] + [1B 实时转录状态]',0,130),
  ('0xB1','读取设备设置项','read','FFF1','5A 04 B1 [Type] [CRC]','FFF2: Type 0x00 休眠秒数 / 0x01 单文件分钟 / 0x02 U 盘开关',0,140),
  ('0x91','连接握手与 RTC 对时','write','FFF1','7 字节纯 BCD [世纪,年,月,日,时,分,秒]','应答 5A 04 91 01 9C 51；连接后 1 秒内必发',0,210),
  ('0x80','录音启停控制','write','FFE1','1 字节：01 开始 / 02 暂停 / 03 恢复 / 00 停止','FFE2 回 20 字节应答；必须写往 FFE1',0,220),
  ('0xA4','开关实时转录模式','write','FFF1','0x01 开启（推 0x90 音频流）/ 0x00 关闭（推 0xA8 电平流）','录音期间设备自动推送',0,230),
  ('0x84','BLE 音频文件流同步','write','FFF1','文件名 ASCII + 3B 大端起始包号 + 1B 操作(0 开始/1 取消/2 暂停/3 继续)','FFE2 推 328B 数据包（包头 0xFFFFFF）',0,240),
  ('0x87','开关 Wi-Fi 热点','write','FFF1','开启 5A 04 87 01 92 31 / 关闭 5A 04 87 00 53 F1','传输完成后必须关闭，否则设备无法录音且耗电剧增',0,250),
  ('0x92','删除单个录音文件','write','FFF1','文件名 ASCII（≤63B）','成功 5A 04 92 01 9C A1；失败 5A 05 92 00 [Err] [CRC]',1,260),
  ('0x9A','清空全部录音文件','write','FFF1','5A 03 9A 81 2B','不可逆操作，必须二次确认',1,270),
  ('0xB0','配置设备设置项','write','FFF1','Type 0x00 + 2B 秒数 LE / 0x01 + 2B 分钟 LE / 0x02 + 1B U 盘开关','成功回 5A 04 B0 01 84 01',0,280),
  ('0xA8','实时麦克风音量电平','notify','FFE2','录音中且 0xA4=0x00 时设备自动上报','定长 9 字节：5A 07 A8 [4B IEEE754 Float LE] [2B CRC]，-120~0 dB',0,310),
  ('0x90','实时 MP3 语音数据流','notify','FFE2','录音中且 0xA4=0x01 时设备自动上报','定长 295 字节：5A 23 01 00 90 [288B MP3 帧] 00 00',0,320);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('import_dir', ''),
  ('python_path', ''),
  ('ffmpeg_path', ''),
  ('sdk_dir', ''),
  ('auto_analyze', '1'),
  ('speaker_diarization', '1'),
  ('asr_hotwords', '');
