// ABOUTME: 串行任务队列；Host ASR 有并发上限，接入类任务一次只跑一条。

type Task = () => Promise<unknown>;

let chain: Promise<void> = Promise.resolve();
const pending: string[] = [];

export function enqueue(label: string, task: Task): void {
  pending.push(label);
  chain = chain
    .then(task)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      const index = pending.indexOf(label);
      if (index >= 0) pending.splice(index, 1);
    });
}

export function queueSnapshot(): string[] {
  return [...pending];
}
