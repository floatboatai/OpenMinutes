// ABOUTME: 录音笔状态与动作的唯一 hook：设备写接口只从这里发出，录音笔页与实时字幕页共用。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceLastResult, DeviceView } from '../contracts/device';
import type { AppErrorView } from '../contracts/errors';
import { api, toErrorView } from './api';

export interface DeviceHook {
  view: DeviceView | null;
  /** 读取状态失败（应用服务没响应）；录音笔本身的失败在 view.lastError。 */
  error: AppErrorView | null;
  /** 正在提交的动作，用于按钮的禁用与「正在…」文案。 */
  pending: 'connect' | 'disconnect' | 'sync' | 'pull' | 'cancel' | 'cleanup' | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sync: () => Promise<void>;
  pull: (ids: number[]) => Promise<void>;
  cancel: () => Promise<void>;
  cleanup: () => Promise<void>;
  reload: () => void;
}

interface Options {
  /** 一次同步或清理结束时回调一次（按 jobId 去重）。 */
  onFinished?: (result: DeviceLastResult) => void;
  /** 动作提交失败（例如录音笔正忙）。 */
  onError?: (error: unknown) => void;
}

const FAST_MS = 1500;
const SLOW_MS = 8000;

export function useDevice(options: Options = {}): DeviceHook {
  const [view, setView] = useState<DeviceView | null>(null);
  const [error, setError] = useState<AppErrorView | null>(null);
  const [pending, setPending] = useState<DeviceHook['pending']>(null);
  const [nonce, setNonce] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const seenJob = useRef<string | null | undefined>(undefined);

  const accept = useCallback((next: DeviceView) => {
    setView(next);
    setError(null);
    const finished = next.lastResult;
    // 首次加载只记下已有结果，不重复提示上一次会话的同步。
    if (seenJob.current === undefined) {
      seenJob.current = finished?.jobId ?? null;
      return;
    }
    if (finished && finished.jobId !== seenJob.current && !next.activity) {
      seenJob.current = finished.jobId;
      optionsRef.current.onFinished?.(finished);
    }
  }, []);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const state = view?.connection.state;
  const fast = state === 'connecting' || state === 'busy' || Boolean(view?.activity) || pending !== null;

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const next = await api.get<DeviceView>('/api/device');
          if (!disposed) accept(next);
        } catch (cause) {
          if (!disposed) setError(toErrorView(cause));
        }
      }
      if (!disposed) timer = window.setTimeout(() => void tick(), fast ? FAST_MS : SLOW_MS);
    };
    void tick();
    const onVisible = () => {
      if (!document.hidden) reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [accept, fast, nonce, reload]);

  const perform = useCallback(
    async (kind: NonNullable<DeviceHook['pending']>, task: () => Promise<DeviceView | { jobId: string }>) => {
      setPending(kind);
      try {
        const result = await task();
        if ('connection' in result) accept(result);
        else reload();
      } catch (cause) {
        optionsRef.current.onError?.(cause);
        reload();
      } finally {
        setPending(null);
      }
    },
    [accept, reload],
  );

  return {
    view,
    error,
    pending,
    connect: () => perform('connect', () => api.post<DeviceView>('/api/device/connect')),
    disconnect: () => perform('disconnect', () => api.post<DeviceView>('/api/device/disconnect')),
    sync: () => perform('sync', () => api.post<{ jobId: string }>('/api/device/sync')),
    pull: (ids: number[]) => perform('pull', () => api.post<{ jobId: string }>('/api/device/pull', { ids })),
    cancel: () => perform('cancel', () => api.post<DeviceView>('/api/device/cancel')),
    cleanup: () => perform('cleanup', () => api.post<{ jobId: string }>('/api/device/cleanup')),
    reload,
  };
}
