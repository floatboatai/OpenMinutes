// ABOUTME: 通过真实跨端契约验证响应边界，测试不访问正式数据库。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppInfo } from '../src/contracts/app.ts';

test('应用信息需要明确名称和版本', () => {
  assert.equal(isAppInfo({ name: 'App', version: '0.1.0' }), true);
  assert.equal(isAppInfo({ name: 123, version: '0.1.0' }), false);
  assert.equal(isAppInfo(null), false);
});
