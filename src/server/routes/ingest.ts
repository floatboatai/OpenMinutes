// ABOUTME: 录音导入路由：导入目录状态、扫描导入（目录不存在时自动创建）与诊断区的手动登记清单。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { ImportDirectoryState, IngestScanResult } from '../../contracts/app';
import type { ParsedDeviceFile } from '../../contracts/device';
import { asObject, BadInput, optString, reqString } from '../../contracts/input';
import { api } from '../http';
import { readSetting, writeSetting } from '../sql';
import { resolveFfmpeg } from '../runtime-probe';
import { describeImportDir, registerDeviceManifest, resolveImportDir, scanImportDirectory } from '../ingest';
import { expandHome, libraryRoot } from '../library';
import { autoTranscribeIfEnabled } from '../jobs';

export function parseManifestEntries(value: unknown): ParsedDeviceFile[] {
  if (!Array.isArray(value)) throw new BadInput('entries 必须是数组');
  const items: ParsedDeviceFile[] = [];
  for (const entry of value.slice(0, 500)) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const size = Number(record.sizeBytes);
    const duration = Number(record.durationSec);
    const timestamp = Number(record.timestamp);
    items.push({
      name,
      format: typeof record.format === 'string' ? record.format : 'MP3',
      sizeBytes: Number.isFinite(size) ? size : null,
      durationSec: Number.isFinite(duration) ? duration : null,
      timestamp: Number.isFinite(timestamp) ? timestamp : null,
    });
  }
  return items;
}

export function registerIngestRoutes(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/ingest/directory',
    api((context): Promise<ImportDirectoryState> => describeImportDir(context.database)),
  );

  app.route(
    'POST',
    '/api/ingest/scan',
    api(async (context): Promise<IngestScanResult> => {
      const body = asObject(context.body ?? {});
      const requested = optString(body, 'directory', 500);
      const directory = requested ? expandHome(requested) : resolveImportDir(context.database).directory;
      if (requested && directory !== readSetting(context.database, 'import_dir')) {
        writeSetting(context.database, 'import_dir', directory);
      }
      const ffmpegPath = (await resolveFfmpeg(context.database)) ?? 'ffmpeg';
      const result = await scanImportDirectory(context.database, libraryRoot(context.database), ffmpegPath, directory);
      autoTranscribeIfEnabled(app, result.ids);
      return result;
    }),
  );

  // 只有「设置 › 诊断与高级 › 开发者工具」使用。
  app.route(
    'POST',
    '/api/ingest/manifest',
    api((context) => {
      const body = asObject(context.body);
      const serial = reqString(body, 'serial', 64);
      const entries = parseManifestEntries(body.entries);
      if (entries.length === 0) {
        throw Object.assign(new Error('没有可登记的文件条目'), { code: 'EMPTY_MANIFEST' });
      }
      const result = registerDeviceManifest(context.database, serial, entries);
      writeSetting(context.database, 'device_serial', serial);
      return result;
    }),
  );
}
