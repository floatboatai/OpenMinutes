// ABOUTME: 录音导入路由：目录扫描、设备清单登记与导入目录状态。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { ImportDirectoryState, IngestScanResult } from '../../contracts/app';
import { asObject, optString, reqString } from '../../contracts/input';
import { api } from '../http';
import { readSetting, writeSetting } from '../sql';
import { resolveFfmpeg } from '../bridge';
import { describeImportDir, ensureImportDir, registerDeviceManifest, resolveImportDir, scanImportDirectory } from '../ingest';
import { expandHome, libraryRoot } from '../library';
import { autoTranscribeIfEnabled } from '../jobs';
import { parseManifestEntries } from './device';


export function registerIngestRoutes(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/ingest/directory',
    api((context): Promise<ImportDirectoryState> => describeImportDir(context.database)),
  );

  // 目录不存在时建出来：用户点一次就能拿到一个真实可用的收件目录。
  app.route(
    'POST',
    '/api/ingest/directory/ensure',
    api(async (context): Promise<ImportDirectoryState> => {
      const body = asObject(context.body ?? {});
      const requested = optString(body, 'directory', 500);
      if (requested) writeSetting(context.database, 'import_dir', expandHome(requested));
      const state = await describeImportDir(context.database);
      const created = await ensureImportDir(state.directory);
      return { ...state, exists: true, created };
    }),
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
