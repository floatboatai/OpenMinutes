// ABOUTME: 组装服务入口，业务路由按领域拆分在 routes/ 下；设备服务是录音笔的唯一所有者。

import { createWorkbenchServer } from '../../sdk/runtime.mjs';
import { AppError } from '../contracts/errors';
import { registerAppRoute } from './app-route';
import { startAutoConnect } from './device/auto-connect';
import { createDeviceService } from './device/service';
import { registerCategoryRoutes } from './routes/categories';
import { registerCalendarRoutes } from './routes/calendar';
import { registerDeviceRoutes } from './routes/device';
import { registerDiagnosticsRoutes } from './routes/diagnostics';
import { registerIngestRoutes } from './routes/ingest';
import { registerLiveRoutes } from './routes/live';
import { registerMediaRoutes } from './routes/media';
import { registerPipelineRoutes } from './routes/pipeline';
import { registerRecordingRoutes } from './routes/recordings';
import { registerSceneRoutes } from './routes/scenes';
import { registerSettingRoutes } from './routes/settings';
import { recoverInterruptedTasks } from './sql';
import { registerEnvironmentRoutes } from './routes/environment';
import { applyAsrConcurrency, resumeQueuedTasks } from './jobs';

const app = await createWorkbenchServer(import.meta.url);

const recovery = recoverInterruptedTasks(app.database);
applyAsrConcurrency(app.database);
registerAppRoute(app);
registerRecordingRoutes(app);
registerCalendarRoutes(app);
registerPipelineRoutes(app);
registerSceneRoutes(app);
registerCategoryRoutes(app);
registerIngestRoutes(app);
registerMediaRoutes(app);
const preflight = registerEnvironmentRoutes(app);

const device = createDeviceService(app, {
  // 环境自检已知 Python 或设备 SDK 不可用时直接报 RUNTIME_MISSING，不派生 worker。
  resolvePython: async () => {
    let { env } = await preflight.get();
    if (!env.python.resolvedPath || !env.sdk.ok || !env.bleak.ok) ({ env } = await preflight.get(true));
    if (!env.python.resolvedPath || !env.sdk.ok || !env.bleak.ok) {
      const failed = [env.python, env.bleak, env.sdk].filter((probe) => !probe.ok).map((probe) => probe.detail);
      throw new AppError('RUNTIME_MISSING', undefined, failed.join('\n'));
    }
    return env.python.resolvedPath;
  },
});
registerDeviceRoutes(app, device, preflight);
registerDiagnosticsRoutes(app, device, preflight);
registerLiveRoutes(app, device);
registerSettingRoutes(app);

startAutoConnect({ db: app.database, service: device });
await app.listen();
resumeQueuedTasks(app, recovery.requeue);
void preflight.get().catch((error) => console.error('preflight failed', error));
