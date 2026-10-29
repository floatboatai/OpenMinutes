import type { DatabaseSync } from 'node:sqlite';
import type { CalendarEvent, CalendarEventInput, CalendarRecording, CalendarSuggestion } from '../contracts/calendar';
import { BadInput, asObject, optString, reqString } from '../contracts/input';
import { jsonArray, num, numOr, row, rows, run, str, strOr } from './sql';

export function calendarInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new BadInput('时间必须是带时区的 ISO 日期时间');
  }
  return new Date(value).toISOString();
}

export function calendarRange(start: string, end: string): [string, string] {
  const from = calendarInstant(start);
  const to = calendarInstant(end);
  if (from >= to) throw new BadInput('结束时间必须晚于开始时间');
  if (Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new BadInput('一次最多查询 366 天');
  return [from, to];
}

export function parseCalendarInput(value: unknown): CalendarEventInput {
  const body = asObject(value);
  const [startTime, endTime] = calendarRange(reqString(body, 'startTime'), reqString(body, 'endTime'));
  const attendees = body.attendees ?? [];
  if (!Array.isArray(attendees) || attendees.length > 200 || !attendees.every((item) => typeof item === 'string' && item.length <= 300)) {
    throw new BadInput('参会人必须是字符串数组，最多 200 人');
  }
  if (body.allDay !== undefined && typeof body.allDay !== 'boolean') throw new BadInput('allDay 必须是布尔值');
  return {
    summary: reqString(body, 'summary', 300), description: optString(body, 'description', 20000) ?? '',
    location: optString(body, 'location', 1000) ?? '', startTime, endTime,
    allDay: body.allDay === true, attendees, source: 'manual',
  };
}

function toEvent(item: Record<string, unknown>): CalendarEvent {
  return {
    id: numOr(item.id, 0), summary: strOr(item.summary, ''), description: strOr(item.description, ''),
    location: strOr(item.location, ''), startTime: strOr(item.start_time, ''), endTime: strOr(item.end_time, ''),
    allDay: item.all_day === 1, attendees: jsonArray(item.attendees), source: strOr(item.source, ''),
    digest: str(item.digest), recordingCount: numOr(item.recording_count, 0),
  };
}

const EVENT_SELECT = `SELECT e.*,
  (SELECT COUNT(*) FROM recordings r WHERE r.calendar_event_id = e.id) AS recording_count FROM calendar_events e`;

export function getCalendarEvent(db: DatabaseSync, id: number): CalendarEvent {
  const found = row(db, `${EVENT_SELECT} WHERE e.id = ?`, [id]);
  if (!found) throw Object.assign(new Error('日历事件不存在'), { code: 'NOT_FOUND' });
  return toEvent(found);
}

export function listCalendarEvents(db: DatabaseSync, start: string, end: string): CalendarEvent[] {
  return rows(db, `${EVENT_SELECT} WHERE e.start_time < ? AND e.end_time > ? ORDER BY e.start_time, e.id`, [end, start]).map(toEvent);
}

export function saveCalendarEvent(db: DatabaseSync, input: CalendarEventInput, uid: string | null = null): CalendarEvent {
  const result = db.prepare(`INSERT INTO calendar_events
    (uid, summary, description, location, start_time, end_time, all_day, attendees, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET summary=excluded.summary, description=excluded.description,
    location=excluded.location, start_time=excluded.start_time, end_time=excluded.end_time,
    all_day=excluded.all_day, attendees=excluded.attendees, source=excluded.source,
    digest=CASE WHEN calendar_events.summary IS excluded.summary AND calendar_events.description IS excluded.description
      AND calendar_events.location IS excluded.location AND calendar_events.start_time IS excluded.start_time
      AND calendar_events.end_time IS excluded.end_time AND calendar_events.attendees IS excluded.attendees
      THEN calendar_events.digest ELSE NULL END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING id`)
    .get(uid, input.summary, input.description, input.location, input.startTime, input.endTime,
      input.allDay ? 1 : 0, JSON.stringify(input.attendees), input.source);
  return getCalendarEvent(db, numOr(result?.id, 0));
}

export function linkCalendarRecording(db: DatabaseSync, recordingId: number, eventId: number | null): void {
  if (!row(db, 'SELECT id FROM recordings WHERE id = ?', [recordingId])) {
    throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });
  }
  if (eventId !== null) getCalendarEvent(db, eventId);
  run(db, 'UPDATE recordings SET calendar_event_id = ?, updated_at = ? WHERE id = ?', [eventId, new Date().toISOString(), recordingId]);
}

export function calendarRecordings(db: DatabaseSync, filter: { eventId: number } | { start: string; end: string }): CalendarRecording[] {
  const where = 'eventId' in filter ? 'calendar_event_id = ?' : 'COALESCE(recorded_at, created_at) >= ? AND COALESCE(recorded_at, created_at) < ?';
  const params = 'eventId' in filter ? [filter.eventId] : [filter.start, filter.end];
  return rows(db, `SELECT * FROM recordings WHERE ${where} ORDER BY COALESCE(recorded_at, created_at), id`, params).map((item) => ({
    id: numOr(item.id, 0), title: str(item.title) || strOr(item.filename, ''),
    recordedAt: str(item.recorded_at), durationSec: num(item.duration_sec),
    calendarEventId: num(item.calendar_event_id), summary: str(item.summary),
  }));
}

export function suggestCalendarEvents(recording: Pick<CalendarRecording, 'recordedAt' | 'durationSec' | 'calendarEventId'>, events: CalendarEvent[]): CalendarSuggestion[] {
  if (recording.calendarEventId !== null || !recording.recordedAt) return [];
  const start = Date.parse(recording.recordedAt);
  if (!Number.isFinite(start)) return [];
  return events.filter((event) => {
    const eventStart = Date.parse(event.startTime);
    const eventEnd = Date.parse(event.endTime);
    return !event.allDay && start >= eventStart - 1800000 && start <= eventEnd + 1800000;
  }).map((event) => {
    const eventDuration = (Date.parse(event.endTime) - Date.parse(event.startTime)) / 1000;
    const ratio = recording.durationSec ? Math.min(recording.durationSec, eventDuration) / Math.max(recording.durationSec, eventDuration) : 0;
    return { event, ratio, distance: Math.abs(start - Date.parse(event.startTime)),
      reason: ratio >= 0.5 ? '录音时间接近，时长相符' : '录音时间在事件前后 30 分钟内，可能是分段录音' };
  }).sort((a, b) => b.ratio - a.ratio || a.distance - b.distance || a.event.id - b.event.id)
    .slice(0, 3).map(({ event, reason }) => ({ event, reason }));
}

export function recordingSuggestions(db: DatabaseSync, id: number): CalendarSuggestion[] {
  const found = row(db, 'SELECT recorded_at, duration_sec, calendar_event_id FROM recordings WHERE id = ?', [id]);
  if (!found) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });
  const recordedAt = str(found.recorded_at);
  if (!recordedAt || !Number.isFinite(Date.parse(recordedAt))) return [];
  return suggestCalendarEvents({
    recordedAt, durationSec: num(found.duration_sec), calendarEventId: num(found.calendar_event_id),
  }, listCalendarEvents(db, new Date(Date.parse(recordedAt) - 1800001).toISOString(), new Date(Date.parse(recordedAt) + 1800001).toISOString()));
}
