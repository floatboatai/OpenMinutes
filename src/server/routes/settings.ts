// ABOUTME: 设置读写路由；只允许白名单键，避免页面写入任意配置。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { SettingEntry } from '../../contracts/app';
import { asObject } from '../../contracts/input';
import { api } from '../http';
import { readSettings, writeSetting } from '../sql';

const PATH_KEYS = new Set(['import_dir', 'python_path', 'ffmpeg_path', 'sdk_dir', 'library_dir']);
const FLAG_KEYS = new Set(['auto_analyze', 'speaker_diarization', 'auto_transcribe', 'auto_connect', 'auto_pull']);
const TEXT_KEYS: Record<string, number> = { asr_hotwords: 300, device_serial: 64, asr_language: 20 };
const NUMBER_KEYS: Record<string, [number, number]> = { auto_connect_minutes: [1, 120] };

function normalize(key: string, raw: unknown): string {
  if (typeof raw !== 'string') throw Object.assign(new Error(`设置项 ${key} 必须是字符串`), { code: 'INVALID_INPUT' });
  const value = raw.trim();
  if (PATH_KEYS.has(key)) {
    if (value.length > 500) throw Object.assign(new Error(`${key} 路径过长`), { code: 'INVALID_INPUT' });
    return value;
  }
  if (FLAG_KEYS.has(key)) {
    if (value !== '0' && value !== '1') throw Object.assign(new Error(`${key} 只能是 0 或 1`), { code: 'INVALID_INPUT' });
    return value;
  }
  const range = NUMBER_KEYS[key];
  if (range) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < range[0] || parsed > range[1]) {
      throw Object.assign(new Error(`${key} 需为 ${range[0]}~${range[1]} 的整数`), { code: 'INVALID_INPUT' });
    }
    return String(parsed);
  }
  const max = TEXT_KEYS[key];
  if (max === undefined) throw Object.assign(new Error(`不支持修改设置项 ${key}`), { code: 'UNKNOWN_SETTING' });
  if (value.length > max) throw Object.assign(new Error(`${key} 超过 ${max} 字符`), { code: 'INVALID_INPUT' });
  return value;
}

function entries(app: WorkbenchServer): SettingEntry[] {
  return [...readSettings(app.database).entries()].map(([key, value]) => ({ key, value }));
}

export function registerSettingRoutes(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/settings',
    api((): SettingEntry[] => entries(app)),
  );

  app.route(
    'PATCH',
    '/api/settings',
    api((context): SettingEntry[] => {
      const body = asObject(context.body);
      const values = asObject(body.values);
      const normalized: Array<[string, string]> = [];
      for (const [key, raw] of Object.entries(values)) {
        normalized.push([key, normalize(key, raw)]);
      }
      if (normalized.length === 0) throw Object.assign(new Error('没有需要保存的设置'), { code: 'EMPTY' });
      for (const [key, value] of normalized) writeSetting(context.database, key, value);
      return entries(app);
    }),
  );
}
