#!/usr/bin/env node
// Offline Windows TTS. Publish only a validated MP3; never overwrite an existing fixture.
// Usage: node make-voice.mjs --output <RECyyyyMMdd_HHmmss.mp3> [--language zh-CN|en-US] [--text <short sentence>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const defaults = {
  'zh-CN': '\u4eca\u5929\u4e0b\u5348\u4e09\u70b9\u9879\u76ee\u8bc4\u5ba1\u4f1a\uff0c\u8bf7\u63d0\u524d\u5341\u5206\u949f\u5230\u573a\u3002',
  'en-US': 'The project review is at three today. Please arrive ten minutes early.',
};

function command(exe, args, env = process.env) {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, env });
  if (result.error || result.status !== 0) {
    throw new Error(`${exe}: ${result.error?.message ?? result.stderr ?? result.stdout} (exit ${result.status})`);
  }
  return result.stdout.trim();
}

function probe(file) {
  return JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

let scratch;
try {
  const { values } = parseArgs({ options: {
    output: { type: 'string' }, language: { type: 'string', default: 'zh-CN' }, text: { type: 'string' },
  } });
  if (process.platform !== 'win32') throw new Error('System.Speech requires Windows with an installed desktop TTS voice.');
  if (!values.output || !/^REC\d{8}_\d{6}\.mp3$/.test(basename(values.output))) {
    throw new Error('--output must name RECyyyyMMdd_HHmmss.mp3 in the run inbox.');
  }
  if (!Object.hasOwn(defaults, values.language)) throw new Error('--language must be zh-CN or en-US.');
  if (values.text !== undefined && (!values.text.trim() || values.text.length > 200)) {
    throw new Error('--text must contain 1..200 characters.');
  }
  const output = resolve(values.output);
  const reportPath = `${output}.voice.json`;
  if (existsSync(output) || existsSync(reportPath)) throw new Error('Fixture already exists; use a new recording filename.');
  mkdirSync(dirname(output), { recursive: true });
  scratch = mkdtempSync(join(dirname(output), '.voice-'));
  const wav = join(scratch, 'speech.wav');
  const mp3 = join(scratch, 'speech.mp3');
  const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  $voice = $voices | Where-Object { $_.Culture.Name -eq $env:VOICE_LANGUAGE } | Select-Object -First 1
  $fallback = $false
  $text = $env:VOICE_TEXT
  if ($null -eq $voice) {
    $voice = $voices | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
    if ($null -eq $voice) { throw 'No requested or English desktop TTS voice installed.' }
    if ($env:VOICE_CUSTOM -eq '1') { throw 'Requested voice missing; omit --text to use the documented English fallback.' }
    $fallback = $true
    $text = $env:VOICE_ENGLISH
  }
  $s.SelectVoice($voice.Name)
  $s.Rate = 0
  $s.SetOutputToWaveFile($env:VOICE_WAV)
  $s.Speak($text)
  $s.SetOutputToNull()
  @{ voice = $voice.Name; language = $voice.Culture.Name; text = $text; fallback = $fallback;
     installedVoices = @($voices | ForEach-Object { @{ name = $_.Name; language = $_.Culture.Name } }) } | ConvertTo-Json -Depth 4 -Compress
} finally { $s.Dispose() }
`;
  const speech = JSON.parse(command('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64'),
  ], { ...process.env, VOICE_LANGUAGE: values.language, VOICE_TEXT: values.text ?? defaults[values.language],
    VOICE_CUSTOM: values.text === undefined ? '0' : '1', VOICE_ENGLISH: defaults['en-US'], VOICE_WAV: wav }));
  const wavDuration = Number(probe(wav).format.duration);
  if (!Number.isFinite(wavDuration) || wavDuration <= 0 || wavDuration > 10) {
    throw new Error(`Speech duration ${wavDuration}s is unsuitable; use a shorter sentence (at most 10s before tempo adjustment).`);
  }
  // Preserve every spoken word. Speed up long sentences, pad short ones; never trim with -t.
  const tempo = wavDuration > 5 ? wavDuration / 5 : 1;
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', wav,
    '-af', `atempo=${tempo},apad=whole_dur=3.2`, '-ar', '16000', '-ac', '1',
    '-codec:a', 'libmp3lame', '-b:a', '32k', '-map_metadata', '-1', mp3]);
  const media = probe(mp3);
  const duration = Number(media.format.duration);
  const audio = media.streams.find((stream) => stream.codec_type === 'audio');
  if (audio?.codec_name !== 'mp3' || audio.sample_rate !== '16000' || audio.channels !== 1 || !(duration >= 3 && duration <= 6)) {
    throw new Error(`Unexpected MP3 format: ${JSON.stringify(media)}`);
  }
  const report = { ...speech, requestedLanguage: values.language, output, wavDuration, tempo, duration,
    sampleRate: 16000, channels: 1, sha256: createHash('sha256').update(readFileSync(mp3)).digest('hex') };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  copyFileSync(mp3, output, constants.COPYFILE_EXCL);
  if (speech.fallback) console.error(`Requested voice unavailable; used English: ${speech.voice}. Chinese ASR remains unverified.`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
