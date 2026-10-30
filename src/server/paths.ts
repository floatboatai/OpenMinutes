import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export function platformPath(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function expandHomePath(input: string, home: string, platform: NodeJS.Platform): string {
  const value = input.trim();
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return platformPath(platform).join(home, value.slice(2).replace(/\\/g, '/'));
  }
  return value;
}

export function normalizedPath(input: string, platform: NodeJS.Platform): string {
  const value = platformPath(platform).resolve(input);
  return platform === 'win32' ? value.toLowerCase() : value;
}

export function containsPath(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = platformPath(platform);
  const relative = p.relative(normalizedPath(parent, platform), normalizedPath(child, platform));
  return relative === '' || (!relative.startsWith(`..${p.sep}`) && relative !== '..' && !p.isAbsolute(relative));
}

// Resolve the nearest existing ancestor too, so new directories below a symlink work.
export function canonicalPath(input: string): string {
  const absolute = path.resolve(input);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
  }
}

export function sameDirectory(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return normalizedPath(canonicalPath(a), process.platform) === normalizedPath(canonicalPath(b), process.platform);
  }
}

export function portableFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  let safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 160).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe || 'recording';
}
