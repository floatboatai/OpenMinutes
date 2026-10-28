// ABOUTME: 自动重连：按间隔静默探测录音笔，读到状态就更新设备与首页。

import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import { isSdkBusy, runSdkAction } from './bridge';
import { upsertDevice } from './ingest';
import { pullPending } from './pull';
import { nowIso, readSetting, row, str, writeSetting } from './sql';

let timer: NodeJS.Timeout | null = null;
let nextAttemptAt = 0;
let running = false;

const TICK_MS = 30_000;

export function startAutoConnect(app: WorkbenchServer): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick(app);
  }, TICK_MS);
  timer.unref?.();
}

export function stopAutoConnect(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(app: WorkbenchServer): Promise<void> {
  if (running || isSdkBusy()) return;
  if (readSetting(app.database, 'auto_connect', '1') !== '1') return;

  const intervalMinutes = Number(readSetting(app.database, 'auto_connect_minutes', '3')) || 3;
  if (Date.now() < nextAttemptAt) return;
  nextAttemptAt = Date.now() + intervalMinutes * 60_000;

  // 已经有新鲜状态时不做无谓的无线电连接。
  const newest = row(
    app.database,
    'SELECT last_seen_at FROM devices ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1',
  );
  const lastSeenAt = newest ? str(newest.last_seen_at) : null;
  const fresh =
    lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < (intervalMinutes - 1) * 60_000;
  if (fresh) return;

  running = true;
  try {
    const outcome = await runSdkAction(app.database, 'status', {}, 45_000);
    const device = outcome.result.parsedStatus;
    if (!device?.serial) return; // 设备休眠/不在范围内：保持静默，下一轮再试
    upsertDevice(app.database, device.serial, {
      firmware: device.firmware,
      storageFormat: device.storageFormat,
      batteryPct: device.batteryPct,
      freeSpacePct: device.freeSpacePct,
    });
    writeSetting(app.database, 'device_serial', device.serial);
    writeSetting(app.database, 'last_auto_connect_at', nowIso());

    if (readSetting(app.database, 'auto_pull', '1') === '1') {
      const pulled = await pullPending(app, { maxFiles: 3, budgetMs: 150_000 });
      if (pulled.pulled > 0 || pulled.registered > 0) {
        writeSetting(app.database, 'last_auto_pull_at', nowIso());
      }
    }
  } catch {
    // 自动探测不写入错误状态，避免把偶发失败显示成故障
  } finally {
    running = false;
  }
}
