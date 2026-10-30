import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/server/media.ts';
import { probePython, pythonRuntimeEnv, pythonTextEnv, userSiteDir } from '../src/server/tools.ts';

test('Python discovery and user site preserve Chinese paths inherited from GBK environment', {
  skip: !process.env.MEMOTALK_TEST_PYTHON && 'Set MEMOTALK_TEST_PYTHON',
}, async () => {
  const python = process.env.MEMOTALK_TEST_PYTHON;
  assert.ok(python);
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-encoding-'));
  const legacy = { ...process.env, PYTHONUTF8: '0', PYTHONIOENCODING: 'gbk', PYTHONUSERBASE: path.join(root, '中文用户') };
  try {
    const broken = await runCommand(python, ['-c', 'print("\\u4e2d\\u6587")'], 10000, legacy);
    assert.equal(broken.ok, true);
    assert.notEqual(broken.stdout.trim(), '中文', 'reproduces the original decoding mismatch');
    const venv = path.join(root, '中文解释器');
    const created = await runCommand('uv', ['run', '--no-project', '--python', python, 'python', '-m', 'venv', '--without-pip', venv], 30000, pythonTextEnv(legacy));
    assert.equal(created.ok, true, created.stderr);
    const executable = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const found = await probePython(executable, legacy);
    assert.equal(found.command, executable);
    assert.ok(!found.probe.detail.includes('\ufffd'));
    const base = await runCommand(python, ['-c', 'import sys;print(sys._base_executable)'], 10000, pythonTextEnv(legacy));
    assert.equal(base.ok, true, base.stderr);
    const site = await runCommand(base.stdout.trim(), ['-m', 'site', '--user-site'], 10000, pythonTextEnv(legacy));
    assert.equal(site.ok, true, site.stderr);
    await mkdir(site.stdout.trim(), { recursive: true });
    assert.ok(site.stdout.includes('中文用户'));
    assert.equal(await userSiteDir(base.stdout.trim(), legacy), site.stdout.trim());
    const runtime = await pythonRuntimeEnv(base.stdout.trim(), legacy);
    assert.equal(runtime.PYTHONUTF8, '1');
    assert.equal(runtime.PYTHONIOENCODING, 'utf-8');
    assert.ok(runtime.PYTHONPATH?.includes('中文用户'));
    assert.equal(await userSiteDir(executable, legacy), null, 'venv does not inject user site');
    assert.equal(legacy.PYTHONIOENCODING, 'gbk', 'caller environment is not mutated');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
