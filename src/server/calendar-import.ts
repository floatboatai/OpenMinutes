import ical, { type ParameterValue } from 'node-ical';
import type { DatabaseSync } from 'node:sqlite';
import type { CalendarEventInput } from '../contracts/calendar';
import { BadInput } from '../contracts/input';
import { saveCalendarEvent } from './calendar';

function text(value: ParameterValue | undefined): string {
  return typeof value === 'string' ? value : value?.val ?? '';
}

export function parseCalendarFile(content: string, source: string): Array<{ uid: string; input: CalendarEventInput }> {
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new BadInput('日历文件不能超过 2 MB');
  if (!/BEGIN:VCALENDAR/i.test(content) || !/END:VCALENDAR/i.test(content)) throw new BadInput('不是完整的 ICS 日历文件');
  let parsed;
  try {
    parsed = ical.sync.parseICS(content);
  } catch {
    throw new BadInput('ICS 文件格式无效，无法导入');
  }
  const result: Array<{ uid: string; input: CalendarEventInput }> = [];
  for (const event of Object.values(parsed)) {
    if (event?.type !== 'VEVENT') continue;
    if (event.status === 'CANCELLED') continue;
    if (event.rrule || event.recurrenceid || event.recurrences || event.rdate) {
      throw new BadInput('第一版暂不导入重复事件。请从日历导出单次事件后再导入，文件尚未写入');
    }
    if (!event.uid || !event.start || !Number.isFinite(event.start.getTime())) throw new BadInput('事件缺少 UID 或有效开始时间');
    const allDay = event.datetype === 'date';
    const end = event.end ?? new Date(event.start.getTime() + (allDay ? 86400000 : 3600000));
    if (!Number.isFinite(end.getTime()) || end <= event.start) throw new BadInput('日历事件的结束时间必须晚于开始时间');
    const attendees = event.attendee ? (Array.isArray(event.attendee) ? event.attendee : [event.attendee]) : [];
    result.push({
      uid: event.uid,
      input: {
        summary: text(event.summary) || '未命名事件', description: text(event.description),
        location: text(event.location), startTime: event.start.toISOString(), endTime: end.toISOString(),
        allDay, source,
        attendees: attendees.map((attendee) => typeof attendee === 'string'
          ? attendee.replace(/^mailto:/i, '')
          : [attendee.params.CN, attendee.val.replace(/^mailto:/i, '')].filter(Boolean).join(' <').replace(/ <([^<]+)$/, ' <$1>')),
      },
    });
    if (result.length > 2000) throw new BadInput('一次最多导入 2000 个事件');
  }
  if (!result.length) throw new BadInput('日历中没有可导入的事件');
  return result;
}

export function importCalendarFile(db: DatabaseSync, content: string, source: string) {
  const parsed = parseCalendarFile(content, source);
  db.exec('BEGIN');
  try {
    const events = parsed.map(({ uid, input }) => saveCalendarEvent(db, input, uid));
    db.exec('COMMIT');
    return { imported: events.length, events };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
