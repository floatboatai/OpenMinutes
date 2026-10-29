// Platform-dependent tool discovery is kept here; candidates are verified before use.
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCommand } from './media';

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
