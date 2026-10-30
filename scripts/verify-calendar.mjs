// Runs calendar user flows with an external, pinned verify-openminutes skill.
// OPENMINUTES_VERIFY_SKILL must point to its scripts directory outside this checkout.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const runId = process.argv[2];
const skill = process.env.OPENMINUTES_VERIFY_SKILL;
if (!runId || !skill) throw new Error('Usage: OPENMINUTES_VERIFY_SKILL=<external scripts directory> node scripts/verify-calendar.mjs <runId>');
const run = JSON.parse(readFileSync(join(root, '.workbench/verify', runId, 'run.json'), 'utf8'));
const env = { ...process.env, OPENMINUTES_ROOT: root };
function command(binary, args) {
  const result = spawnSync(binary, args, { stdio: 'inherit', env, windowsHide: true });
  if (result.status !== 0) throw new Error(`Command failed: ${binary} ${args[0]}`);
}
function browse(label, steps) {
  const file = join(run.runDir, `${label}-steps.json`);
  writeFileSync(file, JSON.stringify(steps, null, 2));
  command(process.execPath, [join(skill, 'browse.mjs'), runId, label, `@${file}`]);
}
async function readback(route, filename) {
  const result = await fetch(`${run.url}${route}`, { headers: { connection: 'close' } }).then((response) => response.json());
  writeFileSync(join(run.evidenceDir, filename), JSON.stringify(result, null, 2));
  assert.equal(result.ok, true);
  return result.data;
}

command(process.execPath, [join(skill, 'doctor.mjs'), runId]);
const fixture = readFileSync(join(root, 'test-fixtures/sample-calendar.ics'), 'utf8');
// Upload through the public file input and its native change event, not through
// an API shortcut or a React state setter. The fixture bytes are unchanged.
const upload = `(() => {
  const input = document.querySelector('input[type=file]');
  const data = new DataTransfer();
  data.items.add(new File([${JSON.stringify(fixture)}], 'sample-calendar.ics', {type:'text/calendar'}));
  input.files = data.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
  return input.accept;
})()`;
browse('calendar-import', [
  { goto: '#/calendar' }, { waitText: '日历视图' },
  { screenshot: '01-before-import.png' }, { eval: upload },
  { waitText: '已导入 4 个日历事件' },
  { waitText: '产品项目评审' }, { screenshot: '02-calendar-main.png' },
  { aria: 'calendar-main.aria.txt' },
]);
const events = await readback('/api/calendar/events?start=2026-10-28T00:00:00Z&end=2026-10-31T00:00:00Z', 'imported-events.json');
assert.equal(events.length, 4);
const event = events.find((item) => item.summary === '产品项目评审');
assert.ok(event);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-ar', '16000', '-ac', '1', '-b:a', '32k', join(run.dirs.inbox, 'REC20261029_101500.mp3')]);
browse('calendar-audio-import', [
  { goto: '#/library' }, { click: 'text=导入新录音' },
  { waitText: '1 个音频文件' }, { screenshot: 'before-scan.png' },
  { click: 'text=立即扫描' },
  { waitText: '导入 1 个文件，跳过 0 个，失败 0 个', timeout: 15000 },
  { screenshot: 'after-scan.png' },
]);
const library = await readback('/api/recordings', 'recordings-imported.json');
assert.equal(library.total, 1);
const recording = library.items[0];
assert.equal(recording.hasAudioFile, true);
assert.equal(recording.durationSec, 6);
assert.ok(readdirSync(join(run.dirs.library, '2026-10')).some((name) => name.endsWith('.mp3')));
const suggestions = await readback(`/api/recordings/${recording.id}/calendar-suggestions`, 'suggestions.json');
assert.equal(suggestions[0].event.id, event.id);
browse('calendar-suggestions', [
  { goto: `#/rec/${recording.id}` }, { waitText: `建议关联到：${event.summary}` },
  { screenshot: '03-recording-suggestion.png' }, { aria: 'recording-suggestion.aria.txt' },
  { click: `text=建议关联到：${event.summary}` }, { waitText: '录音关联已更新' },
  { waitText: '解除关联' }, { screenshot: '04-suggested-link.png' },
  { click: 'text=解除关联' }, { waitText: '已解除关联' },
]);
assert.equal((await readback(`/api/recordings/${recording.id}`, 'unlinked-recording.json')).recording.calendarEventId, null);
browse('calendar-manual-link', [
  { goto: '#/calendar' },
  { fill: 'aria=日历截止日期', value: '2026-10-29' },
  { waitText: recording.filename },
  { screenshot: '05-before-link.png' },
  { select: `aria=关联事件：${recording.filename}`, value: String(event.id) },
  { waitText: '录音关联已更新' }, { waitText: '已关联事件' },
  { click: 'details[open] .calendar-event:nth-of-type(2)' }, { waitText: '生成事件纪要' },
  { waitText: recording.filename }, { screenshot: '06-event-associated.png' },
  { click: '.calendar-recording-button' }, { waitText: '尚无转录文本' },
  { screenshot: '07-recording-detail.png' },
  { click: 'text=生成事件纪要' }, { waitText: 'LLM 不可用' },
  { screenshot: '08-digest-result.png' }, { aria: 'digest-result.aria.txt' },
]);
assert.equal((await readback(`/api/recordings/${recording.id}`, 'linked-recording.json')).recording.calendarEventId, event.id);
assert.equal((await readback(`/api/calendar/events/${event.id}`, 'event-after-generation.json')).digest, null);
command(process.execPath, [join(skill, 'doctor.mjs'), runId]);
mkdirSync(join(root, 'docs/calendar-evidence'), { recursive: true });
const { copyFileSync } = await import('node:fs');
for (const [folder, filename] of [
  ['calendar-import', '02-calendar-main.png'],
  ['calendar-manual-link', '06-event-associated.png'],
  ['calendar-manual-link', '08-digest-result.png'],
  ['calendar-suggestions', '03-recording-suggestion.png'],
]) copyFileSync(join(run.evidenceDir, folder, filename), join(root, 'docs/calendar-evidence', filename));
console.log(JSON.stringify({ verified: true, url: run.url, evidence: resolve(run.evidenceDir) }));
