// ABOUTME: 录音文件的落盘位置策略——默认 ~/memo/memotalk/raw/YYYY-MM。

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import { readSetting } from './sql';
import { containsPath, expandHomePath } from './paths';

export const DEFAULT_LIBRARY_DIR = path.join(os.homedir(), 'memo', 'memotalk', 'raw');

/** 允许用户在设置里写 `~/memo/...` 这样的家目录简写。 */
export function expandHome(input: string): string {
  return expandHomePath(input, os.homedir(), process.platform);
}

export function libraryRoot(db: DatabaseSync): string {
  const configured = expandHome(readSetting(db, 'library_dir'));
  return configured || DEFAULT_LIBRARY_DIR;
}

/** 录音按「录制月份」归档，便于在访达/资源管理器里按时间浏览。 */
export function monthFolder(iso: string | null | undefined): string {
  const parsed = iso ? new Date(iso) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export async function ensureMonthDir(root: string, iso: string | null | undefined): Promise<string> {
  const directory = path.join(root, monthFolder(iso));
  await mkdir(directory, { recursive: true });
  return directory;
}

/** 历史记录里可能存相对文件名，新版存绝对路径，两者都要能解析。 */
export function resolveStoredPath(storagePath: string | null, fallbackDir: string): string | null {
  if (!storagePath) return null;
  return path.isAbsolute(storagePath) ? storagePath : path.join(fallbackDir, path.basename(storagePath));
}

/** 解析某条录音的音频绝对路径；兼容历史相对文件名。 */
export async function resolveAudioFile(app: WorkbenchServer, storagePath: string): Promise<string> {
  if (path.isAbsolute(storagePath)) return storagePath;
  const audioDir = await app.resources.path('audio', undefined, 'read');
  return path.join(audioDir, path.basename(storagePath));
}

export function displayPath(absolute: string): string {
  const home = os.homedir();
  return containsPath(home, absolute, process.platform) ? `~${absolute.slice(home.length).replace(/\\/g, '/')}` : absolute;
}
