-- 设备服务：失败原因分层存储；记住录音笔 BLE 地址；传输方式与后台无线快传；用户手动断开后暂停自动连接。
ALTER TABLE recordings ADD COLUMN last_error_code TEXT;
ALTER TABLE recordings ADD COLUMN last_error_detail TEXT;
ALTER TABLE devices ADD COLUMN ble_address TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('device_transport', 'auto'), ('auto_pull_wifi', '0'), ('device_user_disconnected', '0');
