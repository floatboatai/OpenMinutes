import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import { api } from '../http';
import { appPreflight } from '../preflight';
import { createEnvironmentRepair } from '../environment-repair';
import { toolContext } from '../tools';

export function registerEnvironmentRoutes(app: WorkbenchServer) {
  const preflight = appPreflight(app);
  const repair = createEnvironmentRepair({
    host: app.host,
    report: async (refresh) => (await preflight.get(refresh)).report,
    workingDirectory: toolContext().cwd,
  });
  app.route('GET', '/api/environment', api(async () => ({
    report: (await preflight.get()).report,
    repair: repair.get(),
  })));
  app.route('POST', '/api/environment/repair', api(() => repair.start()));
  app.route('POST', '/api/device/check', api(async () => (await preflight.get(true)).report));
  return preflight;
}
