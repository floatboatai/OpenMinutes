import { spawnSync } from 'node:child_process';

const python = process.env.MEMOTALK_TEST_PYTHON;
if (!python) {
  console.error('MEMOTALK_TEST_PYTHON must point to a persistent Python environment with memotalk-sdk installed.');
  process.exit(1);
}

const checks = [
  ['uv', ['--version']],
  [process.env.FFMPEG_TEST_COMMAND ?? 'ffmpeg', ['-version']],
  ['ffmpeg', ['-version']],
  ['ffprobe', ['-version']],
  ['uv', ['run', '--no-project', '--python', python, 'python', '-c',
    'import bleak; from memotalk import MemoTalkClient; from memotalk.fake import FakeMemoTalk, FakeTransport']],
];

for (const [command, args] of checks) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.error || result.status !== 0) {
    console.error(`${command}: ${result.error?.message ?? result.stderr} (exit ${result.status})`);
    process.exit(1);
  }
}
console.log('CI test dependencies are available.');
