#!/usr/bin/env node
// Read-only: is this run's instance alive, ours, current, and still fenced off from real data?
// Usage: node .claude/skills/verify-openminutes/scripts/doctor.mjs <runId>
// Exit 0 = safe to drive; exit 1 = do not drive (reasons printed).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertHostListener, probeHost } from './host.mjs';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const runId = process.argv[2];
if (!runId) {
  console.error('usage: doctor.mjs <runId>');
  process.exit(2);
}
const runPath = join(root, '.workbench', 'verify', runId, 'run.json');
if (!existsSync(runPath)) {
  console.error(`no run.json for ${runId}`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(runPath, 'utf8'));
const problems = [];
const report = { runId, url: run.url, pid: run.pid };
report.host = { mode: run.hostMode ?? 'none', available: false };
try {
  const config = JSON.parse(readFileSync(join(run.runDir, 'workbench-config.json'), 'utf8'));
  if (config.dataDirectory !== run.dirs.data || config.sourceDirectory !== root
    || config.generation !== runId || config.nonce !== run.nonce) {
    problems.push('run configuration isolation/identity mismatch');
  }
  if (report.host.mode === 'floatboat') {
    assertHostListener(config.hostConnection);
    Object.assign(report.host, await probeHost(config.hostConnection));
  } else if (config.hostConnection) {
    problems.push('HOST_MODE_CONFIG_MISMATCH');
  }
} catch (error) {
  problems.push(error.message.startsWith('HOST_') || error.message.startsWith('FLOATBOAT_')
    ? error.message : 'HOST_CONFIG_CHECK_FAILED');
}

try {
  const health = await fetch(`${run.url}/__workbench/health`, { headers: { authorization: `Bearer ${run.nonce}` } });
  const body = await health.json();
  report.health = body;
  if (health.status !== 200) problems.push(`health ${health.status}: nonce mismatch means this port is not our instance`);
  if (body.pid !== run.pid) problems.push(`health pid ${body.pid} != launched pid ${run.pid}`);
  if (body.generation !== runId) problems.push(`generation ${body.generation} != ${runId}`);
  if (body.closing) problems.push('instance is closing');
} catch (error) {
  problems.push(`unreachable: ${error.message}`);
}

if (!problems.length) {
  const settings = await fetch(`${run.url}/api/settings`).then((response) => response.json());
  const values = Object.fromEntries((settings.data ?? []).map((entry) => [entry.key, entry.value]));
  const expected = {
    import_dir: run.dirs.inbox,
    library_dir: run.dirs.library,
    auto_connect: '0',
    auto_pull: '0',
    auto_transcribe: '0',
    auto_analyze: '0',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (values[key] !== value) problems.push(`setting ${key}=${JSON.stringify(values[key])}, expected ${JSON.stringify(value)}`);
  }
}

const bundle = join(root, 'dist', 'server', 'index.mjs');
const newestSource = ['src/server', 'src/ui', 'src/contracts']
  .flatMap((dir) => readdirRecursive(join(root, dir)))
  .reduce((latest, file) => Math.max(latest, statSync(file).mtimeMs), 0);
if (statSync(bundle).mtimeMs < newestSource) problems.push('dist/ is older than src/: rebuild (build.mjs) and relaunch');

report.problems = problems;
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);

function readdirRecursive(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? readdirRecursive(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
