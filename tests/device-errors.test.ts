import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ERROR_COPY } from '../src/contracts/errors.ts';
import { classifyDeviceError } from '../src/server/device/errors.ts';

const cases: Array<[kind: string, message: string, op: string, code: string]> = [
  ['DeviceNotFound', 'no MemoTalk S1 advertising nearby', 'connect', 'DEVICE_NOT_FOUND'],
  ['BleakDeviceNotFoundError', 'Device with address AA:BB was not found', 'connect', 'DEVICE_NOT_FOUND'],
  ['ConnectionLost', 'peer disconnected', 'status', 'DEVICE_DISCONNECTED'],
  ['TransportError', 'write failed', 'list', 'DEVICE_DISCONNECTED'],
  ['MemoTalkTimeout', 'no response to 0x84 within 5s', 'status', 'DEVICE_TIMEOUT'],
  ['RecordingRejected', 'device is recording', 'pull', 'DEVICE_RECORDING'],
  ['OperationForbidden', 'busy recording', 'delete', 'DEVICE_RECORDING'],
  ['FileNotFoundOnDevice', 'REC001.mp3', 'pull', 'FILE_NOT_ON_DEVICE'],
  ['DeleteFailed', 'REC001.mp3 status=0x02', 'delete', 'DELETE_FAILED'],
  ['ProtocolError', 'unexpected frame', 'pull', 'TRANSFER_FAILED'],
  ['ProtocolError', 'unexpected frame', 'status', 'DEVICE_ERROR'],
  ['CrcError', 'crc mismatch', 'pull', 'TRANSFER_FAILED'],
  ['CrcError', 'crc mismatch', 'list', 'DEVICE_ERROR'],
  ['BleakError', 'Bluetooth device is turned off', 'connect', 'BLUETOOTH_UNAVAILABLE'],
  ['BleakError', 'No Bluetooth adapter found', 'connect', 'BLUETOOTH_UNAVAILABLE'],
  ['BleakError', 'Bluetooth radio not powered', 'pull', 'BLUETOOTH_UNAVAILABLE'],
  ['BleakError', 'GATT write failed', 'pull', 'TRANSFER_FAILED'],
  ['BleakError', 'GATT write failed', 'status', 'DEVICE_ERROR'],
  ['ModuleNotFoundError', "No module named 'memotalk'", 'connect', 'RUNTIME_MISSING'],
  ['ImportError', 'cannot import name MemoTalkClient', 'connect', 'RUNTIME_MISSING'],
  ['DeviceRejected', 'hotspot enable rejected', 'status', 'DEVICE_ERROR'],
  ['DeviceErrorResponse', 'error 0x05', 'list', 'DEVICE_ERROR'],
  ['InvalidParameter', 'bad name', 'delete', 'DEVICE_ERROR'],
  ['RuntimeError', 'boom', 'pull', 'TRANSFER_FAILED'],
  ['RuntimeError', 'boom', 'connect', 'DEVICE_ERROR'],
];

test('every device SDK exception kind maps to a Chinese headline with the original text in detail', () => {
  for (const [kind, message, op, code] of cases) {
    const error = classifyDeviceError(kind, message, op);
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code, `${kind} (${op})`);
    assert.equal(error.message, ERROR_COPY[code].message, `${kind} headline`);
    // The headline never leaks English exception names or the raw message.
    assert.doesNotMatch(error.message, /[A-Za-z]{4,}Error|DeviceNotFound|ConnectionLost|Bleak|0x/, `${kind} headline`);
    assert.ok(error.detail?.startsWith(`${kind}: ${message}`), `${kind} detail`);
    assert.match(error.detail ?? '', new RegExp(`\\[op=${op} exit=-\\]`));
  }
});

test('detail carries the exit code and stderr tail; runtime errors point to diagnostics', () => {
  const error = classifyDeviceError('ModuleNotFoundError', "No module named 'bleak'", {
    op: 'connect', exitCode: 1, stderrTail: 'Traceback (most recent call last):\n  ...\n',
  });
  assert.equal(error.code, 'RUNTIME_MISSING');
  assert.match(error.detail ?? '', /\[op=connect exit=1\]/);
  assert.match(error.detail ?? '', /Traceback/);
  assert.deepEqual(error.action, { label: '去诊断与修复', href: '#/settings/diagnostics' });
  assert.equal(error.toView().code, 'RUNTIME_MISSING');
  assert.equal(classifyDeviceError('DeviceNotFound', 'x', 'connect').action, undefined);
});
