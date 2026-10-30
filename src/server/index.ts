// ABOUTME: 组装服务入口，业务路由按领域拆分在 routes/ 下。

import { createWorkbenchServer } from '../../sdk/runtime.mjs';
import { registerAppRoute } from './app-route';
import { startAutoConnect } from './auto-connect';
import { registerCategoryRoutes } from './routes/categories';
import { registerCalendarRoutes } from './routes/calendar';
import { registerDeviceRoutes } from './routes/device';
import { registerIngestRoutes } from './routes/ingest';
import { registerLiveRoutes } from './routes/live';
import { registerMediaRoutes } from './routes/media';
import { registerPipelineRoutes } from './routes/pipeline';
import { registerRecordingRoutes } from './routes/recordings';
import { registerSettingRoutes } from './routes/settings';
import { recoverInterruptedTasks } from './sql';
import { registerEnvironmentRoutes } from './routes/environment';

const app = await createWorkbenchServer(import.meta.url);

recoverInterruptedTasks(app.database);
registerAppRoute(app);
registerRecordingRoutes(app);
registerCalendarRoutes(app);
registerPipelineRoutes(app);
registerCategoryRoutes(app);
registerIngestRoutes(app);
registerMediaRoutes(app);
registerLiveRoutes(app);
const preflight = registerEnvironmentRoutes(app);
registerDeviceRoutes(app, preflight);
registerSettingRoutes(app);

startAutoConnect(app);
await app.listen();
void preflight.get().catch((error) => console.error('preflight failed', error));
