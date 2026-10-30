import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { launch } from './launch.mjs';
import { cleanup } from './cleanup.mjs';
import { alive, runPaths, validateRunId, waitStopped } from './run-safety.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'openminutes-safety-')));
  t.after(async () => {
    const pidFile = join(root, 'child.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (alive(pid)) { process.kill(pid, 'SIGKILL'); await waitStopped(pid); }
    }
    assert.match(relative(realpathSync(tmpdir()), root), /^openminutes-safety-[^\\/]+$/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  writeFileSync(join(root, 'sentinel'), 'keep');
  return root;
}

test('all runId entry points reject traversal before touching fixture sentinels', async (t) => {
  const root = fixture(t);
  const invalid = ['', '.', '..', '../..', '..\\..', '/tmp', 'C:\\', 'a/b', 'a\\b', 'a.', 'a ', 'CON', 'nul', 'a'.repeat(81)];
  for (const id of invalid) {
    assert.throws(() => validateRunId(id), /Invalid runId/);
    await assert.rejects(cleanup(root, id), /Invalid runId/);
    await assert.rejects(launch(root, id), /Invalid runId/);
  }
  for (const script of ['launch', 'cleanup', 'doctor', 'browse']) {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, `${script}.mjs`), '../..', 'label', '[]'].slice(0, script === 'browse' ? 4 : 2), {
      env: { ...process.env, OPENMINUTES_ROOT: root }, encoding: 'utf8', windowsHide: true,
    });
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /Invalid runId/, script);
  }
  assert.equal(readFileSync(join(root, 'sentinel'), 'utf8'), 'keep');
});

test('cleanup removes only its own run, preserves other runs and retained evidence', async (t) => {
  const root = fixture(t);
  for (const path of ['verify/one', 'verify/two', 'verify-evidence/one']) {
    const dir = join(root, '.workbench', path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sentinel'), 'keep');
  }
  await cleanup(root, 'one');
  assert.equal(existsSync(join(root, '.workbench/verify/one')), false);
  for (const path of ['sentinel', '.workbench/verify/two/sentinel', '.workbench/verify-evidence/one/sentinel']) {
    assert.equal(readFileSync(join(root, path), 'utf8'), 'keep');
  }
  await assert.rejects(launch(root, 'one'), /retained evidence/);
});

for (const location of ['.workbench', '.workbench/verify', '.workbench/verify/one', '.workbench/verify/one/nested']) {
  test(`cleanup rejects escaping junction at ${location}`, async (t) => {
    const root = fixture(t);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'keep');
    const link = join(root, location);
    mkdirSync(resolve(link, '..'), { recursive: true });
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(cleanup(root, 'one'), /Unsafe linked path/);
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
    // Remove only the fixture's junction before the fixture teardown.
    rmSync(link, { recursive: true });
  });
}

function serverFixture(t, mode) {
  const root = fixture(t);
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  copyFileSync(join(import.meta.dirname, 'fixtures/server.mjs'), join(root, 'dist/server/index.mjs'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ appId: 'fixture' }));
  writeFileSync(join(root, 'fixture-mode.json'), JSON.stringify({ mode }));
  return root;
}

for (const mode of ['timeout', 'bad-ready', 'wrong-pid', 'wrong-generation', 'wrong-nonce', 'health-hang',
  'fetch-rejection', 'patch-hang', 'bad-json', 'patch-failure', 'http-error', 'write-failure']) {
  test(`failed launch stops its detached child: ${mode}`, async (t) => {
    const root = serverFixture(t, mode);
    await assert.rejects(launch(root, 'failure', { readyTimeout: mode === 'timeout' ? 1000 : 5000 }));
    const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
    assert.equal(alive(pid), false, `leaked child ${pid}`);
    const settings = Object.fromEntries(JSON.parse(readFileSync(join(root, 'initial-settings.json'), 'utf8')).map(({ key, value }) => [key, value]));
    for (const key of ['auto_connect', 'auto_pull', 'auto_transcribe', 'auto_analyze']) assert.equal(settings[key], '0');
    assert.equal(settings.import_dir, join(root, '.workbench/verify/failure/inbox'));
    assert.equal(settings.library_dir, join(root, '.workbench/verify/failure/library'));
    if (mode.startsWith('wrong-')) assert.doesNotMatch(readFileSync(join(root, 'requests.log'), 'utf8'), /PATCH/);
    assert.equal(existsSync(join(root, '.workbench/verify-evidence/failure/server.log')), true);
    await assert.rejects(launch(root, 'failure'), /already exists/);
  });
}

test('fresh launch authenticates before PATCH, cleanup stops only that child, ID stays retired', async (t) => {
  const root = serverFixture(t, 'ok');
  const run = await launch(root, 'success');
  assert.equal(alive(run.pid), true);
  assert.equal(readFileSync(join(root, 'requests.log'), 'utf8'), 'GET /__workbench/health\nPATCH /api/settings\n');
  assert.equal(JSON.parse(readFileSync(join(run.runDir, 'run.json'), 'utf8')).pid, run.pid);
  assert.equal(run.hostMode, 'none');
  assert.equal(JSON.parse(readFileSync(join(run.runDir, 'workbench-config.json'), 'utf8')).hostConnection, undefined);
  await cleanup(root, 'success');
  assert.equal(alive(run.pid), false);
  assert.equal(existsSync(run.runDir), false);
  assert.equal(existsSync(run.evidenceDir), true);
  await assert.rejects(launch(root, 'success'), /retained evidence/);
});

test('cleanup refuses a live foreign PID and retains scratch', async (t) => {
  const root = serverFixture(t, 'ok');
  const run = await launch(root, 'foreign');
  writeFileSync(join(run.runDir, 'run.json'), JSON.stringify({ ...run, pid: process.pid }));
  await assert.rejects(cleanup(root, 'foreign'), /identity mismatch/);
  assert.equal(alive(run.pid), true);
  assert.equal(existsSync(runPaths(root, 'foreign').runDir), true);
  writeFileSync(join(run.runDir, 'run.json'), JSON.stringify(run));
  await cleanup(root, 'foreign');
});

test('concurrent launches cannot share a run ID or log', async (t) => {
  const root = serverFixture(t, 'ok');
  const results = await Promise.allSettled([launch(root, 'same'), launch(root, 'same')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const log = readFileSync(join(root, '.workbench/verify-evidence/same/server.log'), 'utf8');
  assert.equal(log.split('\n').filter((line) => line.startsWith('{"type":"ready"')).length, 1);
  await cleanup(root, 'same');
});
