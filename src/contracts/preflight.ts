export interface PreflightItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  reason: string;
  autoRepair: boolean;
  action: string;
}

export interface PreflightReport {
  checkedAt: string;
  platform: string;
  arch: string;
  items: PreflightItem[];
}

export type RepairState =
  | { status: 'idle' }
  | { status: 'starting' | 'running'; idempotencyKey: string; runId: string | null; text: string }
  | { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; idempotencyKey: string; runId: string | null; text: string };

export interface EnvironmentState {
  report: PreflightReport;
  repair: RepairState;
}
