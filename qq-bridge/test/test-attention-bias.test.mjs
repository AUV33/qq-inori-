import test from 'node:test';
import assert from 'node:assert/strict';

import { computeAttentionBias, MAX_BIAS } from '../src/domain/mind/attention-bias.mjs';

test('无数据：bias 0、无理由', () => {
  assert.deepEqual(computeAttentionBias({}), { bias: 0, reasons: [] });
  assert.deepEqual(computeAttentionBias({ self: null, belief: null }), { bias: 0, reasons: [] });
});

test('疲惫/压力：阈值上调（更保守）；有理由', () => {
  const r = computeAttentionBias({ self: { energy: 0.2, stress: 0.8 } });
  assert.ok(r.bias > 0);
  assert.ok(r.bias <= MAX_BIAS);
  assert.ok(r.reasons.some((x) => /精力低/.test(x)));
  assert.ok(r.reasons.some((x) => /压力高/.test(x)));
});

test('社交饥饿/关系近/未解之事：阈值下调（更愿意接）', () => {
  const r = computeAttentionBias({
    self: { socialHunger: 0.9 },
    belief: { affinity: 0.8, trust: 0.7, openLoops: [{ status: 'open', topic: '面试' }] },
  });
  assert.ok(r.bias < 0);
  assert.ok(r.reasons.some((x) => /想找人说话/.test(x)));
  assert.ok(r.reasons.some((x) => /关系近/.test(x)));
  assert.ok(r.reasons.some((x) => /未解/.test(x)));
});

test('偏置永远夹在 ±MAX_BIAS 内，绝不主导判定', () => {
  const hot = computeAttentionBias({ self: { energy: 0, stress: 1, socialHunger: 1 }, belief: { affinity: 1, trust: 0, openLoops: [{ status: 'open' }] } });
  assert.ok(hot.bias >= -MAX_BIAS && hot.bias <= MAX_BIAS);
  assert.ok(Math.abs(hot.bias) <= 0.04);
});

test('脏字段不炸、按缺失处理', () => {
  const r = computeAttentionBias({ self: { energy: 'x', stress: null }, belief: { affinity: NaN, openLoops: 'x' } });
  assert.equal(r.bias, 0);
});

test('群接纳度高：阈值下调（更关注这个群）', () => {
  const r = computeAttentionBias({ belief: { acceptance: 0.8 } });
  assert.ok(r.bias < 0);
  assert.ok(r.reasons.some((x) => /接纳/.test(x)));
  const low = computeAttentionBias({ belief: { acceptance: 0.2 } });
  assert.equal(low.bias, 0, '接纳度低不加戏（仍由内容判定）');
});
