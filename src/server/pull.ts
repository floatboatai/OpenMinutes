// ABOUTME: 设备拉取服务：单文件下载与「连上后自动补齐待拉取录音」。

import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import type { BridgeRunResult } from '../contracts/app';
import { resolveFfmpeg, runSdkAction } from './bridge';
import { attachDownloadedFile, registerDeviceManifest } from './ingest';
import { autoTranscribeIfEnabled } from './jobs';
import { libraryRoot } from './library';
import { readSetting, row, rows, strOr } from './sql';

export interface AttachedFile {
  filename: string;
  ok: boolean;
  message: string;
  id: number | null;
}

export interface DownloadOutcome {
  result: BridgeRunResult;
  attached: AttachedFile[];
  queued: number;
}

function currentSerial(app: WorkbenchServer): string {
  const found = row(
    app.database,
    `SELECT serial FROM devices WHERE firmware IS NOT NULL OR battery_pct IS NOT NULL
      ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1`,
  );
  const serial = found ? strOr(found.serial, '') : '';
  return serial || readSetting(app.database, 'device_serial') || 'MemoTalk-S1';
}

/** 通过 BLE(0x84) 拉取单个文件并挂到已登记的记录上。 */
export async function downloadOne(app: WorkbenchServer, file: string, serial: string): Promise<DownloadOutcome> {
  const incoming = await app.resources.path('audio', '_incoming', 'write');
  await mkdir(incoming, { recursive: true });

  const run = await runSdkAction(app.database, 'download', { file, outDir: incoming }, 240000);
  const attached: AttachedFile[] = [];

  if (run.result.ok) {
    const ffmpegPath = (await resolveFfmpeg(app.database)) ?? 'ffmpeg';
    const target = libraryRoot(app.database);
    try {
      for (const entry of await readdir(incoming, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const absolute = path.join(incoming, entry.name);
        const info = await stat(absolute);
        if (Date.now() - info.mtimeMs > 15 * 60 * 1000) continue;
        const outcome = await attachDownloadedFile(app.database, target, ffmpegPath, absolute, entry.name, serial);
        attached.push({ filename: entry.name, ok: outcome.ok, message: outcome.message, id: outcome.id });
      }
    } catch {
      /* 目录不可读时保留 SDK 原始输出供人工判断 */
    }
  }

  const ids = attached.flatMap((item) => (item.ok && item.id ? [item.id] : []));
  return { result: run.result, attached, queued: autoTranscribeIfEnabled(app, ids) };
}

export interface PullPendingResult {
  serial: string;
  registered: number;
  pulled: number;
  failed: number;
  queued: number;
  files: AttachedFile[];
}

/**
 * 设备刚连上时调用：先读清单登记新录音，再按预算逐个拉取待拉取文件。
 * BLE 串行且慢，因此限制单轮文件数与总耗时。
 */
export async function pullPending(
  app: WorkbenchServer,
  options: { maxFiles?: number; budgetMs?: number } = {},
): Promise<PullPendingResult> {
  const db = app.database;
  const serial = currentSerial(app);
  const maxFiles = options.maxFiles ?? 3;
  const budgetMs = options.budgetMs ?? 150_000;

  let registered = 0;
  const listing = await runSdkAction(db, 'list', {}, 60_000);
  if (listing.result.ok && listing.result.parsedFiles.length > 0) {
    registered = registerDeviceManifest(db, serial, listing.result.parsedFiles).accepted;
  }

  const pending = rows(
    db,
    `SELECT filename FROM recordings
      WHERE status = 'pending' AND (storage_path IS NULL OR storage_path = '')
      ORDER BY COALESCE(recorded_at, created_at) DESC LIMIT ?`,
    [maxFiles],
  ).map((item) => strOr(item.filename, ''));

  const started = Date.now();
  const files: AttachedFile[] = [];
  let pulled = 0;
  let failed = 0;
  let queued = 0;

  for (const filename of pending) {
    if (!filename) continue;
    if (Date.now() - started > budgetMs) break;
    try {
      const outcome = await downloadOne(app, filename, serial);
      queued += outcome.queued;
      files.push(...outcome.attached);
      if (outcome.attached.some((item) => item.ok)) pulled += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  return { serial, registered, pulled, failed, queued, files };
}
