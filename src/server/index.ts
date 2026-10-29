// ABOUTME: 组装服务入口，业务路由按领域拆分在 routes/ 下。

import { createWorkbenchServer } from '../../sdk/runtime.mjs';
import { registerAppRoute } from './app-route';
import { startAutoConnect } from './auto-connect';
import { registerCategoryRoutes } from './routes/categories';
import { registerDeviceRoutes } from './routes/device';
import { registerIngestRoutes } from './routes/ingest';
import { registerLiveRoutes } from './routes/live';
import { registerMediaRoutes } from './routes/media';
import { registerPipelineRoutes } from './routes/pipeline';
import { registerRecordingRoutes } from './routes/recordings';
import { registerSettingRoutes } from './routes/settings';

const app = await createWorkbenchServer(import.meta.url);

registerAppRoute(app);
registerRecordingRoutes(app);
registerPipelineRoutes(app);
registerCategoryRoutes(app);
registerIngestRoutes(app);
registerMediaRoutes(app);
registerLiveRoutes(app);
registerDeviceRoutes(app);
registerSettingRoutes(app);

startAutoConnect(app);
await app.listen();
