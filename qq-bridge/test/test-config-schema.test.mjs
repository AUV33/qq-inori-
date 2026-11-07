import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSocialV2Config } from '../src/domain/shared/config-schema.js';

test('合法的 socialV2 通过', () => {
  const r = validateSocialV2Config({ enabled: true, tools: { sendMessage: true }, wait: { defaultQuietMs: 8000 } });
  assert.equal(r.ok, true, r.errors.join(';'));
});

test('子段类型错误被报出来，但不抛异常', () => {
  const r = validateSocialV2Config({ enabled: 'false', wait: '8000', tools: { sendMessage: 1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('enabled')));
  assert.ok(r.errors.some((e) => e.includes('wait')));
  assert.ok(r.errors.some((e) => e.includes('tools.sendMessage')));
});

test('socialV2 非对象被报出来', () => {
  assert.equal(validateSocialV2Config(null).ok, false);
  assert.equal(validateSocialV2Config([]).ok, false);
});
