// ABOUTME: 录音导入：扫描本地目录复制进数据区，或登记设备文件清单。

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportDirectoryState, IngestScanResult, ParsedDeviceFile } from '../contracts/app';
import { fileSize, probeDurationSec } from './media';
import { nowIso, num, row, run, str, strOr, touchRecording, writeSetting } from './sql';
import { ensureMonthDir, expandHome, resolveStoredPath } from './library';
import { canonicalPath, containsPath, portableFilename, sameDirectory } from './paths';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.amr', '.opus']);

export class IngestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

export function sanitizeFilename(name: string): string {
  return portableFilename(name);
}

/** 从文件名里识别常见录音时间戳；识别不到时用文件修改时间。 */
export function guessRecordedAt(filename: string, fallback: Date): string {
  const compact = /(20\d{2})(\d{2})(\d{2})[_\-\s]?(\d{2})(\d{2})(\d{2})/.exec(filename);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact;
    // 设备文件名记录的是本机挂钟时间，按本地时区解析，避免跨时区偏移。
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const dashed = /(20\d{2})[-_](\d{2})[-_](\d{2})/.exec(filename);
  if (dashed) {
    const [, year, month, day] = dashed;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), fallback.getHours(), fallback.getMinutes(), 0);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

async function uniqueStorageName(audioDir: string, filename: string): Promise<string> {
  const parsed = path.parse(sanitizeFilename(filename));
  const ext = parsed.ext || '.mp3';
  const stem = parsed.name || 'recording';
  for (let index = 0; index < 500; index += 1) {
    const candidate = index === 0 ? `${stem}${ext}` : `${stem}-${index}${ext}`;
    if (!existsSync(path.join(audioDir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export function upsertDevice(
  db: DatabaseSync,
  serial: string,
  patch: { firmware?: string | null; storageFormat?: string | null; batteryPct?: number | null; freeSpacePct?: number | null; note?: string | null },
): number {
  const existing = row(db, 'SELECT id FROM devices WHERE serial = ?', [serial]);
  const now = nowIso();
  if (existing) {
    const id = num(existing.id) ?? 0;
    run(
      db,
      `UPDATE devices SET last_seen_at = ?,
         firmware = COALESCE(?, firmware), storage_format = COALESCE(?, storage_format),
         battery_pct = COALESCE(?, battery_pct), free_space_pct = COALESCE(?, free_space_pct),
         note = COALESCE(?, note)
       WHERE id = ?`,
      [now, patch.firmware ?? null, patch.storageFormat ?? null, patch.batteryPct ?? null, patch.freeSpacePct ?? null, patch.note ?? null, id],
    );
    return id;
  }
  return run(
    db,
    `INSERT INTO devices (serial, model, firmware, storage_format, battery_pct, free_space_pct, last_seen_at, note, created_at)
     VALUES (?, 'MemoTalk S1', ?, ?, ?, ?, ?, ?, ?)`,
    [
      serial,
      patch.firmware ?? null,
      patch.storageFormat ?? null,
      patch.batteryPct ?? null,
      patch.freeSpacePct ?? null,
      now,
      patch.note ?? null,
      now,
    ],
  ).lastId;
}

export interface ImportOneInput {
  db: DatabaseSync;
  libraryDir: string;
  ffmpegPath: string;
  sourcePath: string;
  filename: string;
  recordedAt: Date;
  deviceSerial: string | null;
  source: 'folder_import' | 'device_pull';
}

export type ImportOutcome = { outcome: 'imported'; id: number } | { outcome: 'skipped'; reason: string } | { outcome: 'failed'; reason: string };

/** 复制单个音频文件并登记；重复文件按 dedupe_key 跳过而不是覆盖。 */
export async function importAudioFile(input: ImportOneInput): Promise<ImportOutcome> {
  const { db, libraryDir, ffmpegPath, sourcePath, recordedAt, deviceSerial } = input;
  const filename = sanitizeFilename(input.filename);
  const size = await fileSize(sourcePath);
  const key = `${deviceSerial ?? 'local'}::${filename}::${size ?? 0}::${recordedAt.toISOString()}`;

  const duplicate = row(db, 'SELECT id FROM recordings WHERE dedupe_key = ?', [key]);
  if (duplicate) return { outcome: 'skipped', reason: '同名同大小的录音已存在' };

  try {
    const monthDir = await ensureMonthDir(libraryDir, recordedAt.toISOString());
    const storedName = await uniqueStorageName(monthDir, filename);
    const target = path.join(monthDir, storedName);
    await copyFile(sourcePath, target);
    const durationSec = await probeDurationSec(ffmpegPath, target);
    const id = run(
      db,
      `INSERT INTO recordings (filename, dedupe_key, device_serial, source, storage_path, size_bytes,
         duration_sec, recorded_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      [filename, key, deviceSerial, input.source, target, size, durationSec, recordedAt.toISOString(), nowIso(), nowIso()],
    ).lastId;
    return { outcome: 'imported', id };
  } catch (error) {
    return { outcome: 'failed', reason: error instanceof Error ? error.message : '写入失败' };
  }
}

/** 扫描目录，把其中尚未登记的音频导入并登记。 */
export async function scanImportDirectory(
  db: DatabaseSync,
  libraryDir: string,
  ffmpegPath: string,
  directory: string,
): Promise<IngestScanResult> {
  if (!directory) throw new IngestError('NO_DIRECTORY', '还没有设置导入目录');
  // 导入目录就是给用户丢文件用的，不存在时直接建出来，不把「目录不存在」当成错误。
  const created = await ensureImportDir(directory);

  const entries = await readdir(directory, { withFileTypes: true });
  const result: IngestScanResult = { imported: 0, skipped: 0, failed: 0, files: [], ids: [], directory, created };

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) continue;
    const sourcePath = path.join(directory, entry.name);
    let mtime = new Date();
    try {
      mtime = (await stat(sourcePath)).mtime;
    } catch {
      /* 读不到修改时间时用当前时间兜底 */
    }
    const outcome = await importAudioFile({
      db,
      libraryDir,
      ffmpegPath,
      sourcePath,
      filename: entry.name,
      recordedAt: new Date(guessRecordedAt(entry.name, mtime)),
      deviceSerial: null,
      source: 'folder_import',
    });
    if (outcome.outcome === 'imported') {
      result.imported += 1;
      result.ids.push(outcome.id);
      result.files.push({ filename: entry.name, outcome: 'imported' });
    } else if (outcome.outcome === 'skipped') {
      result.skipped += 1;
      result.files.push({ filename: entry.name, outcome: 'skipped', reason: outcome.reason });
    } else {
      result.failed += 1;
      result.files.push({ filename: entry.name, outcome: 'failed', reason: outcome.reason });
    }
  }
  return result;
}

/** 登记设备 0x13 文件列表条目；此时还没有音频文件，状态为待导入。 */
export function registerDeviceManifest(
  db: DatabaseSync,
  serial: string,
  entries: ParsedDeviceFile[],
): { accepted: number; skipped: number; ids: number[] } {
  const ids: number[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const filename = sanitizeFilename(entry.name);
    if (!filename) {
      skipped += 1;
      continue;
    }
    const key = `device::${serial}::${filename}::${entry.sizeBytes ?? 0}`;
    const duplicate = row(db, 'SELECT id FROM recordings WHERE dedupe_key = ?', [key]);
    if (duplicate) {
      skipped += 1;
      continue;
    }
    // 设备上报的时间戳按 UTC 解释会与文件名里的本机挂钟时间错位，优先用文件名解析。
    const fallbackDate = entry.timestamp ? new Date(entry.timestamp * 1000) : new Date();
    const recordedAtIso = guessRecordedAt(filename, Number.isNaN(fallbackDate.getTime()) ? new Date() : fallbackDate);
    const id = run(
      db,
      `INSERT INTO recordings (filename, dedupe_key, device_serial, source, size_bytes, duration_sec,
         recorded_at, status, created_at, updated_at)
       VALUES (?, ?, ?, 'device_manifest', ?, ?, ?, 'pending', ?, ?)`,
      [
        filename,
        key,
        serial,
        entry.sizeBytes,
        entry.durationSec,
        recordedAtIso,
        nowIso(),
        nowIso(),
      ],
    ).lastId;
    ids.push(id);
  }
  if (ids.length > 0) upsertDevice(db, serial, {});
  return { accepted: ids.length, skipped, ids };
}

/** 设备拉取完成后把文件挂到已有的待导入记录上，避免产生重复条目。 */
export async function attachDownloadedFile(
  db: DatabaseSync,
  libraryDir: string,
  ffmpegPath: string,
  sourcePath: string,
  filename: string,
  serial: string,
): Promise<{ ok: boolean; id: number | null; message: string }> {
  const safe = sanitizeFilename(filename);
  const existing = row(
    db,
    "SELECT id, storage_path FROM recordings WHERE device_serial = ? AND filename = ? AND source IN ('device_manifest','device_pull') ORDER BY id DESC LIMIT 1",
    [serial, safe],
  );
  if (existing && strOr(existing.storage_path, '')) {
    return { ok: true, id: num(existing.id), message: '文件已存在于库中' };
  }
  if (!existsSync(sourcePath)) return { ok: false, id: null, message: '下载文件不存在' };

  const recordedAtIso = guessRecordedAt(safe, new Date());
  const monthDir = await ensureMonthDir(libraryDir, recordedAtIso);
  const storedName = await uniqueStorageName(monthDir, safe);
  const absolute = path.join(monthDir, storedName);
  await copyFile(sourcePath, absolute);
  const durationSec = await probeDurationSec(ffmpegPath, absolute);
  const size = await fileSize(absolute);

  if (existing) {
    const id = num(existing.id) ?? 0;
    touchRecording(db, id, { storage_path: absolute, size_bytes: size, status: 'ready', duration_sec: durationSec });
    return { ok: true, id, message: '已补齐音频文件' };
  }
  const id = run(
    db,
    `INSERT INTO recordings (filename, dedupe_key, device_serial, source, storage_path, size_bytes,
       duration_sec, recorded_at, status, created_at, updated_at)
     VALUES (?, ?, ?, 'device_pull', ?, ?, ?, ?, 'ready', ?, ?)`,
    [
      safe,
      `device::${serial}::${safe}::${size ?? 0}`,
      serial,
      absolute,
      size,
      durationSec,
      recordedAtIso,
      nowIso(),
      nowIso(),
    ],
  ).lastId;
  return { ok: true, id, message: '已导入' };
}

export const DEFAULT_IMPORT_DIR = path.join(os.homedir(), 'memo', 'memotalk', 'inbox');

/** 系统临时目录随时会被清理，不能当作长期导入目录。 */
function isTemporaryPath(directory: string): boolean {
  return containsPath(canonicalPath(os.tmpdir()), canonicalPath(directory), process.platform);
}

export interface ResolvedImportDir {
  directory: string;
  isDefault: boolean;
  resetFrom: string | null;
}

/** 设置值优先；为空或落在系统临时目录时回落到默认收件目录。 */
export function resolveImportDir(db: DatabaseSync): ResolvedImportDir {
  const configured = expandHome(readImportDir(db));
  if (configured && !isTemporaryPath(configured)) {
    return { directory: configured, isDefault: sameDirectory(configured, DEFAULT_IMPORT_DIR), resetFrom: null };
  }
  // 失效的临时目录写回默认值，这样提示只在修复的那一次出现。
  if (configured) writeSetting(db, 'import_dir', DEFAULT_IMPORT_DIR);
  return { directory: DEFAULT_IMPORT_DIR, isDefault: true, resetFrom: configured || null };
}

/** 目录不存在就建出来；返回是否新建。 */
export async function ensureImportDir(directory: string): Promise<boolean> {
  if (existsSync(directory)) return false;
  try {
    await mkdir(directory, { recursive: true });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    throw new IngestError('DIR_NOT_CREATABLE', `无法创建导入目录：${directory}（${detail}）`);
  }
}

/** 给页面用的导入目录状态：实际路径、是否存在、可导入文件数与样例。 */
export async function describeImportDir(db: DatabaseSync): Promise<ImportDirectoryState> {
  const resolved = resolveImportDir(db);
  const exists = existsSync(resolved.directory);
  let audioFiles = 0;
  const sample: string[] = [];
  if (exists) {
    try {
      const entries = await readdir(resolved.directory, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      audioFiles = names.length;
      sample.push(...names.slice(0, 3));
    } catch {
      // 目录存在但读不了（权限/占用），按 0 个文件处理，扫描时再报具体错误
    }
  }
  return {
    directory: resolved.directory,
    exists,
    audioFiles,
    isDefault: resolved.isDefault,
    resetFrom: resolved.resetFrom,
    sample,
  };
}

export function readImportDir(db: DatabaseSync): string {
  const found = row(db, "SELECT value FROM settings WHERE key = 'import_dir'");
  return found ? str(found.value)?.trim() ?? '' : '';
}

export function resolveAudioPath(fallbackDir: string, storagePath: string | null): string | null {
  const resolved = resolveStoredPath(storagePath, fallbackDir);
  return resolved && existsSync(resolved) ? resolved : null;
}
