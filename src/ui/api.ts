// ABOUTME: 页面侧 API 客户端，统一解包 { ok, data } 信封并抛出可读错误。

import { pageConnection } from './connection';

export class ApiError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const page = await pageConnection;
  const response = await page.fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new ApiError(`服务返回 ${response.status}`, 'HTTP_ERROR');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('服务返回了无法解析的内容', 'BAD_RESPONSE');
  }
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const envelope = payload as { ok: boolean; data?: unknown; error?: string; code?: string };
    if (!envelope.ok) throw new ApiError(envelope.error ?? '请求失败', envelope.code ?? 'UNKNOWN');
    return envelope.data as T;
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  remove: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '操作失败，请稍后重试';
}
