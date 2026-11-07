// ABOUTME: 运行时探测：Python / bleak / 设备 SDK（memotalk-sdk）/ ffmpeg。设备操作统一走 device/service.ts。

import type { DatabaseSync } from 'node:sqlite';
import type { DeviceEnv, EnvProbe } from '../contracts/app';
import { findFfmpeg, probeBleak, probePython, probeSdk } from './tools';
import { nowIso, readSetting } from './sql';

export { pythonCandidates, ffmpegCandidates, userSiteDir, pythonRuntimeEnv, probePython, probeBleak, probeSdk } from './tools';

export async function resolveFfmpeg(db: DatabaseSync): Promise<string | null> {
  return findFfmpeg(readSetting(db, 'ffmpeg_path'));
}

export async function probeEnvironment(db: DatabaseSync): Promise<DeviceEnv> {
  const { probe: python, command } = await probePython(readSetting(db, 'python_path'));
  const bleak = await probeBleak(command);
  const sdk = await probeSdk(command);
  const ffmpegPath = await resolveFfmpeg(db);
  const ffmpeg: EnvProbe = ffmpegPath
    ? { ok: true, detail: ffmpegPath, resolvedPath: ffmpegPath }
    : { ok: false, detail: '未找到 ffmpeg，可在设置中填写绝对路径', resolvedPath: null };
  return { python, ffmpeg, bleak, sdk, checkedAt: nowIso() };
}
