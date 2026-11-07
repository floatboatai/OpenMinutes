export type PreflightGroup = 'device' | 'audio' | 'ai' | 'storage';

export interface PreflightItem {
  id: string;
  label: string;
  /** 展示分组：录音笔组件 / 音频处理 / 语音识别与 AI 整理 / 存储目录。 */
  group: PreflightGroup;
  status: 'ok' | 'warn' | 'fail';
  /** 一句中文结论。 */
  reason: string;
  /** 技术原文（探测输出、uv 命令、平台说明），只在「查看详情」里显示。 */
  detail?: string;
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
  | { status: 'starting' | 'running' | 'recovering' | 'unknown'; idempotencyKey: string; runId: string | null; text: string }
  | { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; idempotencyKey: string; runId: string | null; text: string };

export interface EnvironmentState {
  report: PreflightReport;
  repair: RepairState;
}
