// ABOUTME: 本机环境路由：自检、重新检测、Floatboat 助手修复与宿主能力清单（设置 › 诊断与高级）。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import { api } from '../http';
import { appPreflight, listHostCapabilities } from '../preflight';
import { createEnvironmentRepair } from '../environment-repair';
import { networkGate } from '../network-gate';
import { toolContext } from '../tools';
import { sqliteRepairStore } from '../repair-store';

export function registerEnvironmentRoutes(app: WorkbenchServer) {
  const preflight = appPreflight(app);
  const repair = createEnvironmentRepair({
    host: app.host,
    report: async (refresh) => {
      // A check started before the agent finished cannot verify its changes.
      if (refresh) await preflight.get();
      return (await preflight.get(refresh)).report;
    },
    workingDirectory: toolContext().cwd,
    store: sqliteRepairStore(app.database, toolContext().cwd),
    gate: networkGate,
  });
  app.route('GET', '/api/environment', api(async () => ({
    report: (await preflight.get()).report,
    repair: repair.get(),
  })));
  app.route('POST', '/api/environment/check', api(async () => (await preflight.get(true)).report));
  app.route('POST', '/api/environment/repair', api(() => repair.start()));
  app.route('GET', '/api/environment/capabilities', api((context) => listHostCapabilities(context.host)));
  return preflight;
}
