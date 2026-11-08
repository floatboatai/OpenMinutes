import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { HostClient } from '../sdk/host.mjs';
import { mergeAcrossWindows, parseSegmentation, type DraftScene } from '../src/server/scenes/beach.ts';
import { extractionSchema, mergeFields, normalizeFields } from '../src/server/scenes/beads.ts';
import { getSceneDay, localDayRange, rebuildSceneDay } from '../src/server/scenes/day.ts';
import { BUILTIN_TEMPLATES, activeTemplates } from '../src/server/scenes/templates.ts';
import { buildTimeline, renderUtterances, splitByGap, splitWindows, type Utterance } from '../src/server/scenes/timeline.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  return db;
}

type ObjectInput = Parameters<HostClient['llm']['generateObject']>[0];

function host(generateObject: (input: ObjectInput) => unknown, generateText: () => string = () => 'not json'): Pick<HostClient, 'llm'> {
  return {
    llm: {
      generateObject: async (input) => ({ type: 'result' as const, text: '', model: 'fake', finishReason: 'stop', requestId: 'r', object: generateObject(input) }),
      generateText: async () => ({ type: 'result' as const, text: generateText(), model: 'fake', finishReason: 'stop', requestId: 'r' }),
      async *streamText() { throw new Error('unexpected streamText'); },
    },
  };
}

const local = (time: string) => new Date(`2026-11-08T${time}`).toISOString();
const lecture = BUILTIN_TEMPLATES.find((template) => template.slug === 'lecture')!;

