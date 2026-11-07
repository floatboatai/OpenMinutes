// ABOUTME: 网络闸门：录音笔无线快传期间电脑会断开外网，暂停 Host 任务并让队列外调用快速失败。

import { AppError } from '../contracts/errors';

export interface AcquireOptions {
  /** 等待进行中的网络任务结束的上限；超时则放弃断网并返回 null。 */
  waitForInFlightMs: number;
  /** 中止时恢复闸门并立即返回 null（用户停止或断开）。 */
  signal?: AbortSignal;
}

export class NetworkGate {
  private offlineReason: string | null = null;
  private inFlight = 0;
  private onlineWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];

  isOffline(): boolean {
    return this.offlineReason !== null;
  }

  reason(): string | null {
    return this.offlineReason;
  }

  runningNetworkTasks(): number {
    return this.inFlight;
  }

  whenOnline(): Promise<void> {
    if (!this.offlineReason) return Promise.resolve();
    return new Promise((resolve) => this.onlineWaiters.push(resolve));
  }

  /** 队列外的 Host 调用在断网期间快速失败。 */
  assertOnline(): void {
    if (this.offlineReason) throw new AppError('NETWORK_PAUSED', undefined, `network gate held by ${this.offlineReason}`);
  }

  /** 网络任务先等闸门打开；检查与计数在同一同步段内完成，避免与断网申请交错。 */
  async runNetworkTask<T>(task: () => Promise<T>): Promise<T> {
    while (this.offlineReason) await this.whenOnline();
    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.flush('idle');
    }
  }

  /** 先关闸，再等进行中的网络任务结束；超时恢复闸门并返回 null。 */
  async acquireOffline(reason: string, options: AcquireOptions): Promise<(() => void) | null> {
    if (this.offlineReason || options.signal?.aborted) return null;
    this.offlineReason = reason;
    if (this.inFlight > 0) {
      const idle = await new Promise<boolean>((resolve) => {
        const finish = (value: boolean) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== done);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), options.waitForInFlightMs);
        timer.unref?.();
        const done = () => finish(true);
        const onAbort = () => finish(false);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        this.idleWaiters.push(done);
      });
      if (!idle) {
        this.open();
        return null;
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.open();
    };
  }

  private open(): void {
    this.offlineReason = null;
    this.flush('online');
  }

  private flush(kind: 'online' | 'idle'): void {
    const waiters = kind === 'online' ? this.onlineWaiters : this.idleWaiters;
    if (kind === 'online') this.onlineWaiters = [];
    else this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }
}

export const networkGate = new NetworkGate();
