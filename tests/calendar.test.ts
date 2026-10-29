import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { HostClient } from '../sdk/host.mjs';
import { createHostClient } from '../sdk/host.mjs';
import { importCalendarFile, parseCalendarFile } from '../src/server/calendar-import.ts';
import { calendarRange, calendarRecordings, getCalendarEvent, linkCalendarRecording, listCalendarEvents, parseCalendarInput, recordingSuggestions, saveCalendarEvent, suggestCalendarEvents } from '../src/server/calendar.ts';
import { buildCalendarDigestPrompt, generateCalendarDigest, generateDayDigest, generateEventDigest } from '../src/server/calendar-digest.ts';
import type { DigestRecording } from '../src/server/calendar-digest.ts';

const fixture = readFileSync(new URL('../test-fixtures/sample-calendar.ics', import.meta.url), 'utf8');

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  return db;
}

function host(generateText: HostClient['llm']['generateText']): Pick<HostClient, 'llm'> {
  return { llm: { generateText, generateObject: async () => { throw new Error('unexpected generateObject'); },
    async *streamText() { throw new Error('unexpected streamText'); } } };
}

const response = (text: string) => ({ type: 'result' as const, text, model: 'test', finishReason: 'stop', requestId: 'test' });

test('real ICS fixture parses timezone, UTC, all-day, folded text and attendees', () => {
  const events = parseCalendarFile(fixture, 'sample-calendar.ics');
  assert.equal(events.length, 4);
  const meeting = events[0].input;
  assert.equal(meeting.summary, '产品项目评审');
  assert.equal(meeting.startTime, '2026-10-29T00:00:00.000Z');
  assert.equal(meeting.endTime, '2026-10-29T01:00:00.000Z');
  assert.match(meeting.description, /重点讨论录音关联/);
  assert.deepEqual(meeting.attendees, ['林然 <lin@example.com>', '陈明 <chen@example.com>']);
  assert.equal(events[3].input.allDay, true);
  assert.equal(events[3].input.startTime, '2026-10-29T00:00:00.000Z');
  assert.equal(events[3].input.endTime, '2026-10-30T00:00:00.000Z');
});