function addRecording(db: DatabaseSync, id: number, recordedAt: string | null, segments: Array<[number, number, string, string | null]>) {
  const text = segments.map((segment) => segment[2]).join('');
  db.prepare('INSERT INTO recordings (id, filename, dedupe_key, recorded_at, transcript_text, title) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `REC${id}.mp3`, `k${id}`, recordedAt, text || null, `录音${id}`);
  if (!text) return;
  db.prepare('INSERT INTO transcripts (recording_id, text, segments_json) VALUES (?, ?, ?)').run(
    id, text, JSON.stringify(segments.map(([startMs, endMs, segmentText, speaker]) => ({ startMs, endMs, text: segmentText, speaker }))),
  );
}

function seedDay(db: DatabaseSync) {
  addRecording(db, 1, local('10:30:00'), [
    [0, 20000, '你好，我是做跨境电商的王姐。', '1'],
    [20000, 40000, '我们做东南亚市场。', '2'],
    [40000, 60000, '那我扫你吧，加个微信。', '1'],
  ]);
  // 下午的课被录音笔切成两个文件，中间只隔 1 秒。
  addRecording(db, 2, local('14:00:00'), [[0, 30000, '今天讲增长飞轮，第一点是北极星指标。', '1']]);
  addRecording(db, 3, local('14:00:31'), [[0, 30000, '第二点是 AARRR 漏斗。', '1']]);
  addRecording(db, 4, local('16:00:00'), []);
  addRecording(db, 5, '2026-11-09T12:00:00.000Z', [[0, 1000, '别的日子', null]]);
}

function scriptedHost() {
  const calls: string[] = [];
  return {
    calls,
    host: host((input) => {
      if (input.system?.includes('拾贝')) {
        calls.push('segment');
        return input.prompt.includes('王姐')
          ? { scenes: [{ start: 1, template: 'social', sceneType: '咖啡馆初识', confidence: 0.9, title: '认识王姐', summary: '聊跨境电商并加了微信。' }] }
          : { scenes: [
            { start: 0, template: 'lecture', sceneType: '增长课程', confidence: 0.8, title: '增长飞轮', summary: '讲北极星指标。' },
            { start: 0, template: 'meeting', sceneType: '重复起点', confidence: 1, title: '应被丢弃', summary: '' },
            { start: 99, template: 'social', sceneType: '越界', confidence: 1, title: '应被丢弃', summary: '' },
          ] };
      }
      calls.push('extract');
      if (input.prompt.includes(lecture.name)) {
        return {
          speaker: { name: '讲师', role: '' },
          concepts: [{ name: '北极星指标', explanation: '最重要的单一指标', quote: '第一点是北极星指标' }, { name: '', explanation: '空名应丢弃', quote: '' }],
          methods: [{ name: 'AARRR', steps: ['获取', '激活', 7], whenToUse: '' }],
          cases: [], resources: [], experiments: [], todos: [], unexpected: 'drop me',
        };
      }
      return {
        people: [{ name: '王姐', org: '', title: '跨境电商', notes: '做东南亚市场' }],
        topics: ['跨境电商'],
        contactExchanges: [{ time: '10:30', channel: 'wechat', who: '王姐', quote: '那我扫你吧，加个微信。' }],
        followUps: [], todos: [],
      };
    }),
  };
}

test('timeline orders recordings, splits on long gaps and keeps cross-file scenes together', () => {
  const utterances = buildTimeline([
    { id: 2, title: 'b', recordedAt: local('14:00:00'), durationSec: 30, text: 'x', segments: [{ startMs: 0, endMs: 0, text: '无结束时间的句子', speaker: null }] },
    { id: 1, title: 'a', recordedAt: local('10:30:00'), durationSec: 60, text: 'y', segments: [{ startMs: 1000, endMs: 5000, text: '早上', speaker: '1' }, { startMs: 6000, endMs: 7000, text: '  ', speaker: null }] },
    { id: 3, title: 'c', recordedAt: 'not a date', durationSec: null, text: 'z', segments: [] },
    { id: 4, title: 'd', recordedAt: local('14:00:10'), durationSec: 20, text: '只有全文', segments: [] },
  ]);
  assert.deepEqual(utterances.map((utterance) => utterance.recordingId), [1, 2, 4]);
  assert.equal(utterances[0].speakerKey, '1:1');
  assert.ok(utterances[1].endMs > utterances[1].startMs, 'missing end time is estimated');
  assert.equal(utterances[2].segmentIndex, -1);
  const blocks = splitByGap(utterances);
  assert.deepEqual(blocks.map((block) => block.map((utterance) => utterance.recordingId)), [[1], [2, 4]]);
  assert.match(renderUtterances(utterances, true), /^\[0\] 10:30 说话人A：早上/);
});

test('windows respect the character budget and an oversized utterance stands alone', () => {
  const make = (text: string): Utterance => ({ recordingId: 1, segmentIndex: 0, startMs: 0, endMs: 1, at: 0, endAt: 1, text, speakerKey: null });
  const windows = splitWindows([make('aaaa'), make('bbbb'), make('cccccccccc'), make('dd')], 8);
  assert.deepEqual(windows.map((window) => window.map((utterance) => utterance.text)), [['aaaa', 'bbbb'], ['cccccccccc'], ['dd']]);
});

test('segmentation output is clamped, deduplicated, forced to start at 0 and falls back to ambient', () => {
  const slugs = ['social', 'lecture', 'ambient'];
  const starts = parseSegmentation({ scenes: [
    { start: 4, template: 'lecture', confidence: 3 },
    { start: 2, template: 'unknown', confidence: -1, title: '  t  ' },
    { start: 2, template: 'social' },
    { start: 10, template: 'social' },
    'junk',
  ] }, 6, slugs);
  assert.deepEqual(starts.map((start) => [start.start, start.templateSlug, start.confidence]), [[0, 'ambient', 0], [4, 'lecture', 1]]);
  assert.equal(starts[0].title, 't');
  assert.throws(() => parseSegmentation({ scenes: [] }, 6, slugs), /拾贝没能切出场景/);
});

test('scenes cut by a window boundary are merged back when the template matches', () => {
  const scene = (slug: string, text: string, title: string): DraftScene => ({
    utterances: [{ recordingId: 1, segmentIndex: 0, startMs: 0, endMs: 1, at: 0, endAt: 1, text, speakerKey: null }],
    templateSlug: slug, sceneType: '', confidence: 1, title, summary: title, model: null,
  });
  const merged = mergeAcrossWindows([[scene('social', 'a', '寒暄'), scene('lecture', 'bb', '上半节')], [scene('lecture', 'cccc', '下半节'), scene('musing', 'd', '随想')]]);
  assert.deepEqual(merged.map((item) => [item.templateSlug, item.title, item.utterances.length]), [['social', '寒暄', 1], ['lecture', '下半节', 2], ['musing', '随想', 1]]);
  assert.equal(merged[1].summary, '上半节 下半节');
});

test('extraction schema and normalisation follow the template fields', () => {
  const schema = extractionSchema(lecture) as { required: string[]; properties: Record<string, { type: string }> };
  assert.deepEqual(schema.required, lecture.fields.map((field) => field.key));
  assert.equal(schema.properties.speaker.type, 'object');
  assert.equal(schema.properties.concepts.type, 'array');
  const fields = normalizeFields(lecture, { concepts: [{ name: '飞轮', explanation: 1 }, { explanation: '无名' }], methods: 'oops', extra: true });
  assert.deepEqual(fields.concepts, [{ name: '飞轮', explanation: '', quote: '' }]);
  assert.deepEqual(fields.methods, []);
  assert.equal(fields.speaker, null);
  assert.equal('extra' in fields, false);
  const merged = mergeFields(lecture, [
    normalizeFields(lecture, { speaker: { name: '讲师' }, concepts: [{ name: '飞轮' }] }),
    normalizeFields(lecture, { speaker: { name: '别人' }, concepts: [{ name: '飞轮' }, { name: '漏斗' }] }),
  ]);
  assert.deepEqual((merged.speaker as { name: string }).name, '讲师');
  assert.deepEqual((merged.concepts as Array<{ name: string }>).map((item) => item.name), ['飞轮', '漏斗']);
});

test('rebuilding a day produces cross-file scenes with template extractions and tracks staleness', async () => {
  const db = database();
  seedDay(db);
  const { host: fake, calls } = scriptedHost();
  const range = localDayRange('2026-11-08');
  const result = await rebuildSceneDay(db, fake, range);
  assert.deepEqual(result, { scenes: 2, extracted: 2, failed: 0 });
  assert.deepEqual(calls, ['segment', 'segment', 'extract', 'extract']);

  const day = getSceneDay(db, range);
  assert.equal(day.status, 'done');
  assert.equal(day.stale, false);
  assert.equal(day.transcribedCount, 3);
  assert.equal(day.untranscribedCount, 1);
  assert.match(day.message ?? '', /2 个场景，2 个已整理/);
  const [social, course] = day.scenes;
  assert.equal(social.templateSlug, 'social');
  assert.equal(social.sceneType, '咖啡馆初识');
  assert.equal(social.startAt, local('10:30:00'));
  assert.deepEqual(social.sources.map((source) => source.recordingId), [1]);
  assert.equal((social.extraction?.fields.contactExchanges as Array<{ channel: string }>)[0].channel, 'wechat');
  assert.equal(course.templateSlug, 'lecture');
  assert.deepEqual(course.sources.map((source) => [source.recordingId, source.title]), [[2, '录音2'], [3, '录音3']]);
  assert.deepEqual((course.extraction?.fields.concepts as Array<{ name: string }>).map((item) => item.name), ['北极星指标']);
  assert.deepEqual((course.extraction?.fields.methods as Array<{ steps: string[] }>)[0].steps, ['获取', '激活']);
  assert.equal('unexpected' in (course.extraction?.fields ?? {}), false);

  db.prepare('INSERT INTO transcripts (recording_id, text, segments_json) VALUES (1, ?, ?)').run('改过', '[]');
  assert.equal(getSceneDay(db, range).stale, true);
});

test('Host unavailability fails the day without discarding the previous scenes', async () => {
  const db = database();
  seedDay(db);
  const range = localDayRange('2026-11-08');
  await rebuildSceneDay(db, scriptedHost().host, range);
  const offline: Pick<HostClient, 'llm'> = {
    llm: {
      generateObject: async () => { throw Object.assign(new Error('no account'), { code: 'HOST_ACCOUNT_REQUIRED' }); },
      generateText: async () => { throw new Error('unexpected'); },
      async *streamText() { throw new Error('unexpected streamText'); },
    },
  };
  await assert.rejects(() => rebuildSceneDay(db, offline, range), (error: { code?: string }) => error.code === 'LLM_UNAVAILABLE');
  const day = getSceneDay(db, range);
  assert.equal(day.status, 'failed');
  assert.equal(day.errorCode, 'LLM_UNAVAILABLE');
  assert.equal(day.scenes.length, 2);
});

test('an unparseable extraction is recorded per scene and the day still completes', async () => {
  const db = database();
  seedDay(db);
  const range = localDayRange('2026-11-08');
  const segmentOnly = host((input) => {
    if (!input.system?.includes('拾贝')) return null;
    return { scenes: [{ start: 0, template: input.prompt.includes('王姐') ? 'social' : 'ambient', sceneType: '', confidence: 0.5, title: '', summary: '' }] };
  });
  assert.deepEqual(await rebuildSceneDay(db, segmentOnly, range), { scenes: 2, extracted: 0, failed: 1 });
  const day = getSceneDay(db, range);
  assert.equal(day.scenes[0].extraction?.status, 'failed');
  assert.match(day.scenes[0].extraction?.error ?? '', /结构化结果/);
  assert.equal(day.scenes[1].extraction, null, 'ambient scenes are not extracted');
  assert.match(day.message ?? '', /1 个整理失败/);
});

test('a day left running by a restart is reported as interrupted; templates are seeded once', () => {
  const db = database();
  db.exec("INSERT INTO scene_days (day, status) VALUES ('2026-11-08', 'running')");
  const day = getSceneDay(db, localDayRange('2026-11-08'));
  assert.equal(day.status, 'failed');
  assert.equal(day.errorCode, 'INTERRUPTED');
  activeTemplates(db);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM templates').get()?.n), BUILTIN_TEMPLATES.length);
  assert.throws(() => localDayRange('2026/11/08'), /YYYY-MM-DD/);
});
