// ABOUTME: 自动连接调度器：按间隔连上录音笔，按设置后台同步，用完即断；用户手动断开后暂停。

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, readSetting, writeSetting } from '../sql';
import type { DeviceService } from './service';

const TICK_MS = 30_000;

export interface AutoConnectDeps {
  db: DatabaseSync;
  service: Pick<DeviceService, 'view' | 'connect' | 'sync' | 'disconnect' | 'setNextAttempt'>;
  now?: () => number;
}

/** 单轮调度；返回是否真的尝试了连接（测试用）。 */
export async function autoConnectTick(deps: AutoConnectDeps, state: { nextAttemptAt: number; running: boolean }): Promise<boolean> {
  const now = deps.now ?? Date.now;
  if (state.running) return false;
  if (readSetting(deps.db, 'auto_connect', '1') !== '1') return false;
  if (readSetting(deps.db, 'device_user_disconnected', '0') === '1') return false;
  const view = deps.service.view();
  if (view.connection.state !== 'disconnected') return false;
  if (now() < state.nextAttemptAt) return false;

  const intervalMinutes = Number(readSetting(deps.db, 'auto_connect_minutes', '3')) || 3;
  state.nextAttemptAt = now() + intervalMinutes * 60_000;
  deps.service.setNextAttempt(state.nextAttemptAt);
  state.running = true;
  try {
    await deps.service.connect({ origin: 'auto' });
    writeSetting(deps.db, 'last_auto_connect_at', nowIso());
    // 连接期间用户点了连接/同步：会话已归用户，后台不再同步，也不断开。
    if (!backgroundOwned(deps)) return true;
    if (readSetting(deps.db, 'auto_pull', '1') === '1') {
      // 同步结束后服务会以 auto-done 自行断开。
      const outcome = await deps.service.sync({ origin: 'auto' });
      if (outcome.done > 0) writeSetting(deps.db, 'last_auto_pull_at', nowIso());
    } else {
      await deps.service.disconnect({ reason: 'auto-done' });
    }
  } catch {
    // 录音笔休眠或不在范围内是常态：保持静默，下一轮再试。
    if (deps.service.view().connection.state === 'connected' && backgroundOwned(deps)) {
      await deps.service.disconnect({ reason: 'auto-done' }).catch(() => undefined);
    }
  } finally {
    state.running = false;
  }
  return true;
}

function backgroundOwned(deps: AutoConnectDeps): boolean {
  return deps.service.view().connection.origin === 'auto';
}

export function startAutoConnect(deps: AutoConnectDeps): () => void {
  const state = { nextAttemptAt: 0, running: false };
  const timer = setInterval(() => {
    void autoConnectTick(deps, state);
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
