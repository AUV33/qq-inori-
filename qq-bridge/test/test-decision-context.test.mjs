import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISION_CONTEXT_VERSION, PRODUCER_NAMES, buildDecisionContext, contextSummary,
  contextEventRow, contextFingerprint,
} from '../src/domain/mind/decision-context.mjs';

test('全部生产者：present 完整、字段可用、深度冻结', () => {
  const producers = {};
  for (const name of PRODUCER_NAMES) producers[name] = () => ({ name, value: 1 });
  const ctx = buildDecisionContext({ key: 'group:1', at: 1000, producers });
  assert.equal(ctx.v, DECISION_CONTEXT_VERSION);
  assert.equal(ctx.scene, 'group');
  assert.equal(ctx.coverage.present.length, PRODUCER_NAMES.length);
  assert.equal(ctx.coverage.missing.length, 0);
  assert.equal(ctx.self.name, 'self');
  assert.ok(Object.isFrozen(ctx));
  assert.ok(Object.isFrozen(ctx.coverage));
  assert.throws(() => { ctx.foo = 1; });
});

test('缺失与抛错：missing/degraded 可见，其余继续', () => {
  const ctx = buildDecisionContext({
    key: 'private:2', at: 1,
    producers: {
      self: () => ({ energy: 0.4 }),
      belief: () => { throw new Error('belief boom'); },
    },
  });
  assert.equal(ctx.scene, 'private');
  assert.deepEqual(ctx.coverage.present, ['self']);
  assert.ok(ctx.coverage.missing.includes('memory'));
  assert.equal(ctx.coverage.degraded.length, 1);
  assert.equal(ctx.coverage.degraded[0].name, 'belief');
  assert.match(ctx.coverage.degraded[0].error, /boom/);
  assert.equal(ctx.belief, null);
});

test('确定性：同一输入指纹一致；key 推断 scene', () => {
  const build = () => buildDecisionContext({ key: 'group:9', at: 42, producers: { self: () => ({ energy: 0.5 }) } });
  assert.equal(contextFingerprint(build()), contextFingerprint(build()));
  assert.equal(buildDecisionContext({ key: 'private:9' }).scene, 'private');
});

test('contextSummary：包含场景/关键状态/覆盖度', () => {
  const ctx = buildDecisionContext({ key: 'group:1', at: 1, producers: { self: () => ({ energy: 0.25, socialHunger: 0.8 }) } });
  const line = contextSummary(ctx);
  assert.match(line, /group:1/);
  assert.match(line, /energy=0\.25/);
  assert.match(line, /producers=1\/10/);
});

test('contextEventRow：只带最小字段，不复制全量状态', () => {
  const ctx = buildDecisionContext({ key: 'group:1', at: 1, producers: { self: () => ({ energy: 0.25, secret: 'x' }) } });
  const row = contextEventRow(ctx);
  assert.equal(row.type, 'decision.context');
  assert.equal(row.key, 'group:1');
  assert.equal(row.payload.self.energy, 0.25);
  assert.equal(row.payload.self.secret, undefined);
  assert.ok(row.payload.coverage);
});
