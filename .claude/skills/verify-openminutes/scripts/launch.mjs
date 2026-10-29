#!/usr/bin/env node
// Starts an isolated OpenMinutes server from dist/ on a random 127.0.0.1 port, then fences it off
// from the user's real world: scratch import/library dirs, auto-connect/pull/transcribe/analyze off.
// Usage: node .claude/skills/verify-openminutes/scripts/launch.mjs [runId]
// Prints run.json (runId, url, pid, dirs) on success.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const runId = process.argv[2] ?? `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const runDir = join(root, '.workbench', 'verify', runId);
const evidenceDir = join(root, '.workbench', 'verify-evidence', runId);
if (existsSync(join(runDir, 'run.json'))) {
  console.error(`run ${runId} already exists; clean it up first or pick another runId`);
  process.exit(2);
}
if (!existsSync(join(root, 'dist', 'server', 'index.mjs'))) {
  console.error('dist/ missing; run scripts/build.mjs first');
  process.exit(2);
}

const dirs = {
  data: join(runDir, 'data'),
  inbox: join(runDir, 'inbox'),
  library: join(runDir, 'library'),
  browserProfile: join(runDir, 'browser-profile'),
};
for (const dir of [...Object.values(dirs), evidenceDir]) mkdirSync(dir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const nonce = randomUUID();
const configPath = join(runDir, 'workbench-config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    appId: manifest.appId,
    generation: runId,
    nonce,
    sourceDirectory: root,
    dataDirectory: dirs.data,
    development: true,
  }),
);

const logPath = join(evidenceDir, 'server.log');
const log = openSync(logPath, 'a');
const child = spawn(process.execPath, ['--enable-source-maps', join(root, 'dist', 'server', 'index.mjs')], {
  cwd: root,
  env: { ...process.env, FLOATBOAT_WORKBENCH_CONFIG: configPath },
  detached: true,
  windowsHide: true,
  stdio: ['ignore', log, log],
});
child.unref();

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    for (const line of text.split('\n')) {
      if (line.startsWith('{"type":"ready"')) return JSON.parse(line).url;
    }
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`server not ready (exit ${child.exitCode}); see ${logPath}`);
}

const url = await waitForReady();
// Must land before the first auto-connect tick (30s) so no BLE radio or real inbox is touched.
const isolate = await fetch(`${url}/api/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    values: {
      import_dir: dirs.inbox,
      library_dir: dirs.library,
      auto_connect: '0',
      auto_pull: '0',
      auto_transcribe: '0',
      auto_analyze: '0',
    },
  }),
}).then((response) => response.json());
if (!isolate.ok) {
  process.kill(child.pid);
  throw new Error(`isolation PATCH failed: ${JSON.stringify(isolate)}`);
}

const run = { runId, url, pid: child.pid, nonce, root, runDir, evidenceDir, dirs, startedAt: new Date().toISOString() };
writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
console.log(JSON.stringify({ runId, url, pid: child.pid, runDir, evidenceDir }, null, 2));
