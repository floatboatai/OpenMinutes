import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHostClient } from '../sdk/host.mjs';
import type { PreflightReport } from '../src/contracts/preflight.ts';
import { createEnvironmentRepair } from '../src/server/environment-repair.ts';
import type { AgentTaskRun } from '../sdk/agent-contracts.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteRepairStore } from '../src/server/repair-store.ts';

function testStore(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0005_environment_repair.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return sqliteRepairStore(db, '/app');
}

const report: PreflightReport = { platform: 'darwin', arch: 'arm64', checkedAt: 'now',
  items: [{ id: 'sdk', label: 'SDK', status: 'fail', reason: 'missing', autoRepair: true, action: 'uv run' }] };

test('unavailable agent cannot submit a task', async (t) => {
  const repair = createEnvironmentRepair({
    host: createHostClient(undefined), report: async () => report, workingDirectory: '/app', store: testStore(t),
  });
  await assert.rejects(repair.start(), /agent 不可用/);
  assert.equal(repair.get().status, 'idle');
  repair.dispose();
});

test('real SDK HTTP boundary submits once, carries safety context, polls and reruns checks', async (t) => {
  const calls: Array<{ domain: string; operation: string; input: Record<string, unknown> }> = [];
  let checks = 0;
  let gets = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    calls.push(call);
    let data: unknown;
    if (call.domain === 'capabilities') {
      data = { capabilities: ['start', 'get'].map((operation) => ({ operation, declared: true, status: 'available' })) };
    } else if (call.operation === 'start') {
      data = { runId: 'test-run' };
    } else if (call.operation === 'get') {
      gets++;
      data = { runId: 'test-run', status: gets === 1 ? 'running' : 'completed', text: 'Fixture task; no environment changed.', errorCode: null };
    } else {
      response.writeHead(500).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const repair = createEnvironmentRepair({
    host: createHostClient({ url: `http://127.0.0.1:${address.port}` }),
    store: testStore(t),
    report: async (refresh) => { if (refresh) checks++; return report; }, workingDirectory: '/app', pollMs: 10,
  });
  try {
    assert.equal(calls.length, 0, 'no silent startup agent call');
    await Promise.all([repair.start(), repair.start()]);
    await repair.start();
    const deadline = Date.now() + 3000;
    while ((repair.get().status === 'running' || checks === 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const starts = calls.filter((call) => call.operation === 'start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].input.workingDirectory, '/app');
    assert.match(String(starts[0].input.idempotencyKey), /^openminutes-preflight-/);
    const prompt = String(starts[0].input.prompt);
    for (const text of ['darwin/arm64', 'uv run', '不得删除', '系统级', '用户', '"id": "sdk"']) assert.ok(prompt.includes(text), text);
    assert.equal(checks, 1);
    assert.equal(repair.get().status, 'completed');
    assert.equal(report.items[0].status, 'fail', 'agent completion does not fabricate healthy results');
  } finally {
    repair.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
  test(`agent ${status} remains visible and triggers reinspection`, async (t) => {
    const host = createHostClient(undefined);
    host.capabilities.list = async () => ({ sdkVersion: '1', capabilities: ['start', 'get'].map((operation) => ({
      domain: 'agent', operation, declared: true, status: 'available', readOnly: false, requiresAccount: true,
      authorization: 'checked-on-call', inputSchema: null, outputSchema: null,
    })) });
    host.agent.start = async () => ({ runId: status });
    const run: AgentTaskRun = { runId: status, status, sessionId: 'session', workspaceId: 'workspace',
      createdAt: 1, completedAt: 2, text: 'Permission denied', errorCode: 'TEST_DENIED' };
    host.agent.get = async () => run;
    let refreshed = 0;
    const repair = createEnvironmentRepair({
      host, report: async (refresh) => { if (refresh) refreshed++; return report; }, workingDirectory: '/app', pollMs: 1,
      store: testStore(t),
    });
    try {
      await repair.start();
      for (let attempt = 0; attempt < 100 && !refreshed; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      const state = repair.get();
      assert.equal(state.status, status);
      assert.ok('text' in state && state.text.includes('Permission denied'));
      assert.equal(refreshed, 1);
    } finally {
      repair.dispose();
    }
  });
}

test('ambiguous submission does not allow a duplicate task when reconciliation is unavailable', async (t) => {
  const host = createHostClient(undefined);
  host.capabilities.list = async () => ({ sdkVersion: '1', capabilities: ['start', 'get'].map((operation) => ({
    domain: 'agent', operation, declared: true, status: 'available', readOnly: false, requiresAccount: true,
    authorization: 'checked-on-call', inputSchema: null, outputSchema: null,
  })) });
  let submissions = 0;
  host.agent.start = async () => { submissions++; throw new Error('connection lost after submission'); };
  host.agent.findByIdempotencyKey = async () => { throw new Error('offline'); };
  const repair = createEnvironmentRepair({ host, report: async () => report, workingDirectory: '/app', store: testStore(t) });
  try {
    await repair.start();
    await repair.start();
    assert.equal(submissions, 1);
    const state = repair.get();
    assert.equal(state.status, 'unknown');
    assert.ok('text' in state && state.text.includes('提交结果未知'));
  } finally {
    repair.dispose();
  }
});
