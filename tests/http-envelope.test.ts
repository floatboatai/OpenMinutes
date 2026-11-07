import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/contracts/errors.ts';
import { BadInput } from '../src/contracts/input.ts';
import { api, toFailure } from '../src/server/http.ts';

function systemError(code: string, syscall: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, syscall, errno: -2 });
}

test('AppError passes through with detail and action', () => {
  const failure = toFailure(new AppError('RUNTIME_MISSING', undefined, 'uv pip install memotalk-sdk'));
  assert.deepEqual(failure, {
    ok: false,
    error: '录音笔组件还没准备好。',
    code: 'RUNTIME_MISSING',
    detail: 'uv pip install memotalk-sdk',
    action: { label: '去诊断与修复', href: '#/settings/diagnostics' },
  });
  assert.deepEqual(toFailure(new AppError('NOT_FOUND', '录音不存在')), { ok: false, error: '录音不存在', code: 'NOT_FOUND' });
});

test('BadInput becomes INVALID_INPUT and keeps its message', () => {
  assert.deepEqual(toFailure(new BadInput('ids 至少包含 1 条录音')), { ok: false, error: 'ids 至少包含 1 条录音', code: 'INVALID_INPUT' });
});

test('Node system errors become Chinese headlines; the raw path only appears in detail', () => {
  const missing = toFailure(systemError('ENOENT', 'open', "ENOENT: no such file or directory, open 'C:\\Users\\x\\a.mp3'"));
  assert.equal(missing.code, 'FILE_MOVED');
  assert.equal(missing.error, '文件已被移走或删除。');
  assert.doesNotMatch(missing.error, /ENOENT|C:\\/);
  assert.match(missing.detail ?? '', /ENOENT: no such file/);

  const denied = toFailure(systemError('EPERM', 'mkdir', 'EPERM: operation not permitted, mkdir'));
  assert.equal(denied.code, 'NO_PERMISSION');
  assert.match(denied.error, /读写权限/);
  assert.deepEqual(denied.action, { label: '去设置', href: '#/settings' });
  assert.equal(toFailure(systemError('EACCES', 'open', 'EACCES')).code, 'NO_PERMISSION');

  const full = toFailure(systemError('ENOSPC', 'write', 'ENOSPC: no space left on device'));
  assert.equal(full.code, 'DISK_FULL');
  assert.equal(full.error, '磁盘空间不足。');
  assert.match(full.detail ?? '', /ENOSPC/);

  const other = toFailure(systemError('ECONNRESET', 'read', 'read ECONNRESET'));
  assert.equal(other.code, 'INTERNAL_ERROR');
  assert.equal(other.error, '操作没有完成，请重试。');
  assert.match(other.detail ?? '', /ECONNRESET/);
});

test('business errors with a string code keep their message without detail', () => {
  const failure = toFailure(Object.assign(new Error('任务已在队列中'), { code: 'BUSY' }));
  assert.deepEqual(failure, { ok: false, error: '任务已在队列中', code: 'BUSY' });
});

test('unknown exceptions show a generic headline and keep the stack in detail', () => {
  const failure = toFailure(new TypeError("Cannot read properties of undefined (reading 'x')"));
  assert.equal(failure.code, 'INTERNAL_ERROR');
  assert.equal(failure.error, '操作没有完成，请重试。');
  assert.match(failure.detail ?? '', /TypeError: Cannot read properties/);
  assert.ok((failure.detail ?? '').length <= 2000);
  const thrown = toFailure('plain string');
  assert.equal(thrown.error, '操作没有完成，请重试。');
  assert.equal(thrown.detail, 'plain string');
});

test('api() wraps results and failures in the shared envelope', async () => {
  const context = {} as Parameters<ReturnType<typeof api>>[0];
  assert.deepEqual(await api(() => 42)(context), { ok: true, data: 42 });
  assert.deepEqual(await api(async () => {
    throw new AppError('DEVICE_BUSY');
  })(context), { ok: false, error: '录音笔正在同步或用于实时字幕，请等它结束后再试。', code: 'DEVICE_BUSY' });
});
