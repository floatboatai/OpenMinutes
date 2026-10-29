#!/usr/bin/env node
// Deletes only a validated run after confirming its recorded process has stopped.
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alive, assertDeletionSafe, assertIdentity, readRun, runPaths, waitStopped } from './run-safety.mjs';

export async function cleanup(root, runId) {
  const { runDir, evidenceDir } = runPaths(root, runId);
  assertDeletionSafe(root, runId);
  if (existsSync(join(runDir, 'run.json'))) {
    const run = readRun(root, runId);
    if (alive(run.pid)) {
      await assertIdentity(run);
      process.kill(run.pid);
      await waitStopped(run.pid);
    }
  }
  // Recheck immediately before recursive removal, not only before the network request.
  assertDeletionSafe(root, runId);
  rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return { removed: runDir, evidenceKept: existsSync(evidenceDir) ? evidenceDir : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
  console.log(JSON.stringify(await cleanup(root, process.argv[2])));
}
