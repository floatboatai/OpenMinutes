import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERROR_COPY } from '../src/contracts/errors.ts';
import { OrganizeError } from '../src/server/organize.ts';
import { describeError } from '../src/server/pipeline.ts';
import { TranscribeError } from '../src/server/transcribe.ts';

test('an ASR error behind an empty transcript shows Chinese copy and keeps the engine text in detail', () => {
  const failure = describeError(new TranscribeError('ASR_UNSTABLE', '识别接口返回错误：upstream 502 Bad Gateway'));
  assert.equal(failure.code, 'ASR_UNSTABLE');
  assert.equal(failure.message, ERROR_COPY.ASR_UNSTABLE.message);
  assert.doesNotMatch(failure.message, /502|Bad Gateway/);
  assert.match(failure.detail ?? '', /upstream 502 Bad Gateway/);

  const empty = describeError(new TranscribeError('ASR_EMPTY', '没有识别到可用的语音内容'));
  assert.equal(empty.code, 'ASR_EMPTY');
  assert.match(empty.message, /没有识别到可用的语音内容/);
});

test('an unmapped raw Host code never reaches the main line', () => {
  const hostError = Object.assign(new Error('stream closed by peer (code=1011)'), { code: 'STREAM_RESET', requestId: 'r-1' });
  const transcribe = describeError(hostError, 'transcribe');
  assert.equal(transcribe.code, 'ASR_START_FAILED');
  assert.equal(transcribe.message, ERROR_COPY.ASR_START_FAILED.message);
  assert.match(transcribe.detail ?? '', /STREAM_RESET: stream closed by peer/);
  assert.match(transcribe.detail ?? '', /requestId=r-1/);

  const organize = describeError(hostError, 'organize');
  assert.equal(organize.code, 'INTERNAL_ERROR');
  assert.equal(organize.message, ERROR_COPY.INTERNAL_ERROR.message);
});

test('business errors raised by the app keep their own Chinese message', () => {
  const missing = describeError(new OrganizeError('NO_TRANSCRIPT', '还没有转写文本，请先完成转录'), 'organize');
  assert.deepEqual([missing.code, missing.message], ['NO_TRANSCRIPT', '还没有转写文本，请先完成转录']);
  const timeout = describeError(new TranscribeError('TRANSCRIBE_TIMEOUT', '单次转录超过 60 分钟，已中止'));
  assert.deepEqual([timeout.code, timeout.message], ['TRANSCRIBE_TIMEOUT', '单次转录超过 60 分钟，已中止']);
  // 已有统一文案的 code 使用统一文案。
  const paused = describeError(Object.assign(new Error('network gate held by device-hotspot'), { code: 'NETWORK_PAUSED' }));
  assert.equal(paused.message, ERROR_COPY.NETWORK_PAUSED.message);
});
