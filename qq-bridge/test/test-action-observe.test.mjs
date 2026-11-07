// test-action-observe.test.mjs · 宪章 §5.8：动作-观察原子化 + 判据集 + 空转熔断。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCriteria, judgeCriteriaSet, runAtomicStep, detectStuck,
} from '../src/domain/leaves/action-observe.mjs';
import { checkVerifySet } from '../src/domain/leaves/inori-skill-verify.js';

const judges = {
  captureScreen: async () => ({ hash: 'h' }),
  visionJudge: async () => ({ met: true, evidence: '看到了' }),
  readState: async () => 36,
};

test('判据集：多条聚合；任何一条 unknown 都不能算 met；有 failed 即 not_met', async () => {
  assert.equal(normalizeCriteria(['画面: 结算', '状态: 理智=36', '随便写']).length, 3);
  const met = await judgeCriteriaSet(['画面: 结算', '状态: 理智=36'], judges);
  assert.equal(met.result, 'met');
  assert.equal(met.metCount, 2);
  assert.equal(met.unknownCount, 0);

  const unknown = await judgeCriteriaSet(['画面: 结算', '随便写'], judges);
  assert.equal(unknown.result, 'unknown', '文字判据不能当通过');
  assert.equal(unknown.unknownCount, 1);

  const failed = await judgeCriteriaSet(['状态: 理智=35', '画面: 结算'], judges);
  assert.equal(failed.result, 'not_met');
  assert.equal(failed.failedCount, 1);

  assert.equal((await judgeCriteriaSet([], judges)).result, 'unknown');
});

test('原子一步：缺观察就 invalid；动作/观察抛错 failed；都给出才 met', async () => {
  const invalid = await runAtomicStep({ action: async () => {}, criteria: ['画面: 结算'], judges });
  assert.equal(invalid.result, 'invalid');
  assert.match(invalid.reason, /盲操作/);

  const boom = await runAtomicStep({
    action: async () => { throw new Error('tap failed'); },
    observe: async () => ({ hash: 'x' }),
    criteria: ['画面: 结算'], judges,
  });
  assert.equal(boom.result, 'failed');
  assert.match(boom.reason, /tap failed/);

  let observed = false;
  const ok = await runAtomicStep({
    action: async () => { observed = true; },
    observe: async () => ({ hash: 'h', ui: 'result' }),
    criteria: ['画面: 结算', '状态: 理智=36'],
    judges,
    meta: { step: 'tap_confirm' },
  });
  assert.equal(observed, true);
  assert.equal(ok.result, 'met');
  assert.deepEqual(ok.observation, { hash: 'h', ui: 'result' });
  assert.equal(ok.meta.step, 'tap_confirm');
});

test('空转：同一签名连续 3 次未 met → stuck；有一次 met 就不算；窗口外不算', () => {
  const now = 1_000_000;
  const mk = (sig, result, at) => ({ signature: sig, result, at });
  const stuck = detectStuck({ attempts: [mk('tap:540,900', 'not_met', now - 3000), mk('tap:540,900', 'unknown', now - 2000), mk('tap:540,900', 'not_met', now - 1000)], now, maxAttempts: 3 });
  assert.equal(stuck.stuck, true);
  assert.equal(stuck.count, 3);

  const healed = detectStuck({ attempts: [mk('tap:540,900', 'not_met', now - 3000), mk('tap:540,900', 'met', now - 2000), mk('tap:540,900', 'not_met', now - 1000)], now, maxAttempts: 3 });
  assert.equal(healed.stuck, false, '成功过就不算空转');

  const other = detectStuck({ attempts: [mk('a', 'not_met', now - 3000), mk('b', 'not_met', now - 2000), mk('c', 'not_met', now - 1000)], now, maxAttempts: 3 });
  assert.equal(other.stuck, false, '不同动作不合并');

  const old = detectStuck({ attempts: [mk('x', 'not_met', now - 9999999), mk('x', 'not_met', now - 9999998), mk('x', 'not_met', now - 9999997)], now, windowMs: 1000, maxAttempts: 3 });
  assert.equal(old.stuck, false, '窗口外不追溯');
  assert.equal(detectStuck({ attempts: [] }).stuck, false);
});

test('接线：skill-verify 暴露多判据聚合', async () => {
  const set = await checkVerifySet(['画面: 结算', '状态: 理智=36'], judges);
  assert.equal(set.result, 'met');
  const unknown = await checkVerifySet(['画面: 结算'], {});
  assert.equal(unknown.result, 'unknown', '没有裁判不能判 met');
});
