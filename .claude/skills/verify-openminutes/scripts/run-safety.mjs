import { lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(runId)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId)) {
    throw new Error('Invalid runId: use 1-80 letters, digits, underscores or hyphens, starting with a letter or digit');
  }
  return runId;
}

function contained(root, target) {
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe path outside its parent: ${target}`);
  }
}

// Reject links at every existing component, including dangling links and Windows junctions.
export function safePath(root, ...parts) {
  root = realpathSync(root);
  const target = resolve(root, ...parts);
  contained(root, target);
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Unsafe linked path: ${current}`);
    contained(root, realpathSync(current));
  }
  return target;
}

export function runPaths(root, runId) {
  validateRunId(runId);
  root = realpathSync(root);
  return {
    root,
    runDir: safePath(root, '.workbench', 'verify', runId),
    evidenceDir: safePath(root, '.workbench', 'verify-evidence', runId),
  };
}

export function assertDeletionSafe(root, runId) {
  const { runDir } = runPaths(root, runId);
  function walk(path) {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Unsafe linked path: ${path}`);
    if (path !== runDir) safePath(runDir, relative(runDir, path));
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  }
  walk(runDir);
  return runDir;
}

export function readRun(root, runId) {
  const paths = runPaths(root, runId);
  const run = JSON.parse(readFileSync(safePath(paths.runDir, 'run.json'), 'utf8'));
  const dirs = { data: 'data', inbox: 'inbox', library: 'library', browserProfile: 'browser-profile' };
  if (run.runId !== runId || run.root !== paths.root || run.runDir !== paths.runDir
    || run.evidenceDir !== paths.evidenceDir || !Number.isSafeInteger(run.pid) || run.pid <= 0
    || typeof run.nonce !== 'string' || !run.nonce) throw new Error('Invalid run record');
  for (const [key, name] of Object.entries(dirs)) {
    if (run.dirs?.[key] !== safePath(paths.runDir, name)) throw new Error(`Invalid run directory: ${key}`);
  }
  localOrigin(run.url);
  return run;
}

export function localOrigin(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Invalid instance URL');
  }
  return parsed.origin;
}

export async function assertIdentity(run) {
  const response = await fetch(`${localOrigin(run.url)}/__workbench/health`, {
    headers: { authorization: `Bearer ${run.nonce}` },
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  const body = await response.json();
  if (!response.ok || body.pid !== run.pid || body.generation !== run.runId || body.closing) {
    throw new Error('Instance identity mismatch');
  }
  return body;
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function waitStopped(pid) {
  const deadline = Date.now() + 10000;
  while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  if (alive(pid)) throw new Error(`pid ${pid} still alive; scratch retained`);
}
