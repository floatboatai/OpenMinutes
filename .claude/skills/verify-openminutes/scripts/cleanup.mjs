#!/usr/bin/env node
// Stops the server this run launched (by its recorded pid, confirmed via the run's nonce) and
// deletes the run's scratch dir. Evidence in .workbench/verify-evidence/<runId>/ is never touched.
// Usage: node .claude/skills/verify-openminutes/scripts/cleanup.mjs <runId>
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const runId = process.argv[2];
if (!runId) {
  console.error('usage: cleanup.mjs <runId>');
  process.exit(2);
}
const runDir = join(root, '.workbench', 'verify', runId);
const runPath = join(runDir, 'run.json');
if (existsSync(runPath)) {
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  let ours = false;
  try {
    const health = await fetch(`${run.url}/__workbench/health`, { headers: { authorization: `Bearer ${run.nonce}` } });
    ours = health.status === 200 && (await health.json()).pid === run.pid;
  } catch {
    // Already gone.
  }
  if (ours) {
    process.kill(run.pid);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && alive(run.pid)) await new Promise((done) => setTimeout(done, 200));
    console.log(alive(run.pid) ? `pid ${run.pid} still alive` : `stopped pid ${run.pid}`);
  } else {
    console.log(`pid ${run.pid} is not answering as this run; not killing anything`);
  }
}
// The SQLite handle is released once the process exits; retry briefly for Windows file locks.
rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const evidenceDir = join(root, '.workbench', 'verify-evidence', runId);
console.log(JSON.stringify({ removed: runDir, evidenceKept: existsSync(evidenceDir) ? evidenceDir : null }));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
