// ABOUTME: 把一天的多段录音排成一条发言时间线，并按长静默粗切、按字数分窗口；纯函数，不访问数据库或模型。

import type { TranscriptSegment } from '../../contracts/app';

export interface TimelineRecording {
  id: number;
  title: string;
  recordedAt: string;
  durationSec: number | null;
  segments: TranscriptSegment[];
  text: string;
}

export interface Utterance {
  recordingId: number;
  /** 在该录音分段数组中的下标；没有分段时为 -1。 */
  segmentIndex: number;
  startMs: number;
  endMs: number;
  /** 绝对时间（毫秒时间戳）。 */
  at: number;
  endAt: number;
  text: string;
  /** 带录音前缀的说话人键；同一 ASR 会话外不保证是同一个人。 */
  speakerKey: string | null;
}

/** 两句之间超过这个静默就视为不同场景。 */
export const SCENE_GAP_MS = 3 * 60 * 1000;
/** 单次送给模型切场景的字数上限；P0 实测后再调整。 */
export const WINDOW_CHARS = 6000;

/** 没有可靠结束时间的分段，按中文语速约 4 字/秒估算。 */
function estimateMs(text: string): number {
  return Math.max(1000, Math.round((text.length / 4) * 1000));
}

export function buildTimeline(recordings: TimelineRecording[]): Utterance[] {
  const result: Utterance[] = [];
  for (const recording of recordings) {
    const base = Date.parse(recording.recordedAt);
    if (Number.isNaN(base)) continue;
    const segments = recording.segments.filter((segment) => segment.text.trim());
    if (segments.length === 0) {
      const text = recording.text.trim();
      if (!text) continue;
      const endMs = recording.durationSec ? recording.durationSec * 1000 : estimateMs(text);
      result.push({ recordingId: recording.id, segmentIndex: -1, startMs: 0, endMs, at: base, endAt: base + endMs, text, speakerKey: null });
      continue;
    }
    recording.segments.forEach((segment, index) => {
      const text = segment.text.trim();
      if (!text) return;
      const endMs = segment.endMs > segment.startMs ? segment.endMs : segment.startMs + estimateMs(text);
      result.push({
        recordingId: recording.id,
        segmentIndex: index,
        startMs: segment.startMs,
        endMs,
        at: base + segment.startMs,
        endAt: base + endMs,
        text,
        speakerKey: segment.speaker ? `${recording.id}:${segment.speaker}` : null,
      });
    });
  }
  return result.sort((a, b) => a.at - b.at || a.recordingId - b.recordingId || a.segmentIndex - b.segmentIndex);
}

/** 按长静默切成互不相连的块；块边界一定是场景边界。 */
export function splitByGap(utterances: Utterance[], gapMs = SCENE_GAP_MS): Utterance[][] {
  const blocks: Utterance[][] = [];
  let current: Utterance[] = [];
  let lastEnd = -Infinity;
  for (const utterance of utterances) {
    if (current.length > 0 && utterance.at - lastEnd > gapMs) {
      blocks.push(current);
      current = [];
    }
    current.push(utterance);
    lastEnd = Math.max(lastEnd, utterance.endAt);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** 把一个块切成不超过 maxChars 的连续窗口；单句超长时独占一个窗口。 */
export function splitWindows(block: Utterance[], maxChars = WINDOW_CHARS): Utterance[][] {
  const windows: Utterance[][] = [];
  let current: Utterance[] = [];
  let size = 0;
  for (const utterance of block) {
    if (current.length > 0 && size + utterance.text.length > maxChars) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(utterance);
    size += utterance.text.length;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 渲染给模型看的逐句文本：`[序号] 时:分 说话人X：内容`。说话人只在本次渲染内编号。 */
export function renderUtterances(utterances: Utterance[], numbered: boolean): string {
  const labels = new Map<string, string>();
  return utterances
    .map((utterance, index) => {
      let speaker = '';
      if (utterance.speakerKey) {
        if (!labels.has(utterance.speakerKey)) labels.set(utterance.speakerKey, String.fromCharCode(65 + (labels.size % 26)));
        speaker = ` 说话人${labels.get(utterance.speakerKey)}`;
      }
      return `${numbered ? `[${index}] ` : ''}${clock(utterance.at)}${speaker}：${utterance.text}`;
    })
    .join('\n');
}
