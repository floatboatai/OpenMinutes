// ABOUTME: 串行任务队列；Host ASR 有并发上限，接入类任务一次只跑一条。断网窗口内网络任务排队等待。

import { networkGate, type NetworkGate } from './network-gate';

type Task = () => Promise<unknown>;

let chain: Promise<void> = Promise.resolve();
const pending: string[] = [];
let running: string | null = null;
let gate: NetworkGate = networkGate;

/** 只供测试替换闸门实例。 */
export function useNetworkGate(next: NetworkGate): void {
  gate = next;
}

export function isNetworkTask(label: string): boolean {
  return label.startsWith('transcribe:') || label.startsWith('organize:');
}

export function enqueue(label: string, task: Task): void {
  pending.push(label);
  const body = isNetworkTask(label) ? () => gate.runNetworkTask(task) : task;
  chain = chain
    .then(() => {
      running = label;
      return body();
    })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (running === label) running = null;
      const index = pending.indexOf(label);
      if (index >= 0) pending.splice(index, 1);
    });
}

export function queueSnapshot(): string[] {
  return [...pending];
}

export function runningTask(): string | null {
  return running;
}

/** 队列包含等待和正在执行的任务，直到 finally 清理才算结束。 */
export function queuedRecordingStatus(recordingId: number): 'queued_transcribe' | 'queued_organize' | null {
  if (pending.includes(`transcribe:${recordingId}`)) return 'queued_transcribe';
  if (pending.includes(`organize:${recordingId}`)) return 'queued_organize';
  return null;
}

export function hasRecordingTasks(): boolean {
  return pending.some((label) => /^(transcribe|organize):\d+$/.test(label));
}
