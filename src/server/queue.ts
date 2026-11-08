// ABOUTME: 任务车道：按标签前缀分车道，转录车道最多并行 N 条（Host ASR 有会话上限），其它车道各自串行。断网窗口内网络任务排队等待。

import { networkGate, type NetworkGate } from './network-gate';

type Task = () => Promise<unknown>;

interface Entry {
  label: string;
  lane: string;
  task: Task;
}

interface Lane {
  running: Set<Entry>;
  waiting: Entry[];
}

export const TRANSCRIBE_LANE = 'transcribe';
export const DEFAULT_ASR_CONCURRENCY = 3;
export const MAX_ASR_CONCURRENCY = 8;

/** 等待与执行中的任务，按入队顺序；直到 finally 清理才算结束。 */
const pending: Entry[] = [];
const lanes = new Map<string, Lane>();
const limits = new Map<string, number>([[TRANSCRIBE_LANE, DEFAULT_ASR_CONCURRENCY]]);
let idleWaiters: Array<() => void> = [];
let gate: NetworkGate = networkGate;

/** 只供测试替换闸门实例。 */
export function useNetworkGate(next: NetworkGate): void {
  gate = next;
}

export function isNetworkTask(label: string): boolean {
  return label.startsWith('transcribe:') || label.startsWith('organize:') || label.startsWith('scenes:');
}

export function laneOf(label: string): string {
  const index = label.indexOf(':');
  return index > 0 ? label.slice(0, index) : label;
}

/** 调整某条车道的并行上限；调大时立即补位，调小时不打断执行中的任务。 */
export function setLaneLimit(lane: string, limit: number): void {
  const value = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_ASR_CONCURRENCY) : 1;
  limits.set(lane, value);
  pump(lane);
}

export function laneLimit(lane: string): number {
  return limits.get(lane) ?? 1;
}

function laneFor(name: string): Lane {
  let lane = lanes.get(name);
  if (!lane) {
    lane = { running: new Set(), waiting: [] };
    lanes.set(name, lane);
  }
  return lane;
}

function pump(name: string): void {
  const lane = laneFor(name);
  while (lane.running.size < laneLimit(name) && lane.waiting.length > 0) {
    start(lane, lane.waiting.shift() as Entry);
  }
}

function start(lane: Lane, entry: Entry): void {
  lane.running.add(entry);
  const body = isNetworkTask(entry.label) ? () => gate.runNetworkTask(entry.task) : entry.task;
  Promise.resolve()
    .then(body)
    .catch(() => undefined)
    .finally(() => {
      lane.running.delete(entry);
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      pump(entry.lane);
      if (pending.length === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const waiter of waiters) waiter();
      }
    });
}

/** delayMs 期间任务已算排队（可见、拒绝重复），但不占车道名额。 */
export function enqueue(label: string, task: Task, options: { delayMs?: number } = {}): void {
  const entry: Entry = { label, lane: laneOf(label), task };
  pending.push(entry);
  const admit = () => {
    laneFor(entry.lane).waiting.push(entry);
    pump(entry.lane);
  };
  if (options.delayMs && options.delayMs > 0) setTimeout(admit, options.delayMs);
  else admit();
}

export function queueSnapshot(): string[] {
  return pending.map((entry) => entry.label);
}

export function isRunning(label: string): boolean {
  const lane = lanes.get(laneOf(label));
  return lane ? [...lane.running].some((entry) => entry.label === label) : false;
}

export function runningTasks(): string[] {
  return [...lanes.values()].flatMap((lane) => [...lane.running].map((entry) => entry.label));
}

/** 所有车道都没有等待或执行中的任务时 resolve。 */
export function whenIdle(): Promise<void> {
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/** 队列包含等待和正在执行的任务，直到 finally 清理才算结束。 */
export function queuedRecordingStatus(recordingId: number): 'queued_transcribe' | 'queued_organize' | null {
  const labels = queueSnapshot();
  if (labels.includes(`transcribe:${recordingId}`)) return 'queued_transcribe';
  if (labels.includes(`organize:${recordingId}`)) return 'queued_organize';
  return null;
}

export function hasRecordingTasks(): boolean {
  return pending.some((entry) => /^(transcribe|organize):\d+$/.test(entry.label));
}
