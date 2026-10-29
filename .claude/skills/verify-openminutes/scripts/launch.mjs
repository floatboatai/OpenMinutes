#!/usr/bin/env node
// Starts an isolated OpenMinutes server from dist/ on a random 127.0.0.1 port, then fences it off
// from the user's real world: scratch import/library dirs, auto-connect/pull/transcribe/analyze off.
// Usage: node .claude/skills/verify-openminutes/scripts/launch.mjs [runId] [--no-host]
// Prints run.json (runId, url, pid, dirs) on success.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverHost, probeHost } from './host.mjs';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const args = process.argv.slice(2);
const hostMode = args.includes('--no-host') ? 'none' : (process.env.VERIFY_HOST_MODE ?? 'floatboat');
const positional = args.filter((arg) => arg !== '--no-host');
if (!['none', 'floatboat'].includes(hostMode) || positional.length > 1
  || (positional[0] && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(positional[0]))) {
  throw new Error('usage: launch.mjs [runId] [--no-host]; VERIFY_HOST_MODE=floatboat|none');
}
const runId = positional[0] ?? `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const runDir = join(root, '.workbench', 'verify', runId);
const evidenceDir = join(root, '.workbench', 'verify-evidence', runId);
if (existsSync(runDir) || existsSync(evidenceDir)) {
  console.error(`run ${runId} or its retained evidence already exists; pick a fresh runId`);
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
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const hostConnection = hostMode === 'floatboat' ? discoverHost(manifest.appId) : undefined;
if (hostConnection) await probeHost(hostConnection);
for (const dir of [...Object.values(dirs), evidenceDir]) mkdirSync(dir, { recursive: true });
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
    ...(hostConnection ? { hostConnection } : {}),
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

let url;
try {
  url = await waitForReady();
  // Must land before the first auto-connect tick (30s) so no BLE radio or real inbox is touched.
  const isolate = await fetch(`${url}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5000),
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
  if (!isolate.ok) throw new Error('isolation PATCH failed');
} catch (error) {
  if (child.pid && child.exitCode === null) child.kill();
  throw error;
}

const run = { runId, url, pid: child.pid, nonce, root, runDir, evidenceDir, dirs, hostMode, startedAt: new Date().toISOString() };
writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
console.log(JSON.stringify({ runId, url, pid: child.pid, runDir, evidenceDir, hostMode }, null, 2));
