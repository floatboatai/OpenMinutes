// ABOUTME: 音频读取与导出路由，供详情页试听和交回本机播放器。

import { copyFile, mkdir, open, type FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import { asObject, optString, pathParam } from '../../contracts/input';
import { api } from '../http';
import { row, str } from '../sql';
import { expandHome, resolveAudioFile } from '../library';
import { resolveImportDir } from '../ingest';

function contentTypeFor(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.m4a') return 'audio/mp4';
  if (extension === '.ogg' || extension === '.opus') return 'audio/ogg';
  if (extension === '.flac') return 'audio/flac';
  return 'audio/mpeg';
}

interface ByteRange {
  start: number;
  end: number;
}

function audioNotFound(): Response {
  return new Response('录音文件不存在', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 解析单区间 `Range: bytes=start-end`。
 * - 返回 null 表示按整文件返回（没有区间、或区间语法无法辨识）。
 * - 返回 'unsatisfiable' 表示区间超出文件长度，调用方应回 416。
 * 多区间请求（逗号分隔）不拼装 multipart，直接按整文件返回，行为仍然合法。
 */
function parseRange(header: string, total: number): ByteRange | 'unsatisfiable' | null {
  const normalized = header.trim().replace(/\s+/g, '');
  if (!normalized.toLowerCase().startsWith('bytes=')) return null;
  const spec = normalized.slice('bytes='.length);
  if (spec.includes(',')) return null;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    // `bytes=-N`：最后 N 个字节。
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return 'unsatisfiable';
    return { start: Math.max(total - suffix, 0), end: total - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (start >= total) return 'unsatisfiable';
  if (!rawEnd) return { start, end: total - 1 };
  const requestedEnd = Number(rawEnd);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, total - 1) };
}

function rangeBody(file: FileHandle, range: ByteRange | null, total: number): BodyInit | null {
  if (total === 0) return null;
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const stream = file.createReadStream({ start, end, autoClose: true });
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

export function registerMediaRoutes(app: WorkbenchServer): void {
  app.route('GET', '/api/recordings/:id/audio', async (context) => {
    const id = pathParam(context.params, 'id');
    const found = row(context.database, 'SELECT filename, storage_path FROM recordings WHERE id = ?', [id]);
    const storagePath = found ? str(found.storage_path) : null;
    if (!found || !storagePath) return audioNotFound();

    let file: FileHandle;
    try {
      const absolute = await resolveAudioFile(app, storagePath);
      file = await open(absolute, 'r');
    } catch {
      return audioNotFound();
    }

    let total: number;
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        await file.close();
        return audioNotFound();
      }
      total = info.size;
    } catch {
      await file.close();
      return audioNotFound();
    }

    const headers: Record<string, string> = {
      'content-type': contentTypeFor(storagePath),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };

    const rawRange = typeof context.request.headers.range === 'string' ? context.request.headers.range : '';
    const range = rawRange ? parseRange(rawRange, total) : null;

    if (range === 'unsatisfiable') {
      await file.close();
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${total}`, 'content-length': '0' },
      });
    }

    if (!range) {
      return new Response(rangeBody(file, null, total), {
        status: 200,
        headers: { ...headers, 'content-length': String(total) },
      });
    }

    return new Response(rangeBody(file, range, total), {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
      },
    });
  });

  app.route(
    'POST',
    '/api/recordings/:id/export',
    api(async (context) => {
      const id = pathParam(context.params, 'id');
      const body = asObject(context.body ?? {});
      const requested = optString(body, 'directory', 500);
      const found = row(context.database, 'SELECT filename, storage_path FROM recordings WHERE id = ?', [id]);
      const storagePath = found ? str(found.storage_path) : null;
      if (!found || !storagePath) throw Object.assign(new Error('录音还没有音频文件'), { code: 'NO_AUDIO_FILE' });

      // 导出默认落到导入收件目录，用户接着就能在资源管理器里找到文件。
      const targetDir = requested ? expandHome(requested) : resolveImportDir(context.database).directory;
      await mkdir(targetDir, { recursive: true });
      const source = await resolveAudioFile(app, storagePath);
      const target = path.join(targetDir, str(found.filename) ?? path.basename(storagePath));
      if (!existsSync(source)) throw Object.assign(new Error('音频文件已丢失'), { code: 'FILE_MISSING' });
      await copyFile(source, target);
      return { path: target, directory: targetDir };
    }),
  );
}
