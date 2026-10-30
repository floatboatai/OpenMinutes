import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import { asObject, BadInput, pathParam, reqString } from '../../contracts/input';
import { importCalendarFile } from '../calendar-import';
import { generateDayDigest, generateEventDigest } from '../calendar-digest';
import { calendarRange, calendarRecordings, getCalendarEvent, linkCalendarRecording, listCalendarEvents, parseCalendarInput, recordingSuggestions, saveCalendarEvent } from '../calendar';
import { api } from '../http';
import { readRecordingDetail } from '../repo';

export function registerCalendarRoutes(app: WorkbenchServer): void {
  app.route('GET', '/api/calendar/events/:id/digest', api((context) => ({
    digest: getCalendarEvent(context.database, pathParam(context.params, 'id')).digest,
  })));
  app.route('POST', '/api/calendar/events/:id/digest', api((context) =>
    generateEventDigest(context.database, context.host, pathParam(context.params, 'id'))));
  app.route('POST', '/api/calendar/digest', api((context) => {
    const body = asObject(context.body);
    const [start, end] = calendarRange(reqString(body, 'start'), reqString(body, 'end'));
    const day = reqString(body, 'day', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Date.parse(end) - Date.parse(start) > 25 * 3600000) {
      throw new BadInput('日报必须选择一个日期');
    }
    return generateDayDigest(context.database, context.host, start, end, day);
  }));
  app.route('POST', '/api/calendar/import', api((context) => {
    const body = asObject(context.body);
    const filename = reqString(body, 'filename', 255);
    if (!filename.toLowerCase().endsWith('.ics')) throw new BadInput('请选择 .ics 文件');
    return importCalendarFile(context.database, reqString(body, 'content', 2 * 1024 * 1024), filename);
  }));
  app.route('GET', '/api/calendar/events', api((context) => {
    const [start, end] = calendarRange(context.url.searchParams.get('start') ?? '', context.url.searchParams.get('end') ?? '');
    return listCalendarEvents(context.database, start, end);
  }));
  app.route('POST', '/api/calendar/events', api((context) => saveCalendarEvent(context.database, parseCalendarInput(context.body))));
  app.route('GET', '/api/calendar/events/:id', api((context) => getCalendarEvent(context.database, pathParam(context.params, 'id'))));
  app.route('GET', '/api/calendar/events/:id/recordings', api((context) => {
    const event = getCalendarEvent(context.database, pathParam(context.params, 'id'));
    return calendarRecordings(context.database, { eventId: event.id });
  }));
  app.route('GET', '/api/calendar/recordings', api((context) => {
    const [start, end] = calendarRange(context.url.searchParams.get('start') ?? '', context.url.searchParams.get('end') ?? '');
    return calendarRecordings(context.database, { start, end });
  }));
  app.route('GET', '/api/recordings/:id/calendar-suggestions', api((context) => recordingSuggestions(context.database, pathParam(context.params, 'id'))));
  app.route('PUT', '/api/recordings/:id', api((context) => {
    const id = pathParam(context.params, 'id');
    const value = asObject(context.body).calendar_event_id;
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      throw new BadInput('calendar_event_id 必须是正整数或 null');
    }
    linkCalendarRecording(context.database, id, value);
    return readRecordingDetail(context.database, id);
  }));
}
