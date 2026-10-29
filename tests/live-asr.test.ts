import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { finishLiveAsr, pumpFrames, type AsrBridgeState } from '../src/server/live-asr.ts';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type Asr = AsrBridgeState['app']['host']['asr'];

function makeState(overrides: Partial<Asr> = {}): AsrBridgeState {
  return {
    app: { host: { asr: {
      start: async () => ({ streamId: 'stream-1' }),
      sendFrame: async ({ sequence }) => ({ nextSequence: sequence + 1 }),
      async *events() {},
      stop: async ({ streamId }) => ({
        streamId, status: 'completed', text: '', errorCode: null, nextSequence: 1,
      }),
      ...overrides,
    } } },
    streamId: null, seq: 0, queue: [Buffer.alloc(32000)],
    pumping: null, eventsDone: null, restarts: 0, pcmBytes: 0, message: null, partial: '', finals: [],
  };
}

test('a concurrent drain waits for the in-flight ASR frame', async () => {
  const entered = deferred();
  const release = deferred();
  const state = makeState({
    sendFrame: async ({ sequence }) => {
      entered.resolve();
      await release.promise;
      return { nextSequence: sequence + 1 };
    },
  });
  const first = pumpFrames(state);
  await entered.promise;
  let secondFinished = false;
  const second = pumpFrames(state).then(() => { secondFinished = true; });
  try {
    await setImmediate();
    assert.equal(secondFinished, false, 'stop must not overtake an in-flight sendFrame');
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(state.pcmBytes, 32000);
  assert.equal(state.queue.length, 0);
});

test('completed-session text is retained when no final event was delivered', async () => {
  const delivered = deferred();
  const state = makeState({
    sendFrame: async () => {
      delivered.resolve();
      return { nextSequence: 1 };
    },
    async *events() {
      await delivered.promise;
      yield {
        type: 'result', cursor: 1,
        session: { streamId: 'stream-1', status: 'completed', text: 'recognized speech', errorCode: null, nextSequence: 1 },
      };
    },
  });
  await pumpFrames(state);
  await setImmediate();
  assert.deepEqual(state.finals, ['recognized speech']);
});

test('stop waits for the in-flight tail frame and final subtitle event', async () => {
  const sending = deferred();
  const releaseFrame = deferred();
  const stopped = deferred();
  const state = makeState({
    sendFrame: async ({ sequence }) => {
      sending.resolve();
      await releaseFrame.promise;
      return { nextSequence: sequence + 1 };
    },
    stop: async ({ streamId }) => {
      assert.equal(state.queue.length, 0);
      stopped.resolve();
      return { streamId, status: 'completed', text: 'last sentence', errorCode: null, nextSequence: 1 };
    },
    async *events() {
      yield { type: 'event', cursor: 1, event: { type: 'final', text: 'first sentence' } };
      await stopped.promise;
      await setImmediate();
      yield { type: 'event', cursor: 2, event: { type: 'final', text: 'last sentence' } };
      yield { type: 'done', requestId: 'test' };
    },
  });
  state.queue = [Buffer.alloc(3000)];
  const first = pumpFrames(state);
  await sending.promise;
  const finishing = finishLiveAsr(state);
  releaseFrame.resolve();
  assert.equal(await finishing, 'first sentence\nlast sentence');
  await first;
  assert.equal(state.pcmBytes, 3000);
});

test('completed snapshots do not duplicate final subtitle events', async () => {
  const state = makeState({
    async *events() {
      yield { type: 'event', cursor: 1, event: { type: 'final', text: 'recognized speech' } };
      yield {
        type: 'result', cursor: 2,
        session: { streamId: 'stream-1', status: 'completed', text: 'recognized speech', errorCode: null, nextSequence: 1 },
      };
    },
  });
  await pumpFrames(state);
  await state.eventsDone;
  assert.deepEqual(state.finals, ['recognized speech']);
});
