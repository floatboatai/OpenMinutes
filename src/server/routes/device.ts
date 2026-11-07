// ABOUTME: 录音笔路由：连接/断开、同步全部/单条、停止、清理已同步的录音。全部经由设备服务。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { DeviceView } from '../../contracts/device';
import { AppError } from '../../contracts/errors';
import { asObject, BadInput, optIntArray } from '../../contracts/input';
import { api } from '../http';
import type { appPreflight } from '../preflight';
import type { DeviceService } from '../device/service';

const CONNECT_WAIT_MS = 30_000;

type Preflight = ReturnType<typeof appPreflight>;

/** GET /api/device 每 1.5 秒轮询一次：只读内存和 preflight 缓存，绝不派生探测进程。 */
export function deviceView(service: DeviceService, preflight?: Preflight): DeviceView {
  const view = service.view();
  const report = preflight?.peek()?.report;
  view.environment = { failCount: report ? report.items.filter((item) => item.status === 'fail').length : 0 };
  return view;
}

function startedJob(service: DeviceService): { jobId: string } {
  const jobId = service.view().activity?.jobId;
  if (!jobId) throw new AppError('INTERNAL_ERROR', undefined, 'activity was not registered');
  return { jobId };
}

export function registerDeviceRoutes(app: WorkbenchServer, service: DeviceService, preflight?: Preflight): void {
  app.route('GET', '/api/device', api(() => deviceView(service, preflight)));

  app.route(
    'POST',
    '/api/device/connect',
    api(async () => {
      const connecting = service.connect({ origin: 'user' });
      connecting.catch(() => undefined);
      const timer = new Promise<'pending'>((resolve) => {
        const handle = setTimeout(() => resolve('pending'), CONNECT_WAIT_MS);
        handle.unref?.();
      });
      // 连接最多等 30 秒；超过时返回当前状态，页面继续轮询。
      await Promise.race([connecting, timer]);
      return deviceView(service, preflight);
    }),
  );

  app.route('POST', '/api/device/disconnect', api(async () => {
    await service.disconnect({ reason: 'user' });
    return deviceView(service, preflight);
  }));

  app.route('POST', '/api/device/sync', api(() => {
    void service.sync({ origin: 'user' }).catch(() => undefined);
    return startedJob(service);
  }));

  app.route('POST', '/api/device/pull', api((context) => {
    const ids = optIntArray(asObject(context.body), 'ids', 100) ?? [];
    if (ids.length === 0) throw new BadInput('ids 至少包含 1 条录音');
    void service.sync({ ids, origin: 'user' }).catch(() => undefined);
    return startedJob(service);
  }));

  app.route('POST', '/api/device/cancel', api(() => {
    void service.cancel();
    return deviceView(service, preflight);
  }));

  app.route('POST', '/api/device/cleanup', api(() => {
    void service.cleanup({ origin: 'user' }).catch(() => undefined);
    return startedJob(service);
  }));
}
