// ABOUTME: 应用公开信息与总览统计路由。

import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import type { AppInfo, Overview } from '../contracts/app';
import { api } from './http';
import { buildOverview, listTagNames } from './repo';

export function registerAppRoute(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/app',
    api((): AppInfo => ({ name: app.manifest.name, version: app.manifest.version })),
  );

  app.route(
    'GET',
    '/api/overview',
    api((context): Overview => buildOverview(context.database)),
  );

  app.route(
    'GET',
    '/api/tags',
    api((context) => listTagNames(context.database)),
  );
}
