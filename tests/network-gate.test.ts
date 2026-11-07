import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/contracts/errors.ts';
import { NetworkGate } from '../src/server/network-gate.ts';
import { enqueue, isNetworkTask, useNetworkGate } from '../src/server/queue.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('isNetworkTask only covers transcription and organisation', () => {
  assert.equal(isNetworkTask('transcribe:1'), true);
  assert.equal(isNetworkTask('organize:2'), true);
  assert.equal(isNetworkTask('scan:inbox'), false);
  assert.equal(isNetworkTask('device:sync'), false);
});

test('while offline, queued network tasks wait in order and other tasks keep running', async () => {
  const gate = new NetworkGate();
  useNetworkGate(gate);
  try {
    const release = await gate.acquireOffline('device-hotspot', { waitForInFlightMs: 1000 });
    assert.ok(release);
    assert.equal(gate.isOffline(), true);
    assert.equal(gate.reason(), 'device-hotspot');
    const order: string[] = [];
    const done = Promise.withResolvers<void>();
    enqueue('transcribe:1', async () => {
      order.push('transcribe:1');
    });
    enqueue('organize:1', async () => {
      order.push('organize:1');
    });
    enqueue('scan:inbox', async () => {
      order.push('scan:inbox');
      done.resolve();
    });
    await tick();
    // The serial queue holds behind the first network task; nothing has failed.
    assert.deepEqual(order, []);
    assert.throws(() => gate.assertOnline(), (error: unknown) => error instanceof AppError && error.code === 'NETWORK_PAUSED');
    release();
    release(); // idempotent
    await done.promise;
    assert.deepEqual(order, ['transcribe:1', 'organize:1', 'scan:inbox']);
    assert.equal(gate.isOffline(), false);
    gate.assertOnline();
  } finally {
    useNetworkGate(new NetworkGate());
  }
});

test('non-network work is not blocked by the gate', async () => {
  const gate = new NetworkGate();
  useNetworkGate(gate);
  try {
    const release = await gate.acquireOffline('device-hotspot', { waitForInFlightMs: 1000 });
    const done = Promise.withResolvers<string>();
    enqueue('scan:inbox', async () => done.resolve('ran'));
    assert.equal(await done.promise, 'ran');
    release?.();
  } finally {
    useNetworkGate(new NetworkGate());
  }
});

test('acquireOffline waits for in-flight network tasks before going offline', async () => {
  const gate = new NetworkGate();
  const running = Promise.withResolvers<void>();
  const task = gate.runNetworkTask(() => running.promise);
  assert.equal(gate.runningNetworkTasks(), 1);
  let acquired = false;
  const pending = gate.acquireOffline('device-hotspot', { waitForInFlightMs: 5000 }).then((release) => {
    acquired = true;
    return release;
  });
  await tick();
  assert.equal(acquired, false);
  // The gate is already closed: new tasks queue instead of starting.
  assert.equal(gate.isOffline(), true);
  let lateStarted = false;
  const late = gate.runNetworkTask(async () => {
    lateStarted = true;
  });
  await tick();
  assert.equal(lateStarted, false);
  running.resolve();
  await task;
  const release = await pending;
  assert.ok(release);
  assert.equal(acquired, true);
  assert.equal(lateStarted, false);
  release();
  await late;
  assert.equal(lateStarted, true);
});

test('acquireOffline times out, reopens the gate and returns null', async () => {
  const gate = new NetworkGate();
  const running = Promise.withResolvers<void>();
  const task = gate.runNetworkTask(() => running.promise);
  const release = await gate.acquireOffline('device-hotspot', { waitForInFlightMs: 30 });
  assert.equal(release, null);
  assert.equal(gate.isOffline(), false);
  gate.assertOnline();
  running.resolve();
  await task;
  // A second holder is refused while the first one is active.
  const first = await gate.acquireOffline('a', { waitForInFlightMs: 10 });
  assert.ok(first);
  assert.equal(await gate.acquireOffline('b', { waitForInFlightMs: 10 }), null);
  first();
  assert.equal(gate.isOffline(), false);
});
