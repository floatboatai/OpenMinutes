// ABOUTME: 通过真实跨端契约验证响应边界，测试不访问正式数据库。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asObject, BadInput, reqString } from '../src/contracts/input.ts';

test('请求体必须是对象', () => {
  const body = { values: { import_dir: '/recordings' } };
  assert.equal(asObject(body), body);
  for (const invalid of [null, undefined, [], 'text', 1]) {
    assert.throws(() => asObject(invalid), BadInput);
  }
});

test('必填字符串会去除首尾空格并检查长度', () => {
  assert.equal(reqString({ name: ' MemoTalk ' }, 'name', 8), 'MemoTalk');
  assert.throws(() => reqString({ name: 'too long' }, 'name', 3), BadInput);
});

test('必填字符串拒绝缺失、空值和非字符串', () => {
  for (const value of [undefined, null, '', '  ', 123, true, {}]) {
    assert.throws(() => reqString({ name: value }, 'name'), BadInput);
  }
});
