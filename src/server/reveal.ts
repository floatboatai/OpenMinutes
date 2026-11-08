// ABOUTME: 打开某条录音所在的文件夹：在 Floatboat 中打开，或用系统文件管理器选中该文件。

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { HostClient } from '../../sdk/host.mjs';
import type { OpenFolderWith, RevealResult } from '../contracts/app';
import { AppError } from '../contracts/errors';
import { displayPath } from './library';
import { readSetting, row, str } from './sql';

export const DEFAULT_OPEN_FOLDER_WITH: OpenFolderWith = 'floatboat';

const EXPLORER_HINT = '可以在设置中改为用 Windows 资源管理器打开。';
const SETTINGS_ACTION = { label: '去设置', href: '#/settings' };

export function openFolderWith(db: DatabaseSync): OpenFolderWith {
  return readSetting(db, 'open_folder_with', DEFAULT_OPEN_FOLDER_WITH) === 'explorer' ? 'explorer' : 'floatboat';
}

/** 系统文件管理器的启动命令；参数数组直接交给 spawn，不经过 shell。 */
export function explorerCommand(file: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: ['/select,', file] };
  if (platform === 'darwin') return { command: 'open', args: ['-R', file] };
  return { command: 'xdg-open', args: [path.dirname(file)] };
}

export interface RevealDeps {
  host: Pick<HostClient, 'workspaces'>;
  /** 解析存储路径为本机绝对路径（兼容历史相对文件名）。 */
  resolve: (storagePath: string) => Promise<string>;
  launch?: (command: string, args: string[]) => void;
  /** 测试开关：设置后只把调用追加到这个文件，不真的打开窗口或调用 Floatboat。 */
  fakeLog?: string;
}

function defaultLaunch(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => undefined);
  child.unref();
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === 'string' ? `${code}: ` : ''}${error.message}`.slice(0, 2000);
  }
  return String(error).slice(0, 2000);
}

/**
 * 工作台所属空间没有专门的查询接口：优先取状态为 active 的空间，否则取列表第一个。
 * 只读取列表，不创建空间。
 */
export async function pickWorkspaceId(host: Pick<HostClient, 'workspaces'>): Promise<string> {
  const { workspaces } = await host.workspaces.list({ limit: 100 });
  const chosen = workspaces.find((item) => item.status === 'active') ?? workspaces[0];
  if (!chosen) throw new Error('workspaces.list returned no workspace');
  return chosen.id;
}

export async function revealRecording(db: DatabaseSync, id: number, deps: RevealDeps): Promise<RevealResult> {
  const found = row(db, 'SELECT id, status, storage_path FROM recordings WHERE id = ?', [id]);
  if (!found) throw new AppError('NOT_FOUND', '录音不存在或已删除', undefined, undefined, false);
  const storagePath = str(found.storage_path);
  if (!storagePath) {
    const onDevice = str(found.status) === 'pending';
    throw new AppError(
      onDevice ? 'ON_DEVICE' : 'FILE_MOVED',
      onDevice ? '这条录音还在录音笔中，同步后才能在本机打开。' : '这条录音没有音频文件。',
      undefined,
      onDevice ? { label: '去录音笔同步', href: '#/device' } : undefined,
      false,
    );
  }

  const file = await deps.resolve(storagePath);
  try {
    if (!(await stat(file)).isFile()) throw new Error(`not a file: ${file}`);
  } catch (error) {
    throw new AppError('FILE_MOVED', '音频文件已被移走或删除，没法打开所在文件夹。', `${file}\n${rawMessage(error)}`, undefined, false);
  }

  const folder = path.dirname(file);
  const mode = openFolderWith(db);
  if (mode === 'explorer') {
    const { command, args } = explorerCommand(file);
    if (deps.fakeLog) appendFileSync(deps.fakeLog, `${JSON.stringify({ mode, command, args })}\n`);
    else {
      try {
        (deps.launch ?? defaultLaunch)(command, args);
      } catch (error) {
        throw new AppError('REVEAL_FAILED', '没能打开资源管理器。', rawMessage(error));
      }
    }
    return { mode, folder: displayPath(folder) };
  }

  const url = pathToFileURL(folder).href;
  if (deps.fakeLog) {
    appendFileSync(deps.fakeLog, `${JSON.stringify({ mode, url })}\n`);
    return { mode, folder: displayPath(folder) };
  }
  try {
    const workspaceId = await pickWorkspaceId(deps.host);
    await deps.host.workspaces.openUrl({ workspaceId, url, idempotencyKey: `reveal-${id}-${Date.now()}` });
  } catch (error) {
    throw new AppError('REVEAL_FAILED', `没能在 Floatboat 中打开文件夹。${EXPLORER_HINT}`, rawMessage(error), SETTINGS_ACTION);
  }
  return { mode, folder: displayPath(folder) };
}
