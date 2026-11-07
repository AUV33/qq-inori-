import test from 'node:test';
import assert from 'node:assert/strict';

import { decideQualityPolicy } from '../src/domain/mind/quality-policy.mjs';

test('无样本：unknown、中性调节', () => {
  const p = decideQualityPolicy({ noData: true });
  assert.equal(p.level, 'unknown');
  assert.equal(p.initiativeScale, 1);
  assert.equal(p.gateThresholdDelta, 0);
});

test('漏接率高：caution，但不调门阈值（先排查）', () => {
  const p = decideQualityPolicy({ missedRate: 0.5, caughtRate: 0.5, samples: 20 });
  assert.equal(p.level, 'caution');
  assert.equal(p.gateThresholdDelta, 0);
  assert.ok(p.initiativeScale <= 0.9);
  assert.ok(p.reasons.some((x) => /漏接率/.test(x)));
});

test('被接住率低：caution + 主动性下调', () => {
  const p = decideQualityPolicy({ missedRate: 0.1, caughtRate: 0.1, samples: 20 });
  assert.equal(p.level, 'caution');
  assert.equal(p.initiativeScale, 0.7);
});

test('偏弱：watch；正常：normal', () => {
  assert.equal(decideQualityPolicy({ missedRate: 0.2, caughtRate: 0.5, samples: 20 }).level, 'watch');
  assert.equal(decideQualityPolicy({ missedRate: 0.05, caughtRate: 0.6, samples: 20 }).level, 'normal');
});

test('确定性：同输入同结果；边界有界', () => {
  const m = { missedRate: 0.5, caughtRate: 0.05, samples: 20 };
  assert.deepEqual(decideQualityPolicy(m), decideQualityPolicy(m));
  for (const p of [decideQualityPolicy({}), decideQualityPolicy(m)]) {
    assert.ok(p.initiativeScale >= 0 && p.initiativeScale <= 1);
    assert.ok(Number.isFinite(p.gateThresholdDelta));
  }
});
