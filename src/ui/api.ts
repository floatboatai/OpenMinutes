// ABOUTME: 页面侧 API 客户端，统一解包 { ok, data } 信封；失败时保留中文结论、技术详情与跳转动作。

import { ERROR_COPY, type AppErrorView, type ErrorAction } from '../contracts/errors';
import { pageConnection } from './connection';

export class ApiError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly action?: ErrorAction;
  constructor(message: string, code: string, detail?: string, action?: ErrorAction) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
    this.action = action;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const page = await pageConnection;
  const response = await page.fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new ApiError(ERROR_COPY.HTTP_ERROR.message, 'HTTP_ERROR', `HTTP ${response.status} ${path}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ApiError(ERROR_COPY.BAD_RESPONSE.message, 'BAD_RESPONSE', `${path}: ${String(cause)}`);
  }
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const envelope = payload as { ok: boolean; data?: unknown; error?: string; code?: string; detail?: string; action?: ErrorAction };
    if (!envelope.ok) {
      const code = envelope.code ?? 'INTERNAL_ERROR';
      throw new ApiError(envelope.error ?? ERROR_COPY.INTERNAL_ERROR.message, code, envelope.detail, envelope.action ?? ERROR_COPY[code]?.action);
    }
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

/** 任意异常 → 可展示的错误视图：主文案中文，原文进 detail。 */
export function toErrorView(error: unknown): AppErrorView {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.action ? { action: error.action } : {}),
    };
  }
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return { code: 'INTERNAL_ERROR', message: ERROR_COPY.INTERNAL_ERROR.message, detail: raw.slice(0, 2000) };
}

/** 只用在需要拼接纯文本的地方；界面提示请用 ErrorNotice 或 toast.error。 */
export function errorText(error: unknown): string {
  return toErrorView(error).message;
}
