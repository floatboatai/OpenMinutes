// ABOUTME: 页面与服务端共用的错误模型：一句中文结论 + 可选技术详情 + 可选跳转动作。

export interface ErrorAction {
  label: string;
  href: string;
}

export interface AppErrorView {
  code: string;
  message: string;
  detail?: string;
  action?: ErrorAction;
}

export const DIAGNOSTICS_ACTION: ErrorAction = { label: '去诊断与修复', href: '#/settings/diagnostics' };

/** code → 默认中文文案；抛错处没有给 message 时使用。 */
export const ERROR_COPY: Record<string, { message: string; action?: ErrorAction }> = {
  DEVICE_NOT_FOUND: { message: '没有找到录音笔。请按一下录音笔按键唤醒，放在电脑旁边后重试。' },
  DEVICE_DISCONNECTED: { message: '和录音笔的连接断开了，可能已休眠或离开范围。' },
  DEVICE_TIMEOUT: { message: '录音笔没有及时响应，请稍后重试。' },
  DEVICE_BUSY: { message: '录音笔正在同步或用于实时字幕，请等它结束后再试。' },
  DEVICE_RECORDING: { message: '录音笔正在录音，停止录音后再同步。' },
  BLUETOOTH_UNAVAILABLE: { message: '电脑的蓝牙不可用，请打开蓝牙后重试。' },
  RUNTIME_MISSING: { message: '录音笔组件还没准备好。', action: DIAGNOSTICS_ACTION },
  FILE_NOT_ON_DEVICE: { message: '录音笔里已经没有这条录音。' },
  TRANSFER_FAILED: { message: '同步中断了，已同步的录音不受影响，可以重试。' },
  DELETE_FAILED: { message: '有录音没能从录音笔删除，可以稍后重试。' },
  DEVICE_ERROR: { message: '录音笔操作没有完成，请重试。' },
  WIFI_FALLBACK: { message: '无线快传不可用，已改用蓝牙（较慢）。' },
  NETWORK_PAUSED: { message: '录音笔正在无线快传，电脑暂时断开了外网，完成后再试。' },
  ASR_START_FAILED: { message: '语音识别暂时不可用，请确认已在 Floatboat 登录并开启语音识别。' },
  ASR_UNSTABLE: { message: '识别服务连接不稳定，进度已保存，可以稍后重试。' },
  ASR_EMPTY: { message: '没有识别到可用的语音内容，请确认录音里有人声。' },
  DECODE_FAILED: { message: '音频文件无法读取，可能已损坏。' },
  LLM_UNAVAILABLE: { message: 'AI 整理暂不可用，请在 Floatboat 中登录并选择模型。' },
  LLM_INCOMPLETE: { message: 'AI 整理没有完成，请重试。' },
  NO_PERMISSION: { message: '没有这个文件夹的读写权限，请在设置里换一个文件夹。', action: { label: '去设置', href: '#/settings' } },
  DISK_FULL: { message: '磁盘空间不足。' },
  FILE_MOVED: { message: '文件已被移走或删除。' },
  INTERNAL_ERROR: { message: '操作没有完成，请重试。' },
  HTTP_ERROR: { message: '应用服务暂时没有响应，请稍后重试。' },
  BAD_RESPONSE: { message: '应用服务返回了异常数据，请刷新页面。' },
};

export class AppError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly action?: ErrorAction;
  readonly retryable: boolean;

  constructor(code: string, message?: string, detail?: string, action?: ErrorAction, retryable = true) {
    super(message ?? ERROR_COPY[code]?.message ?? ERROR_COPY.INTERNAL_ERROR.message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
    this.action = action ?? ERROR_COPY[code]?.action;
    this.retryable = retryable;
  }

  toView(): AppErrorView {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.action ? { action: this.action } : {}),
    };
  }
}

export function errorView(code: string, detail?: string, message?: string): AppErrorView {
  return new AppError(code, message, detail).toView();
}
