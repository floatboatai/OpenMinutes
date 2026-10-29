import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sqliteRepairStore } from '../src/server/repair-store.ts';
import { createEnvironmentRepair } from '../src/server/environment-repair.ts';
import { createHostClient } from '../sdk/host.mjs';
import type { AgentTaskRun } from '../sdk/agent-contracts.mjs';
import type { RepairState } from '../src/contracts/preflight.ts';

const report = { platform: 'win32', arch: 'x64', checkedAt: '',
  items: [{ id: 'sdk', label: 'sdk', status: 'fail' as const, reason: 'missing', autoRepair: true, action: '' }] };

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate());
}

for (const phase of ['before-submit', 'accepted-before-response', 'run-id-saved', 'terminal-saved'] as const) {
  for (const result of ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'query-failed', 'not-found'] as const) {
    test(`restart ${phase}: reconcile ${result} without new agent submission`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-recovery-'));
      const filename = path.join(root, 'repair.sqlite');
      let db = new DatabaseSync(filename);
      db.exec(await readFile(new URL('../migrations/0005_environment_repair.sql', import.meta.url), 'utf8'));
      const intent: RepairState = { status: phase === 'terminal-saved' ? 'completed' : phase === 'run-id-saved' ? 'running' : 'starting',
        idempotencyKey: 'durable-intent', runId: ['run-id-saved', 'terminal-saved'].includes(phase) ? 'existing-run' : null, text: 'before crash' };
      sqliteRepairStore(db, '/app').save(intent);
      db.close();
      db = new DatabaseSync(filename);
      const store = sqliteRepairStore(db, '/app');
      const host = createHostClient(undefined);
      let starts = 0;
      let queries = 0;
      let refreshed = 0;
      host.agent.start = async () => { starts++; throw new Error('must never submit'); };
      const lookup = async (): Promise<AgentTaskRun | null> => {
        queries++;
        if (result === 'query-failed') throw new Error('offline');
        if (result === 'not-found') return null;
        return { runId: 'existing-run', status: result, sessionId: 's', workspaceId: 'w',
          createdAt: 1, completedAt: result === 'running' ? null : 2, text: 'Host snapshot', errorCode: null };
      };
      host.agent.findByIdempotencyKey = async ({ idempotencyKey }) => {
        assert.equal(idempotencyKey, intent.idempotencyKey);
        return lookup();
      };
      host.agent.get = async ({ runId }) => {
        assert.equal(runId, 'existing-run');
        const run = await lookup();
        if (!run) throw new Error('not found');
        return run;
      };
      const repair = createEnvironmentRepair({ host, store, workingDirectory: '/app', pollMs: 5,
        report: async (refresh) => { if (refresh) refreshed++; return report; } });
      try {
        assert.equal(repair.get().status, 'recovering');
        await repair.start(); // clicking during recovery is also guarded
        await waitFor(() => queries > 0 && repair.get().status !== 'recovering');
        assert.equal(starts, 0);
        const state = repair.get();
        assert.notEqual(state.status, 'idle');
        assert.ok('idempotencyKey' in state && state.idempotencyKey === intent.idempotencyKey);
        assert.equal(state.status, ['query-failed', 'not-found'].includes(result) ? 'unknown' : result);
        if (['running', 'query-failed', 'not-found'].includes(result)) {
          await repair.start();
          assert.equal(starts, 0);
          assert.equal(refreshed, 0);
        } else {
          await waitFor(() => refreshed === 1);
        }
        assert.deepEqual(store.load(), repair.get());
      } finally {
        repair.dispose();
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('intent is committed before start; response lost across disposal recovers by original key', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../migrations/0005_environment_repair.sql', import.meta.url), 'utf8'));
  const store = sqliteRepairStore(db, '/app');
  const host = createHostClient(undefined);
  host.capabilities.list = async () => ({ sdkVersion: '1', capabilities: ['start', 'get'].map((operation) => ({
    domain: 'agent', operation, declared: true, status: 'available', readOnly: false, requiresAccount: true,
    authorization: 'checked-on-call', inputSchema: null, outputSchema: null,
  })) });
  const response = Promise.withResolvers<{ runId: string }>();
  let starts = 0;
  let key = '';
  host.agent.start = async (input) => {
    starts++;
    const saved = store.load();
    assert.ok(saved.status === 'starting' && saved.idempotencyKey === input.idempotencyKey);
    key = input.idempotencyKey;
    return response.promise;
  };
  host.agent.findByIdempotencyKey = async (input) => {
    assert.equal(input.idempotencyKey, key);
    return { runId: 'accepted', status: 'running', sessionId: 's', workspaceId: 'w', createdAt: 1, completedAt: null, text: '', errorCode: null };
  };
  const options = { host, store, workingDirectory: '/app', pollMs: 5, report: async () => report };
  const first = createEnvironmentRepair(options);
  const submitted = first.start();
  await waitFor(() => starts === 1);
  first.dispose();
  const second = createEnvironmentRepair(options);
  try {
    response.resolve({ runId: 'accepted' });
    await submitted;
    await second.start();
    await waitFor(() => second.get().status === 'running');
    assert.equal(starts, 1);
    assert.ok('runId' in second.get() && store.load().status === 'running');
  } finally {
    second.dispose();
    db.close();
  }
});

test('failed intent persistence prevents remote submission', async () => {
  const host = createHostClient(undefined);
  host.capabilities.list = async () => ({ sdkVersion: '1', capabilities: ['start', 'get'].map((operation) => ({
    domain: 'agent', operation, declared: true, status: 'available', readOnly: false, requiresAccount: true,
    authorization: 'checked-on-call', inputSchema: null, outputSchema: null,
  })) });
  let starts = 0;
  host.agent.start = async () => { starts++; return { runId: 'must-not-run' }; };
  const repair = createEnvironmentRepair({
    host, workingDirectory: '/app', report: async () => report,
    store: { load: () => ({ status: 'idle' }), save: () => { throw new Error('disk full'); } },
  });
  try {
    await assert.rejects(repair.start(), /disk full/);
    await repair.start();
    assert.equal(starts, 0);
  } finally {
    repair.dispose();
  }
});

test('corrupt durable journal fails closed rather than treating it as a fresh repair', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../migrations/0005_environment_repair.sql', import.meta.url), 'utf8'));
  try {
    db.prepare('INSERT INTO environment_repairs VALUES (?, ?)').run('/app', '{"status":"running"}');
    assert.throws(() => createEnvironmentRepair({
      host: createHostClient(undefined), store: sqliteRepairStore(db, '/app'),
      workingDirectory: '/app', report: async () => report,
    }), /Invalid repair journal/);
  } finally {
    db.close();
  }
});