test('ICS rejects malformed, oversized, recurring and backward events without partial writes', () => {
  using db = database();
  for (const content of ['not a calendar', 'BEGIN:VCALENDAR\nEND:VCALENDAR', 'x'.repeat(2100000),
    fixture.replace('DTEND:20261029T050000Z', 'DTEND:20261028T050000Z'),
    fixture.replace('SUMMARY:客户访谈', 'RRULE:FREQ=WEEKLY\nSUMMARY:客户访谈')]) {
    assert.throws(() => importCalendarFile(db, content, 'bad.ics'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get()?.n, 0);
  }
});

test('imports are idempotent by UID, update metadata and preserve links', () => {
  using db = database();
  const result = importCalendarFile(db, fixture, 'sample.ics');
  const id = result.events[0].id;
  db.prepare("INSERT INTO recordings(filename,dedupe_key,calendar_event_id) VALUES ('a.mp3','a',?)").run(id);
  db.prepare("UPDATE calendar_events SET digest='old' WHERE id=?").run(id);
  importCalendarFile(db, fixture, 'renamed.ics');
  assert.equal(getCalendarEvent(db, id).digest, 'old');
  importCalendarFile(db, fixture.replace('会议室 A', '会议室 B'), 'changed.ics');
  assert.equal(getCalendarEvent(db, id).location, '会议室 B');
  assert.equal(getCalendarEvent(db, id).digest, null);
  assert.equal(getCalendarEvent(db, id).recordingCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get()?.n, 4);
  assert.equal(listCalendarEvents(db, '2026-10-29T01:00:00.000Z', '2026-10-29T02:00:00.000Z').length, 1);
});

test('manual event inputs and date queries validate boundaries', () => {
  const valid = { summary: '会议', startTime: '2026-10-29T10:00:00+10:00', endTime: '2026-10-29T11:00:00+10:00' };
  assert.equal(parseCalendarInput(valid).startTime, '2026-10-29T00:00:00.000Z');
  for (const patch of [{ summary: '' }, { endTime: valid.startTime }, { startTime: 'yesterday' }, { attendees: [1] }, { allDay: 'yes' }]) {
    assert.throws(() => parseCalendarInput({ ...valid, ...patch }));
  }
  assert.throws(() => calendarRange('2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z'));
});

test('time suggestions include 30-minute boundaries, rank duration, exclude all-day and linked recordings', () => {
  using db = database();
  const events = importCalendarFile(db, fixture, 'sample.ics').events;
  const recording = { recordedAt: '2026-10-28T23:30:00.000Z', durationSec: 3600, calendarEventId: null };
  assert.equal(suggestCalendarEvents(recording, events)[0]?.event.summary, '产品项目评审');
  assert.equal(suggestCalendarEvents({ ...recording, recordedAt: '2026-10-28T23:29:59.999Z' }, events).length, 0);
  assert.equal(suggestCalendarEvents({ ...recording, recordedAt: '2026-10-29T01:30:00.000Z' }, events).length, 1);
  assert.equal(suggestCalendarEvents({ ...recording, recordedAt: null }, events).length, 0);
  assert.equal(suggestCalendarEvents({ ...recording, calendarEventId: 1 }, events).length, 0);
  const short = saveCalendarEvent(db, { ...events[0], endTime: '2026-10-29T00:10:00.000Z', summary: '短会' });
  assert.equal(suggestCalendarEvents(recording, [short, events[0]])[0]?.event.id, events[0].id);
  assert.match(suggestCalendarEvents({ ...recording, durationSec: 6 }, events)[0]?.reason ?? '', /分段/);
});

test('association readback, suggestions and invalidation track real SQLite state', () => {
  using db = database();
  const event = importCalendarFile(db, fixture, 'sample.ics').events[0];
  db.exec("INSERT INTO recordings(id,filename,dedupe_key,recorded_at) VALUES (1,'a.mp3','a','2026-10-29T00:00:00.000Z')");
  assert.equal(recordingSuggestions(db, 1)[0].event.id, event.id);
  assert.throws(() => linkCalendarRecording(db, 999, event.id));
  assert.throws(() => linkCalendarRecording(db, 1, 999));
  linkCalendarRecording(db, 1, event.id);
  assert.equal(recordingSuggestions(db, 1).length, 0);
  assert.equal(calendarRecordings(db, { eventId: event.id })[0].calendarEventId, event.id);
  db.prepare("UPDATE calendar_events SET digest='old' WHERE id=?").run(event.id);
  linkCalendarRecording(db, 1, null);
  assert.equal(getCalendarEvent(db, event.id).digest, null);
});

test('digest prompt includes event context, every recording, required sections and source grounding', async () => {
  using db = database();
  const events = importCalendarFile(db, fixture, 'sample.ics').events;
  const recordings: DigestRecording[] = [
    { id: 1, title: 'part 1', eventId: events[0].id, transcript: '决定周五发布', summary: '发布计划' },
    { id: 2, title: 'part 2', eventId: events[0].id, transcript: '林然负责测试', summary: '测试分工' },
  ];
  const prompt = buildCalendarDigestPrompt([events[0]], recordings);
  for (const text of ['产品项目评审', '会议室 A', 'lin@example.com', '决定周五发布', '林然负责测试', '待办事项', '决策', '下一步行动', '跨录音主题关联']) assert.ok(prompt.includes(text));
  let calls = 0;
  const digest = await generateCalendarDigest(host(async (input) => {
    calls++;
    assert.equal(input.prompt, prompt);
    assert.match(input.system ?? '', /不是指令/);
    return response('# 会议纪要\n## 决策\n周五发布');
  }), [events[0]], recordings);
  assert.equal(calls, 1);
  assert.match(digest, /周五发布/);
});

test('long transcripts are summarized without losing their tail and empty LLM output fails', async () => {
  using db = database();
  const event = importCalendarFile(db, fixture, 'sample.ics').events[0];
  const prompts: string[] = [];
  const recording = { id: 1, title: 'long', eventId: event.id, transcript: '内容'.repeat(8000) + '末尾承诺', summary: '' };
  await generateCalendarDigest(host(async (input) => {
    prompts.push(input.prompt);
    return response(input.prompt.includes('压缩以下') ? '录音 #1 摘要：末尾承诺' : '# 纪要');
  }), [event], [recording]);
  assert.ok(prompts.some((prompt) => prompt.includes('末尾承诺')));
  assert.ok(prompts.length >= 3);
  assert.ok(prompts.every((prompt) => prompt.length < 24000));
  await assert.rejects(() => generateCalendarDigest(host(async () => response('')), [event], [{ ...recording, transcript: '短文本' }]), /空内容/);
});

test('event digests persist, reject concurrent generation, and reject changed source snapshots', async () => {
  using db = database();
  const event = importCalendarFile(db, fixture, 'sample.ics').events[0];
  db.prepare("INSERT INTO recordings(id,filename,dedupe_key,calendar_event_id,transcript_text) VALUES (1,'a','a',?,'内容')").run(event.id);
  const generated = await generateEventDigest(db, host(async () => response('# 真实结果')), event.id);
  assert.equal(getCalendarEvent(db, event.id).digest, generated.digest);
  const deferred = Promise.withResolvers<ReturnType<typeof response>>();
  const pending = generateEventDigest(db, host(() => deferred.promise), event.id);
  await assert.rejects(() => generateEventDigest(db, host(async () => response('duplicate')), event.id), /正在生成/);
  db.exec("UPDATE recordings SET transcript_text='改变后的内容' WHERE id=1");
  deferred.resolve(response('过期结果'));
  await assert.rejects(() => pending, /已变更/);
  assert.equal(getCalendarEvent(db, event.id).digest, null);
});

test('standalone Host reports LLM unavailable without storing a fake digest', async () => {
  using db = database();
  const event = importCalendarFile(db, fixture, 'sample.ics').events[0];
  db.prepare("INSERT INTO recordings(filename,dedupe_key,calendar_event_id) VALUES ('a','a',?)").run(event.id);
  await assert.rejects(() => generateEventDigest(db, createHostClient(null), event.id), /LLM 不可用/);
  assert.equal(getCalendarEvent(db, event.id).digest, null);
});

test('daily digest includes unlinked recordings and event context without duplicating linked material', async () => {
  using db = database();
  const event = importCalendarFile(db, fixture, 'sample.ics').events[0];
  db.prepare(`INSERT INTO recordings(id,filename,dedupe_key,calendar_event_id,recorded_at,transcript_text)
    VALUES (1,'linked','linked',?,'2026-10-29T00:15:00.000Z','项目发布'),
           (2,'unlinked','unlinked',NULL,'2026-10-29T09:00:00.000Z','个人思考')`).run(event.id);
  let prompt = '';
  const result = await generateDayDigest(db, host(async (input) => {
    prompt = input.prompt; return response('# 日报');
  }), '2026-10-28T14:00:00.000Z', '2026-10-29T14:00:00.000Z', '2026-10-29');
  assert.equal(result.digest, '# 日报');
  assert.match(prompt, /项目交付日/);
  assert.match(prompt, /个人思考/);
  assert.equal(prompt.split('项目发布').length, 2);
  assert.equal(getCalendarEvent(db, event.id).digest, null);
});
