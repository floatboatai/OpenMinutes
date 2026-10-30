import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';

const root = resolve(import.meta.dirname, '../../../..');
const helper = join(import.meta.dirname, 'make-voice.mjs');
const call = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', timeout: 90_000 });

test('browse recipes and every embedded expression parse without executing Host calls', () => {
  const folder = join(import.meta.dirname, '../features');
  for (const filename of readdirSync(folder).filter(name => name.endsWith('.steps.json'))) {
    const steps = JSON.parse(readFileSync(join(folder, filename), 'utf8'));
    assert.ok(Array.isArray(steps) && steps.length > 0, filename);
    for (const step of steps) {
      assert.ok(Object.keys(step).some(key => ['goto', 'waitFor', 'waitText', 'waitNoText', 'click',
        'fill', 'select', 'press', 'eval', 'expectText', 'expectNoText', 'screenshot', 'aria', 'sleep'].includes(key)));
      if (step.eval) new Script(step.eval, { filename });
    }
  }
});

test('offline TTS creates valid short audio and protects existing fixtures', { skip: process.platform !== 'win32' }, () => {
  const work = join(root, '.workbench');
  mkdirSync(work, { recursive: true });
  const dir = mkdtempSync(join(work, 'voice-helper-test-'));
  try {
    const output = join(dir, 'REC20261029_150000.mp3');
    const result = call('--output', output);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.requestedLanguage, 'zh-CN');
    assert.ok(report.text.length > 0);
    assert.equal(report.language, report.fallback ? report.installedVoices.find(v => v.name === report.voice).language : 'zh-CN');
    assert.equal(report.sampleRate, 16000);
    assert.equal(report.channels, 1);
    assert.ok(report.duration >= 3 && report.duration <= 6);
    const hash = () => createHash('sha256').update(readFileSync(output)).digest('hex');
    assert.equal(hash(), report.sha256);
    assert.deepEqual(JSON.parse(readFileSync(`${output}.voice.json`, 'utf8')), report);

    const duplicate = call('--output', output);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists/);
    assert.equal(hash(), report.sha256);

    const englishOutput = join(dir, 'REC20261029_150100.mp3');
    const text = "The project 'review' is at three. Please arrive ten minutes early.";
    const english = call('--output', englishOutput, '--language', 'en-US', '--text', text);
    assert.equal(english.status, 0, english.stderr);
    assert.equal(JSON.parse(english.stdout).text, text);
    assert.equal(JSON.parse(english.stdout).language, 'en-US');

    const invalid = join(dir, 'invalid.mp3');
    assert.equal(call('--output', invalid).status, 1);
    assert.equal(existsSync(invalid), false);
    const unused = join(dir, 'REC20261029_150200.mp3');
    for (const args of [['--language', 'xx'], ['--text', ''], ['--text', 'a'.repeat(201)]]) {
      assert.equal(call('--output', unused, ...args).status, 1);
      assert.equal(existsSync(unused), false);
    }
    assert.ok(readdirSync(dir).every(name => !name.startsWith('.voice-')));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
