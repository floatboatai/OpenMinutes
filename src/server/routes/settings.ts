// ABOUTME: 设置读写路由；只允许白名单键，避免页面写入任意配置。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { SettingEntry } from '../../contracts/app';
import { asObject } from '../../contracts/input';
import { api } from '../http';
import { applyAsrConcurrency } from '../jobs';
import { readSettings, writeSetting } from '../sql';

const PATH_KEYS = new Set(['import_dir', 'python_path', 'ffmpeg_path', 'library_dir']);
const FLAG_KEYS = new Set(['auto_analyze', 'speaker_diarization', 'auto_transcribe', 'auto_connect', 'auto_pull', 'auto_pull_wifi']);
const ENUM_KEYS: Record<string, readonly string[]> = {
  device_transport: ['auto', 'wifi', 'ble'],
  open_folder_with: ['floatboat', 'explorer'],
};
// 序列号自动识别、device_user_disconnected 只由「断开连接」写入，都不对外开放。
const TEXT_KEYS: Record<string, number> = { asr_hotwords: 300, asr_language: 20 };
const NUMBER_KEYS: Record<string, [number, number]> = { auto_connect_minutes: [1, 120], asr_concurrency: [1, 8] };

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
  const allowed = ENUM_KEYS[key];
  if (allowed) {
    if (!allowed.includes(value)) throw Object.assign(new Error(`${key} 只能是 ${allowed.join(' / ')}`), { code: 'INVALID_INPUT' });
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
        // 旧页面可能仍提交此键；忽略它，不恢复已移除的设置。
        if (key === 'sdk_dir') continue;
        normalized.push([key, normalize(key, raw)]);
      }
      if (Object.keys(values).length === 0) throw Object.assign(new Error('没有需要保存的设置'), { code: 'EMPTY' });
      for (const [key, value] of normalized) writeSetting(context.database, key, value);
      // 并行转录上限只影响之后开始的转录，执行中的不打断。
      if (normalized.some(([key]) => key === 'asr_concurrency')) applyAsrConcurrency(context.database);
      return entries(app);
    }),
  );
}
