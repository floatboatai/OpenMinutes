// ABOUTME: 诊断路由：唯一的技术细节出口——环境、最近设备操作、传输方式、协议指令参考与宿主能力。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { SdkCommand } from '../../contracts/app';
import type { DiagnosticsView } from '../../contracts/device';
import { api } from '../http';
import type { appPreflight } from '../preflight';
import { listHostCapabilities } from '../preflight';
import { numOr, rows, strOr } from '../sql';
import type { DeviceService } from '../device/service';
import { probeWifiCapable, WIFI_MIN_BATCH_BYTES } from '../device/transport';

export function readCommands(app: WorkbenchServer): SdkCommand[] {
  return rows(app.database, 'SELECT * FROM sdk_commands ORDER BY sort_order').map((item) => ({
    cmdCode: strOr(item.cmd_code, ''),
    name: strOr(item.name, ''),
    direction: strOr(item.direction, 'read') as SdkCommand['direction'],
    channel: strOr(item.channel, 'FFF1'),
    requestHex: strOr(item.request_hex, ''),
    responseRule: strOr(item.response_rule, ''),
    caution: numOr(item.caution, 0) === 1,
  }));
}

export function registerDiagnosticsRoutes(app: WorkbenchServer, service: DeviceService, preflight: ReturnType<typeof appPreflight>): void {
  app.route(
    'GET',
    '/api/diagnostics',
    api(async (context): Promise<DiagnosticsView> => ({
      environment: (await preflight.get()).report,
      deviceLog: service.logSnapshot().reverse(),
      transport: {
        setting: service.transportSetting(),
        wifiCapable: await probeWifiCapable(),
        platform: process.platform,
        thresholdBytes: WIFI_MIN_BATCH_BYTES,
        measured: service.measuredSpeeds(),
      },
      commands: readCommands(app),
      capabilities: await listHostCapabilities(context.host),
    })),
  );
}
