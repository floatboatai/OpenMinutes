// ABOUTME: 组装服务入口，业务路由按领域拆分在 routes/ 下。

import path from 'node:path';
import { createWorkbenchServer } from '../../sdk/runtime.mjs';
import { registerAppRoute } from './app-route';
import { setPythonLibDir } from './bridge';
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

// 工作台自带的 Python 依赖目录（数据区 python-libs），供 BLE 桥接注入 PYTHONPATH。
const audioDirectory = await app.resources.path('audio', undefined, 'write');
setPythonLibDir(path.join(path.dirname(audioDirectory), 'python-libs'));

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
