// ABOUTME: 页面数据加载与轮询的小型 hook，避免每个页面重复处理 loading/error。

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** key 变化时重新加载；loader 通过 ref 保持最新，不重置定时器。 */
export function useAsyncData<T>(loader: () => Promise<T>, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void loaderRef
      .current()
      .then((value) => {
        if (disposed) return;
        setData(value);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(errorText(cause));
        setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

/** 在 shouldPoll 为 true 时按固定间隔触发回调，用于任务进度刷新。 */
export function usePolling(callback: () => void, intervalMs: number, enabled: boolean): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => callbackRef.current(), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
