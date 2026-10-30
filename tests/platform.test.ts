import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toolCandidates, resourceRoots, pathCandidates, type ToolContext } from '../src/server/tools.ts';
import { containsPath, expandHomePath, portableFilename, canonicalPath, sameDirectory } from '../src/server/paths.ts';
import { runCommand } from '../src/server/media.ts';

for (const platform of ['win32', 'darwin', 'linux'] as const) {
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const context: ToolContext = {
    platform, home: windows ? 'C:\\Users\\test' : '/home/test', cwd: windows ? 'C:\\app' : '/app',
    execPath: windows ? 'C:\\Program Files\\Floatboat\\resources\\nodejs\\node.exe'
      : platform === 'darwin' ? '/Applications/Floatboat.app/Contents/Resources/nodejs/bin/node' : '/opt/Floatboat/resources/nodejs/node',
    env: { Path: windows ? 'C:\\tools;C:\\space dir' : '/usr/bin:/custom/bin' },
  };
  test(`${platform}: native candidates, PATH delimiter, configured override and project venv`, () => {
    const python = toolCandidates('python', 'selected-python', context);
    assert.equal(python[0], 'selected-python');
    assert.equal(python[1], p.join(context.cwd, windows ? '.venv/Scripts/python.exe' : '.venv/bin/python'));
    assert.equal(python.length, new Set(python).size);
    const ffmpeg = toolCandidates('ffmpeg', '', context);
    assert.ok(ffmpeg.includes(windows ? 'C:\\Program Files\\Floatboat\\resources\\ffmpeg\\bin\\ffmpeg.exe'
      : platform === 'darwin' ? '/Applications/Floatboat.app/Contents/Resources/ffmpeg/bin/ffmpeg' : '/opt/Floatboat/resources/ffmpeg/bin/ffmpeg'));
    assert.ok(pathCandidates('python3', context).includes(windows ? 'C:\\space dir\\python3.exe' : '/custom/bin/python3'));
    assert.ok(!python.some((candidate) => /\.(cmd|bat)$/.test(candidate)));
    if (!windows) {
      assert.ok(!python.some((candidate) => candidate.endsWith('.exe')));
      assert.ok(python.indexOf('python3') < python.indexOf('python'));
    }
    if (platform === 'darwin') {
      assert.ok(python.includes('/opt/homebrew/bin/python3'));
      assert.ok(python.includes('/usr/local/bin/python3'));
      assert.ok(resourceRoots({ ...context, execPath: '/Applications/Floatboat.app/Contents/MacOS/Floatboat' })
        .includes('/Applications/Floatboat.app/Contents/Resources'));
    }
    assert.ok(toolCandidates('uv', '', context).some((candidate) => candidate.includes('.local')));
  });
  test(`${platform}: home shorthand, boundary-aware ancestry and case handling`, () => {
    assert.equal(expandHomePath('~\\memo\\inbox', context.home, platform), p.join(context.home, 'memo', 'inbox'));
    assert.equal(expandHomePath('~', context.home, platform), context.home);
    assert.equal(containsPath(p.join(context.home, 'memo'), p.join(context.home, 'memo-other'), platform), false);
    assert.equal(containsPath(p.join(context.home, 'Memo'), p.join(context.home, 'memo', 'inbox'), platform), windows);
    assert.equal(containsPath(p.join(context.home, 'memo'), p.join(context.home, 'memo', 'inbox'), platform), true);
  });
}

test('filenames are portable and cannot contain path traversal or Windows reserved names', () => {
  for (const name of ['CON', 'con.wav', 'LPT1.mp3', 'AUX.', 'nul ']) assert.match(portableFilename(name), /^_/);
  assert.equal(portableFilename('C:\\foo\\clip.wav'), 'clip.wav');
  assert.equal(portableFilename('../clip.wav'), 'clip.wav');
  assert.equal(portableFilename('..'), 'recording');
  assert.equal(portableFilename('a.wav. '), 'a.wav');
});

test('filesystem identity and non-existing child resolve through real ancestors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-path-'));
  try {
    await mkdir(path.join(root, 'a'));
    await symlink(path.join(root, 'a'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(sameDirectory(path.join(root, 'a'), path.join(root, 'a', '..', 'a')), true);
    assert.equal(sameDirectory(path.join(root, 'a'), path.join(root, 'alias')), true);
    assert.equal(canonicalPath(path.join(root, 'alias', 'new')), path.join(canonicalPath(root), 'a', 'new'));
    assert.equal(canonicalPath(path.join(root, 'a', 'new')), path.join(canonicalPath(root), 'a', 'new'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('short commands receive stdin EOF and report errors/timeouts without hanging', async () => {
  const eof = await runCommand(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("EOF"))']);
  assert.equal(eof.ok, true);
  assert.equal(eof.stdout.trim(), 'EOF');
  assert.equal((await runCommand('openminutes-no-such-executable', [])).ok, false);
  const timed = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100);
  assert.equal(timed.ok, false);
  assert.match(timed.stderr, /超时/);
});
