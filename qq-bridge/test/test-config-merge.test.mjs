import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSocialV2Defaults } from '../src/domain/shared/config-merge.js';

const defaults = {
  enabled: true,
  wake: { maxWakePerMinute: 1, maxWakePerHour: 12 },
  wait: { defaultQuietMs: 8000, replyDebounceMs: 2000 },
  tools: { sendMessage: true, groupAdmin: false },
  array: [1, 2],
};

test('只覆盖用户写的子键，保留同对象其他默认值', () => {
  const out = mergeSocialV2Defaults(defaults, { wait: { defaultQuietMs: 15000 } });
  assert.equal(out.wait.defaultQuietMs, 15000);
  assert.equal(out.wait.replyDebounceMs, 2000, '同对象未写的键必须保留');
  assert.equal(out.wake.maxWakePerMinute, 1);
});

test('数组和标量按用户值覆盖', () => {
  const out = mergeSocialV2Defaults(defaults, { enabled: false, array: [9] });
  assert.equal(out.enabled, false);
  assert.deepEqual(out.array, [9]);
});

test('undefined 不覆盖默认值', () => {
  const out = mergeSocialV2Defaults(defaults, { wait: { replyDebounceMs: undefined } });
  assert.equal(out.wait.replyDebounceMs, 2000);
});

test('非对象 incoming 不会炸', () => {
  assert.equal(mergeSocialV2Defaults(defaults, null).wait.replyDebounceMs, 2000);
  assert.equal(mergeSocialV2Defaults(defaults, 'x').wait.replyDebounceMs, 2000);
});
