#!/usr/bin/env node
// Read only this run's API and database. Never export its connection config.
// Usage: evidence.mjs <runId> <label>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const [runId, label] = process.argv.slice(2);
if (![runId, label].every((s) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s))) {
  throw new Error('usage: evidence.mjs <runId> <label>');
}
const runDir = join(root, '.workbench', 'verify', runId);
const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
const health = await fetch(`${run.url}/__workbench/health`, {
  headers: { authorization: `Bearer ${run.nonce}` }, signal: AbortSignal.timeout(5000),
}).then((r) => r.json());
if (health.pid !== run.pid || health.generation !== runId) throw new Error('run identity mismatch');
const out = join(root, '.workbench', 'verify-evidence', runId, label);
mkdirSync(out, { recursive: true });
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2));
const get = async (route) => {
  const response = await fetch(`${run.url}${route}`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`API read failed: ${route}`);
  return body;
};
const recordings = await get('/api/recordings');
save('recordings.json', recordings);
save('overview.json', await get('/api/overview'));
for (const recording of recordings.data.items) {
  save(`detail-${recording.id}.json`, await get(`/api/recordings/${recording.id}`));
}
const db = new DatabaseSync(join(runDir, 'data', 'data.sqlite'), { readOnly: true });
try {
  save('job_runs.json', db.prepare('SELECT * FROM job_runs ORDER BY id').all());
  const calls = db.prepare(
    "SELECT kind, state, error_code, COUNT(*) AS count FROM _workbench_tasks WHERE kind LIKE 'asr.%' OR kind LIKE 'llm.%' GROUP BY kind, state, error_code ORDER BY kind",
  ).all();
  save('host-calls.json', calls);
  console.log(JSON.stringify({ evidence: out, calls }));
} finally {
  db.close();
}
