// ABOUTME: 设备 SDK（memotalk-sdk）异常类型 → 中文 AppError；英文原文只放进 detail。

import { AppError } from '../../contracts/errors';

export interface DeviceErrorContext {
  op: string;
  exitCode?: number | null;
  stderrTail?: string;
}

const BLUETOOTH_PATTERN = /bluetooth|radio|powered|not available|adapter|not ready/i;

export function deviceErrorCode(kind: string, message: string, op: string): string {
  switch (kind) {
    case 'DeviceNotFound':
    case 'BleakDeviceNotFoundError':
      return 'DEVICE_NOT_FOUND';
    case 'ConnectionLost':
    case 'TransportError':
      return 'DEVICE_DISCONNECTED';
    case 'MemoTalkTimeout':
    case 'TimeoutError':
      return 'DEVICE_TIMEOUT';
    case 'RecordingRejected':
    case 'OperationForbidden':
      return 'DEVICE_RECORDING';
    case 'FileNotFoundOnDevice':
      return 'FILE_NOT_ON_DEVICE';
    case 'DeleteFailed':
      return 'DELETE_FAILED';
    case 'ProtocolError':
    case 'CrcError':
      return op === 'pull' ? 'TRANSFER_FAILED' : 'DEVICE_ERROR';
    case 'ModuleNotFoundError':
    case 'ImportError':
      return 'RUNTIME_MISSING';
    case 'DeviceRejected':
    case 'DeviceErrorResponse':
    case 'InvalidParameter':
      return 'DEVICE_ERROR';
    default:
      if (kind.startsWith('Bleak') && BLUETOOTH_PATTERN.test(message)) return 'BLUETOOTH_UNAVAILABLE';
      if (kind === 'BleakError') return op === 'pull' ? 'TRANSFER_FAILED' : 'DEVICE_ERROR';
      return op === 'pull' ? 'TRANSFER_FAILED' : 'DEVICE_ERROR';
  }
}

export function deviceErrorDetail(kind: string, message: string, context: DeviceErrorContext): string {
  const lines = [`${kind}: ${message}`, `[op=${context.op} exit=${context.exitCode ?? '-'}]`];
  if (context.stderrTail?.trim()) lines.push(context.stderrTail.trim().slice(-2000));
  return lines.join('\n');
}

/** 把 Python 端报回的异常类型和原文映射为面向用户的错误。 */
export function classifyDeviceError(kind: string, message: string, context: DeviceErrorContext | string): AppError {
  const ctx = typeof context === 'string' ? { op: context } : context;
  return new AppError(deviceErrorCode(kind, message, ctx.op), undefined, deviceErrorDetail(kind, message, ctx));
}
