import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Script, createContext } from 'node:vm';

const root = join(import.meta.dirname, '..');
const recipes = {
  single: JSON.parse(readFileSync(join(root, 'features/transcribe-success.steps.json'), 'utf8'))[2].eval,
  batch: JSON.parse(readFileSync(join(root, 'features/batch-success.steps.json'), 'utf8'))[1].eval,
};

const complete = () => ({
  asr: ['start', 'sendFrame', 'events', 'stop'].map(operation => ({ operation, declared: true, status: 'available' })),
  llm: ['generateObject', 'generateText'].map(operation => ({ operation, declared: true, status: 'available' })),
});

async function runGate(expression, capabilities) {
  const calls = [];
  const context = createContext({
    Error,
    Promise,
    window: { __route: null },
    location: { hash: '#/rec/1' },
    fetch: async (url) => {
      calls.push(url);
      if (url === '/api/device/capabilities') return { ok: true, json: async () => ({ ok: true, data: capabilities }) };
      if (url === '/api/recordings/1') return { ok: true, json: async () => ({ ok: true, data: { recording: { status: 'ready' }, jobs: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    },
  });
  try {
    const result = new Script(expression).runInContext(context);
    return { calls, result: await result };
  } catch (error) {
    error.calls = calls;
    throw error;
  }
}

test('partial capabilities fail closed before any paid recording request', async () => {
  const partial = complete();
  partial.asr = partial.asr.filter(item => item.operation !== 'sendFrame');
  for (const expression of Object.values(recipes)) {
    let error;
    try {
      await runGate(expression, partial);
    } catch (caught) {
      error = caught;
    }
    assert.match(error?.message ?? '', /capabilities incomplete/);
    assert.deepEqual(error.calls, ['/api/device/capabilities']);
  }
});

test('complete ASR and LLM capabilities pass the gate before the recording precondition', async () => {
  for (const expression of Object.values(recipes)) {
    const result = await runGate(expression, complete());
    const expected = expression.includes('/api/recordings/1')
      ? ['/api/device/capabilities', '/api/recordings/1']
      : ['/api/device/capabilities'];
    assert.deepEqual(result.calls, expected);
  }
});

test('declared and available are both required for every paid operation', async () => {
  for (const field of ['declared', 'status']) {
    const partial = complete();
    partial.llm[0] = { ...partial.llm[0], [field]: field === 'declared' ? false : 'account-required' };
    await assert.rejects(runGate(recipes.batch, partial), /capabilities incomplete/);
  }
});
