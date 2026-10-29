import path from 'node:path';
import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import { api } from '../http';
import { appPreflight } from '../preflight';
import { createEnvironmentRepair } from '../environment-repair';

export function registerEnvironmentRoutes(app: WorkbenchServer) {
  const preflight = appPreflight(app);
  const repair = createEnvironmentRepair({
    host: app.host,
    report: async (refresh) => (await preflight.get(refresh)).report,
    workingDirectory: path.resolve(process.cwd()),
  });
  app.route('GET', '/api/environment', api(async () => ({
    report: (await preflight.get()).report,
    repair: repair.get(),
  })));
  app.route('POST', '/api/environment/repair', api(() => repair.start()));
  app.route('POST', '/api/device/check', api(async () => (await preflight.get(true)).report));
  return preflight;
}
