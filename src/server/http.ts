// ABOUTME: 统一 API 响应信封与错误映射，页面只需判断 ok 字段；技术原文只进 detail。

import type { RouteContext } from '../../sdk/runtime.mjs';
import { BadInput } from '../contracts/input';
import { AppError, ERROR_COPY, type ErrorAction } from '../contracts/errors';

export interface ApiFailure {
  ok: false;
  error: string;
  code: string;
  detail?: string;
  action?: ErrorAction;
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

const ERRNO_CODES: Record<string, string> = {
  EACCES: 'NO_PERMISSION',
  EPERM: 'NO_PERMISSION',
  ENOSPC: 'DISK_FULL',
  ENOENT: 'FILE_MOVED',
};

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  if (error === null || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return typeof record.errno === 'number' || typeof record.syscall === 'string';
}

function failure(code: string, message: string, detail?: string, action?: ErrorAction): ApiFailure {
  return {
    ok: false,
    error: message,
    code,
    ...(detail ? { detail } : {}),
    ...(action ? { action } : {}),
  };
}

/** 把任意异常映射为失败信封：系统错误换成中文结论，原文进 detail。 */
export function toFailure(error: unknown): ApiFailure {
  if (error instanceof AppError) return failure(error.code, error.message, error.detail, error.action);
  if (error instanceof BadInput) return failure('INVALID_INPUT', error.message);
  if (isSystemError(error)) {
    const code = ERRNO_CODES[String(error.code ?? '')] ?? 'INTERNAL_ERROR';
    const copy = ERROR_COPY[code] ?? ERROR_COPY.INTERNAL_ERROR;
    return failure(code, copy.message, String(error.message ?? error).slice(0, 2000), copy.action);
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return failure(code, error.message || ERROR_COPY.INTERNAL_ERROR.message);
    return failure('INTERNAL_ERROR', ERROR_COPY.INTERNAL_ERROR.message, String(error.stack ?? error.message).slice(0, 2000));
  }
  return failure('INTERNAL_ERROR', ERROR_COPY.INTERNAL_ERROR.message, String(error).slice(0, 2000));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return ERROR_COPY.INTERNAL_ERROR.message;
}

export type Handler<T> = (context: RouteContext) => T | Promise<T>;

/** 把处理函数包成信封，业务代码只需抛错即可得到可读提示。 */
export function api<T>(handler: Handler<T>): (context: RouteContext) => Promise<ApiResult<T>> {
  return async (context) => {
    try {
      return { ok: true, data: await handler(context) };
    } catch (error) {
      return toFailure(error);
    }
  };
}
