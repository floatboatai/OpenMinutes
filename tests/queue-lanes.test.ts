import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ASR_CONCURRENCY,
  TRANSCRIBE_LANE,
  enqueue,
  isRunning,
  laneLimit,
  queueSnapshot,
  runningTasks,
  setLaneLimit,
  whenIdle,
} from '../src/server/queue.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('转录车道最多并行 N 条，归类车道串行，调大上限立即补位', async () => {
  setLaneLimit(TRANSCRIBE_LANE, 2);
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const active = { transcribe: 0, organize: 0 };
  const peak = { transcribe: 0, organize: 0 };
  const track = (kind: 'transcribe' | 'organize', label: string) => async () => {
    active[kind] += 1;
    peak[kind] = Math.max(peak[kind], active[kind]);
    const gate = Promise.withResolvers<void>();
    gates.set(label, gate);
    await gate.promise;
    active[kind] -= 1;
  };
  try {
    for (const id of [1, 2, 3, 4, 5]) enqueue(`transcribe:${id}`, track('transcribe', `transcribe:${id}`));
    for (const id of [1, 2, 3]) enqueue(`organize:${id}`, track('organize', `organize:${id}`));
    await tick();
    assert.deepEqual(runningTasks().sort(), ['organize:1', 'transcribe:1', 'transcribe:2']);
    assert.equal(isRunning('transcribe:3'), false);
    assert.equal(queueSnapshot().length, 8);

    // 完成一条转录，下一条按入队顺序补位；归类不受影响。
    gates.get('transcribe:1')?.resolve();
    await tick();
    assert.equal(isRunning('transcribe:3'), true);
    assert.equal(isRunning('organize:2'), false);

    setLaneLimit(TRANSCRIBE_LANE, 3);
    await tick();
    assert.equal(isRunning('transcribe:4'), true);
    assert.equal(active.transcribe, 3);

    for (const label of ['transcribe:2', 'transcribe:3', 'transcribe:4', 'organize:1']) gates.get(label)?.resolve();
    await tick();
    gates.get('transcribe:5')?.resolve();
    gates.get('organize:2')?.resolve();
    await tick();
    gates.get('organize:3')?.resolve();
    await whenIdle();
    assert.equal(peak.transcribe, 3);
    assert.equal(peak.organize, 1);
    assert.deepEqual(queueSnapshot(), []);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    setLaneLimit(TRANSCRIBE_LANE, DEFAULT_ASR_CONCURRENCY);
  }
});

test('上限按 1–8 收敛；延迟入队期间已算排队但不占名额', async () => {
  setLaneLimit(TRANSCRIBE_LANE, 0);
  assert.equal(laneLimit(TRANSCRIBE_LANE), 1);
  setLaneLimit(TRANSCRIBE_LANE, 99);
  assert.equal(laneLimit(TRANSCRIBE_LANE), 8);
  setLaneLimit(TRANSCRIBE_LANE, 1);
  try {
    let ran = false;
    const blocker = Promise.withResolvers<void>();
    enqueue('transcribe:10', async () => {
      ran = true;
    }, { delayMs: 60 });
    enqueue('transcribe:11', () => blocker.promise);
    await tick();
    assert.equal(isRunning('transcribe:11'), true);
    assert.equal(ran, false);
    assert.deepEqual(queueSnapshot(), ['transcribe:10', 'transcribe:11']);
    blocker.resolve();
    await whenIdle();
    assert.equal(ran, true);
  } finally {
    setLaneLimit(TRANSCRIBE_LANE, DEFAULT_ASR_CONCURRENCY);
  }
});
