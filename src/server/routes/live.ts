// ABOUTME: 实时字幕会话的查询与控制路由。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { LiveState } from '../../contracts/app';
import { api } from '../http';
import { getLiveState, startLive, stopLive } from '../live';
import type { DeviceService } from '../device/service';

export function registerLiveRoutes(app: WorkbenchServer, service: DeviceService): void {
  app.route(
    'GET',
    '/api/live',
    api((): LiveState => getLiveState()),
  );

  app.route(
    'POST',
    '/api/live/start',
    api(async (): Promise<LiveState> => startLive(app, service)),
  );

  app.route(
    'POST',
    '/api/live/stop',
    api(async (): Promise<LiveState> => stopLive(app)),
  );
}
