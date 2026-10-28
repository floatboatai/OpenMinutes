// ABOUTME: 设备页路由：环境自检、SDK 指令库、设备清单拉取与单文件下载。

import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { DeviceState, ParsedDeviceFile, SdkCommand } from '../../contracts/app';
import { asObject, optString, reqString } from '../../contracts/input';
import { api } from '../http';
import { probeEnvironment, resolveFfmpeg, runSdkAction } from '../bridge';
import { registerDeviceManifest, upsertDevice } from '../ingest';
import { libraryRoot } from '../library';
import { downloadOne } from '../pull';
import { listCategories } from '../repo';
import { num, numOr, readSetting, readSettings, row, rows, run, str, strOr, writeSetting } from '../sql';


async function readCapabilities(host: { capabilities: { list: (input?: { domain?: string }) => Promise<{ capabilities: Array<{ operation: string; status: string; declared: boolean }> }> } }) {
  const domains = [
    { domain: 'asr', label: '语音识别' },
    { domain: 'llm', label: '文本模型' },
  ];
  const results: Array<{ domain: string; ok: boolean; detail: string }> = [];
  for (const item of domains) {
    try {
      const listed = await host.capabilities.list({ domain: item.domain });
      const declared = listed.capabilities.filter((entry) => entry.declared);
      const available = declared.filter((entry) => entry.status === 'available');
      results.push({
        domain: item.label,
        ok: available.length > 0,
        detail:
          declared.length === 0
            ? '清单未声明该能力'
            : `${available.length}/${declared.length} 个接口可用`,
      });
    } catch (error) {
      results.push({ domain: item.label, ok: false, detail: error instanceof Error ? error.message : '无法读取能力清单' });
    }
  }
  return results;
}

function readCommands(app: WorkbenchServer): SdkCommand[] {
  return rows(app.database, 'SELECT * FROM sdk_commands ORDER BY sort_order').map((item) => ({
    cmdCode: strOr(item.cmd_code, ''),
    name: strOr(item.name, ''),
    direction: strOr(item.direction, 'read') as SdkCommand['direction'],
    channel: strOr(item.channel, 'FFF1'),
    requestHex: strOr(item.request_hex, ''),
    responseRule: strOr(item.response_rule, ''),
    caution: numOr(item.caution, 0) === 1,
  }));
}


/** 最近一次真正连上并读到信息的设备（有固件或电量），用于回填登记序列号。 */
function latestDeviceSerial(app: WorkbenchServer): string {
  const found = row(
    app.database,
    `SELECT serial FROM devices
      WHERE firmware IS NOT NULL OR battery_pct IS NOT NULL
      ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1`,
  );
  return found ? strOr(found.serial, '') : '';
}

function readDevices(app: WorkbenchServer): DeviceState['devices'] {
  return rows(app.database, 'SELECT * FROM devices ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 20').map((item) => ({
    id: numOr(item.id, 0),
    serial: strOr(item.serial, ''),
    model: strOr(item.model, 'MemoTalk S1'),
    firmware: str(item.firmware),
    batteryPct: num(item.battery_pct),
    freeSpacePct: num(item.free_space_pct),
    lastSeenAt: str(item.last_seen_at),
  }));
}

export function registerDeviceRoutes(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/device',
    api(async (context): Promise<DeviceState> => {
      const settings = readSettings(context.database);
      return {
        env: await probeEnvironment(context.database),
        commands: readCommands(app),
        capabilities: await readCapabilities(context.host),
        devices: readDevices(app),
        settings: [...settings.entries()].map(([key, value]) => ({ key, value })),
      };
    }),
  );

  app.route(
    'POST',
    '/api/device/check',
    api((context) => probeEnvironment(context.database)),
  );


  app.route(
    'POST',
    '/api/device/status',
    api(async (context) => {
      const run = await runSdkAction(context.database, 'status', {}, 60000);
      const device = run.result.parsedStatus;
      if (device?.serial) {
        upsertDevice(context.database, device.serial, {
          firmware: device.firmware,
          storageFormat: device.storageFormat,
          batteryPct: device.batteryPct,
          freeSpacePct: device.freeSpacePct,
        });
        writeSetting(context.database, 'device_serial', device.serial);
      }
      return { result: run.result, device };
    }),
  );

  app.route(
    'POST',
    '/api/device/list',
    api(async (context) => {
      const body = asObject(context.body ?? {});
      const serialInput = optString(body, 'serial', 64) ?? '';
      const run = await runSdkAction(context.database, 'list');
      if (!run.result.ok || run.result.parsedFiles.length === 0) {
        return { result: run.result, registered: 0, skipped: 0 };
      }
      const serial =
        serialInput || run.serial || latestDeviceSerial(app) || readSetting(context.database, 'device_serial') || 'MemoTalk-S1';
      const registered = registerDeviceManifest(context.database, serial, run.result.parsedFiles);
      return { result: run.result, registered: registered.accepted, skipped: registered.skipped, serial };
    }),
  );

  app.route(
    'POST',
    '/api/device/download',
    api(async (context) => {
      const body = asObject(context.body);
      const file = reqString(body, 'file', 160);
      const serial = (optString(body, 'serial', 64) || readSetting(context.database, 'device_serial') || 'MemoTalk-S1').trim();
      const outcome = await downloadOne(app, file, serial);
      return { result: outcome.result, attached: outcome.attached, queued: outcome.queued };
    }),
  );


  app.route(
    'GET',
    '/api/device/capabilities',
    api(async (context) => {
      const pick = async (domain: string) => {
        try {
          const result = await context.host.capabilities.list({ domain });
          return result.capabilities
            .filter((item) => item.declared || item.status !== 'not-declared')
            .map((item) => ({ operation: item.operation, status: item.status, declared: item.declared }));
        } catch (error) {
          return [{ operation: 'error', status: error instanceof Error ? error.message : String(error), declared: false }];
        }
      };
      return { asr: await pick('asr'), llm: await pick('llm') };
    }),
  );


  app.route(
    'DELETE',
    '/api/device/:id',
    api((context) => {
      const id = Number(context.params.id);
      if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('非法的设备 ID'), { code: 'INVALID_INPUT' });
      const found = row(context.database, 'SELECT serial FROM devices WHERE id = ?', [id]);
      if (!found) throw Object.assign(new Error('设备记录不存在'), { code: 'NOT_FOUND' });
      const serial = strOr(found.serial, '');
      run(context.database, 'DELETE FROM devices WHERE id = ?', [id]);
      if (readSetting(context.database, 'device_serial') === serial) writeSetting(context.database, 'device_serial', '');
      return { removed: true, id };
    }),
  );

  app.route(
    'GET',
    '/api/device/summary',
    api((context) => {
      const totals = row(
        context.database,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN device_serial IS NULL THEN 1 ELSE 0 END) AS local
           FROM recordings`,
      );
      return {
        deviceRecordings: numOr(totals?.total, 0) - numOr(totals?.local, 0),
        localRecordings: numOr(totals?.local, 0),
        devices: readDevices(app).length,
        categories: listCategories(context.database).length,
      };
    }),
  );
}

export function parseManifestEntries(value: unknown): ParsedDeviceFile[] {
  if (!Array.isArray(value)) throw Object.assign(new Error('entries 必须是数组'), { code: 'INVALID_INPUT' });
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
