CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE,
  summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  attendees TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  digest TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_time > start_time)
);
CREATE INDEX idx_calendar_time ON calendar_events(start_time, end_time);
ALTER TABLE recordings ADD COLUMN calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL;
CREATE INDEX idx_recordings_event ON recordings(calendar_event_id);

-- A digest is valid only for the source material from which it was generated.
CREATE TRIGGER calendar_link_changed AFTER UPDATE OF calendar_event_id ON recordings
WHEN OLD.calendar_event_id IS NOT NEW.calendar_event_id
BEGIN
  UPDATE calendar_events SET digest = NULL WHERE id IN (OLD.calendar_event_id, NEW.calendar_event_id);
END;
CREATE TRIGGER calendar_content_changed AFTER UPDATE OF transcript_text, summary ON recordings
WHEN OLD.transcript_text IS NOT NEW.transcript_text OR OLD.summary IS NOT NEW.summary
BEGIN
  UPDATE calendar_events SET digest = NULL WHERE id = NEW.calendar_event_id;
END;
CREATE TRIGGER calendar_recording_deleted AFTER DELETE ON recordings
BEGIN
  UPDATE calendar_events SET digest = NULL WHERE id = OLD.calendar_event_id;
END;
