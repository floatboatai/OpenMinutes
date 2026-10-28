// ABOUTME: 统一 API 响应信封与错误映射，页面只需判断 ok 字段。

import type { RouteContext } from '../../sdk/runtime.mjs';
import { BadInput } from '../contracts/input';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export interface ApiFailure {
  ok: false;
  error: string;
  code: string;
}

function errorCode(error: unknown): string {
  if (error instanceof BadInput) return 'INVALID_INPUT';
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code) return record.code;
  }
  return 'INTERNAL_ERROR';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '操作失败，请稍后重试';
}

export type Handler<T> = (context: RouteContext) => T | Promise<T>;

/** 把处理函数包成信封，业务代码只需抛错即可得到可读提示。 */
export function api<T>(handler: Handler<T>): (context: RouteContext) => Promise<ApiResult<T>> {
  return async (context) => {
    try {
      return { ok: true, data: await handler(context) };
    } catch (error) {
      return { ok: false, error: errorMessage(error), code: errorCode(error) };
    }
  };
}
