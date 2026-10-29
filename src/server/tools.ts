// Platform-dependent tool discovery is kept here; candidates are verified before use.
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCommand } from './media';
import type { EnvProbe } from '../contracts/app';

export interface ToolContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  home: string;
  cwd: string;
}

export function toolContext(): ToolContext {
  return { platform: process.platform, env: process.env, execPath: process.execPath, home: os.homedir(),
    cwd: fileURLToPath(new URL('../../', import.meta.url)) };
}

export function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function resourceRoots(context: ToolContext): string[] {
  const p = pathApi(context.platform);
  const executable = p.dirname(context.execPath);
  const roots = [p.resolve(executable, '..'), p.join(executable, 'resources')];
  let ancestor = executable;
  while (p.dirname(ancestor) !== ancestor) {
    if (p.basename(ancestor) === 'Contents') roots.unshift(p.join(ancestor, 'Resources'));
    if (p.basename(ancestor).toLowerCase() === 'resources') roots.unshift(ancestor);
    ancestor = p.dirname(ancestor);
  }
  return unique(roots);
}

export function pathCandidates(name: string, context = toolContext()): string[] {
  const p = pathApi(context.platform);
  const searchPath = Object.entries(context.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  // .cmd/.bat require a shell on Windows; never execute user-controlled paths through a shell.
  const extensions = context.platform === 'win32' ? ['.exe', ''] : [''];
  return searchPath.split(p.delimiter).filter(Boolean)
    .flatMap((root) => extensions.map((extension) => p.join(root.replace(/^"|"$/g, ''), name + extension)));
}

export function toolCandidates(tool: 'python' | 'ffmpeg' | 'uv', configured = '', context = toolContext()): string[] {
  const p = pathApi(context.platform);
  const windows = context.platform === 'win32';
  const names = tool === 'python' ? (windows ? ['python', 'python3'] : ['python3', 'python']) : [tool];
  const bundled = tool === 'python'
    ? (windows ? ['python/python/python.exe'] : ['python/python/bin/python3', 'python/bin/python3', 'python/bin/python'])
    : tool === 'ffmpeg'
      ? (windows ? ['ffmpeg/bin/ffmpeg.exe'] : ['ffmpeg/bin/ffmpeg', 'ffmpeg/ffmpeg'])
      : (windows ? ['uv/uv.exe'] : ['uv/uv', 'uv/bin/uv']);
  const localPython = windows ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const extraRoots = context.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  return unique([
    configured,
    ...(tool === 'python' ? [p.join(context.cwd, localPython)] : []),
    ...resourceRoots(context).flatMap((root) => bundled.map((relative) => p.join(root, relative))),
    ...names.flatMap((name) => pathCandidates(name, context)),
    ...extraRoots.flatMap((root) => names.map((name) => p.join(root, name))),
    ...(tool === 'uv' ? [p.join(context.home, '.local', 'bin', windows ? 'uv.exe' : 'uv')] : []),
    ...names,
  ]);
}

export const pythonCandidates = (configured: string, context = toolContext()) => toolCandidates('python', configured, context);
export const ffmpegCandidates = (configured: string, context = toolContext()) => toolCandidates('ffmpeg', configured, context);

export async function uvPythonCandidates(context = toolContext()): Promise<string[]> {
  for (const uv of toolCandidates('uv', '', context)) {
    const result = await runCommand(uv, ['python', 'find', '--managed-python', '--no-python-downloads'], 8000);
    if (result.ok && result.stdout.trim()) return [result.stdout.trim()];
  }
  return [];
}

export async function userSiteDir(python: string | null): Promise<string | null> {
  if (!python) return null;
  const result = await runCommand(python, ['-c',
    'import site,sys;sys.stdout.write(site.getusersitepackages() if sys.prefix == sys.base_prefix else "")',
  ], 12000);
  const directory = result.ok ? result.stdout.trim() : '';
  return directory && existsSync(directory) ? directory : null;
}

export async function pythonRuntimeEnv(python: string | null): Promise<NodeJS.ProcessEnv> {
  const site = await userSiteDir(python);
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...(site ? { PYTHONPATH: [site, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : {}),
  };
}

export async function findFfmpeg(configured: string): Promise<string | null> {
  for (const candidate of ffmpegCandidates(configured)) {
    const outcome = await runCommand(candidate, ['-hide_banner', '-version'], 8000);
    if (outcome.ok) return candidate;
  }
  return null;
}

export async function probePython(configured: string): Promise<{ probe: EnvProbe; command: string | null }> {
  const managed = await uvPythonCandidates();
  const candidates = [...new Set([...pythonCandidates(configured), ...managed].filter(Boolean))];
  for (const candidate of candidates) {
    const outcome = await runCommand(candidate, ['-c',
      'import sys;print(sys.executable);print("Python "+sys.version.split()[0]);sys.exit(0 if sys.version_info >= (3,10) else 1)',
    ], 8000);
    if (outcome.ok) {
      const [executable, version] = outcome.stdout.trim().split(/\r?\n/);
      if (!executable) continue;
      return { probe: { ok: true, detail: `${executable} · ${version}`, resolvedPath: executable }, command: executable };
    }
  }
  return { probe: { ok: false, detail: '未找到 Python >=3.10 解释器', resolvedPath: null }, command: null };
}

export async function probeBleak(pythonCommand: string | null): Promise<EnvProbe> {
  if (!pythonCommand) return { ok: false, detail: '需要先有可用的 Python 才能检查 bleak', resolvedPath: null };
  const outcome = await runCommand(pythonCommand, ['-c', [
    'import bleak, importlib.metadata as m, sys',
    'if sys.platform == "win32":',
    '    from bleak.backends.winrt.client import BleakClientWinRT',
    '    from bleak.backends.winrt.scanner import BleakScannerWinRT',
    'elif sys.platform == "darwin":',
    '    from bleak.backends.corebluetooth.client import BleakClientCoreBluetooth',
    '    from bleak.backends.corebluetooth.scanner import BleakScannerCoreBluetooth',
    'elif sys.platform.startswith("linux"):',
    '    from bleak.backends.bluezdbus.client import BleakClientBlueZDBus',
    '    from bleak.backends.bluezdbus.scanner import BleakScannerBlueZDBus',
    'print("bleak " + m.version("bleak"))',
  ].join('\n')], 25000, await pythonRuntimeEnv(pythonCommand));
  if (outcome.ok) {
    const version = outcome.stdout.trim().replace(/^bleak\s+/, '') || 'unknown';
    return { ok: true, detail: `bleak ${version} 可导入`, resolvedPath: pythonCommand };
  }
  const hint = outcome.stderr.split('\n').filter(Boolean).pop() ?? 'import bleak 失败';
  return { ok: false, detail: hint.slice(0, 300), resolvedPath: null };
}

export async function probeSdk(pythonCommand: string | null): Promise<EnvProbe> {
  if (!pythonCommand) return { ok: false, detail: '需要先有可用的 Python 才能检查 memotalk-sdk', resolvedPath: null };
  const outcome = await runCommand(pythonCommand,
    ['-c', 'from memotalk import MemoTalkClient; from importlib.metadata import version; print("memotalk-sdk " + version("memotalk-sdk"))'],
    25000, await pythonRuntimeEnv(pythonCommand));
  return outcome.ok
    ? { ok: true, detail: `${outcome.stdout.trim()} 可导入`, resolvedPath: pythonCommand }
    : { ok: false, detail: `当前 Python 无法导入 memotalk-sdk：${outcome.stderr.trim().slice(-300)}`, resolvedPath: null };
}
