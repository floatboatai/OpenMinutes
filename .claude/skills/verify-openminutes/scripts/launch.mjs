#!/usr/bin/env node
// Starts a fresh, pre-isolated instance. Failed launches retain evidence but stop their child.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertIdentity, localOrigin, runPaths, waitStopped } from './run-safety.mjs';
import { discoverHost, probeHost } from './host.mjs';

// Fake recorder audio: real MP3 bytes so device-reported sizes match what lands on disk.
const FAKE_AUDIO = [['REC20261020_103000.mp3', 140], ['REC20261020_143000.mp3', 80], ['REC20261021_090000.mp3', 10]];

function makeFakeAudio(dir) {
  mkdirSync(dir);
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  for (const [name, seconds] of FAKE_AUDIO) {
    const made = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-ac', '1', '-b:a', '128k', join(dir, name)], { stdio: 'pipe', windowsHide: true });
    if (made.status !== 0) throw new Error(`ffmpeg could not generate fake recorder audio: ${made.stderr}`);
  }
}

export async function launch(root, runId, { readyTimeout = 30000, hostMode = 'none', fakeDevice = null } = {}) {
  if (!['none', 'floatboat'].includes(hostMode)) throw new Error('Invalid Host mode');
  if (fakeDevice !== null && !['wifi', 'ble', 'absent'].includes(fakeDevice)) throw new Error('Invalid fake device mode');
  // A real recorder switches this computer's Wi-Fi during sync; verification only drives the fake one.
  const fakeInterpreter = fakeDevice ? process.env.MEMOTALK_TEST_PYTHON : undefined;
  if (fakeDevice && !fakeInterpreter) throw new Error('--fake-device requires MEMOTALK_TEST_PYTHON (an interpreter with memotalk-sdk)');
  const paths = runPaths(root, runId);
  root = paths.root;
  const { runDir, evidenceDir } = paths;
  if (existsSync(runDir) || existsSync(evidenceDir)) throw new Error('Run or retained evidence already exists; pick a fresh runId');
  const entry = join(root, 'dist', 'server', 'index.mjs');
  if (!existsSync(entry)) throw new Error('dist/ missing; run scripts/build.mjs first');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const hostConnection = hostMode === 'floatboat' ? discoverHost(manifest.appId) : undefined;
  if (hostConnection) await probeHost(hostConnection);
  mkdirSync(join(root, '.workbench', 'verify'), { recursive: true });
  mkdirSync(join(root, '.workbench', 'verify-evidence'), { recursive: true });
  // Non-recursive mkdir reserves the ID against simultaneous launches.
  mkdirSync(runDir);
  mkdirSync(evidenceDir);
  const dirs = {
    data: join(runDir, 'data'), inbox: join(runDir, 'inbox'),
    library: join(runDir, 'library'), browserProfile: join(runDir, 'browser-profile'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const fakeAudioDir = fakeDevice ? join(runDir, 'fake-device') : null;
  if (fakeAudioDir) makeFakeAudio(fakeAudioDir);
  const values = {
    import_dir: dirs.inbox, library_dir: dirs.library,
    auto_connect: '0', auto_pull: '0', auto_transcribe: '0', auto_analyze: '0',
    ...(fakeInterpreter ? { python_path: resolve(fakeInterpreter) } : {}),
  };
  // The initial migration uses CREATE IF NOT EXISTS and INSERT OR IGNORE for settings.
  // Seed only this table so isolation is effective before any application code runs.
  const db = new DatabaseSync(join(dirs.data, 'data.sqlite'));
  try {
    db.exec(`CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(values)) insert.run(key, value);
  } finally { db.close(); }
  const nonce = randomUUID();
  const configPath = join(runDir, 'workbench-config.json');
  writeFileSync(configPath, JSON.stringify({
    appId: manifest.appId, generation: runId, nonce, sourceDirectory: root,
    dataDirectory: dirs.data, development: true,
    ...(hostConnection ? { hostConnection } : {}),
  }), { flag: 'wx' });
  const logPath = join(evidenceDir, 'server.log');
  let child;
  let log;
  let spawnError;
  try {
    log = openSync(logPath, 'wx');
    child = spawn(process.execPath, ['--enable-source-maps', entry], {
      cwd: root, env: {
        ...process.env, FLOATBOAT_WORKBENCH_CONFIG: configPath,
        ...(fakeDevice ? { OPENMINUTES_FAKE_DEVICE: fakeDevice, OPENMINUTES_FAKE_DEVICE_AUDIO_DIR: fakeAudioDir } : {}),
      },
      detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.on('error', (error) => { spawnError = error; });
    closeSync(log);
    log = undefined;
    const deadline = Date.now() + readyTimeout;
    let url;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before ready');
      // Ignore the final incomplete line while the child is still writing it.
      const lines = readFileSync(logPath, 'utf8').split('\n').slice(0, -1);
      for (const line of lines) {
        if (line.startsWith('{"type":"ready"')) url = localOrigin(JSON.parse(line).url);
      }
      if (url) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!url) throw new Error(`Server not ready; see ${logPath}`);
    const run = { runId, url, pid: child.pid, nonce, root, runDir, evidenceDir, dirs, hostMode, fakeDevice, startedAt: new Date().toISOString() };
    await assertIdentity(run);
    const response = await fetch(`${url}/api/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
      body: JSON.stringify({ values }),
    });
    const isolate = await response.json();
    if (!response.ok || !isolate.ok) throw new Error('Isolation PATCH failed');
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2), { flag: 'wx' });
    child.unref();
    return run;
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitStopped(child.pid);
    }
    throw error;
  } finally {
    if (log !== undefined) closeSync(log);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fakeArg = process.argv.find((arg) => arg.startsWith('--fake-device='));
  const args = process.argv.slice(2).filter((arg) => arg !== '--no-host' && arg !== fakeArg);
  if (args.length > 1) throw new Error('usage: launch.mjs [runId] [--no-host] [--fake-device=wifi|ble|absent]');
  const fakeDevice = fakeArg ? fakeArg.slice('--fake-device='.length) : null;
  const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
  const runId = args[0] ?? `run-${randomUUID()}`;
  const hostMode = process.argv.includes('--no-host') ? 'none' : (process.env.VERIFY_HOST_MODE ?? 'floatboat');
  const run = await launch(root, runId, { hostMode, fakeDevice });
  console.log(JSON.stringify({ runId, url: run.url, pid: run.pid, runDir: run.runDir, evidenceDir: run.evidenceDir, hostMode, fakeDevice }, null, 2));
}
