#!/usr/bin/env node
// Local Windows TTS only. No Host or network calls.
// Usage: speech.mjs <runId> [1|2|3]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const [runId, variant = '1'] = process.argv.slice(2);
if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId) || !['1', '2', '3'].includes(variant)) {
  throw new Error('usage: speech.mjs <runId> [1|2|3]');
}
const texts = [
  '今天讨论产品发布计划。项目代号是蓝色铅笔。请小王在周五之前完成测试报告。我们决定先修复录音搜索，再发布新版本。这件事情非常重要。',
  '今天讨论团队培训。主题是数据库备份。请小李明天准备操作手册，下周一安排演练。大家同意每周检查一次备份结果。',
  '今天讨论办公室采购。我们需要两台显示器。请小张周三之前收集报价，周四确认预算。采购完成以后再安排设备安装。',
];
const run = JSON.parse(readFileSync(join(root, '.workbench', 'verify', runId, 'run.json'), 'utf8'));
const textPath = join(run.runDir, `speech-${variant}.txt`);
const wavPath = join(run.runDir, `speech-${variant}.wav`);
const filename = `REC20261029_12000${variant}.mp3`;
const output = join(run.dirs.inbox, filename);
if (existsSync(output)) throw new Error('speech fixture already exists');
writeFileSync(textPath, texts[Number(variant) - 1], 'utf8');
const script = `
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $voice = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
    if (-not $voice) { throw 'Chinese Windows TTS voice required' }
    $s.SelectVoice($voice.VoiceInfo.Name)
    $s.Rate = 0
    $s.SetOutputToWaveFile($env:VERIFY_SPEECH_WAV)
    $s.Speak([IO.File]::ReadAllText($env:VERIFY_SPEECH_TEXT, [Text.Encoding]::UTF8))
    $s.SetOutputToNull()
    Write-Output $voice.VoiceInfo.Name
  } finally { $s.Dispose() }
`;
const voice = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, VERIFY_SPEECH_TEXT: textPath, VERIFY_SPEECH_WAV: wavPath },
}).trim();
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', wavPath,
  '-ar', '16000', '-ac', '1', '-b:a', '32k', output], { windowsHide: true });
const evidence = { filename, voice, text: texts[Number(variant) - 1], sampleRate: 16000, channels: 1 };
writeFileSync(join(run.evidenceDir, `speech-${variant}.json`), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
