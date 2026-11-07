// quant strategies 注册表金标：名字固定在表里、未知策略要报可用清单、参数原样透传。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, STRATEGY_NAMES, createStrategy } from '../src/quant/strategies/index.js';

test('注册表冻结且名单稳定', () => {
  assert.deepEqual(STRATEGY_NAMES, ['sma-cross', 'breakout']);
  assert.equal(Object.isFrozen(STRATEGIES), true);
});

test('createStrategy：按名字造出带 name/onBar 的策略', () => {
  const s = createStrategy('sma-cross', { fast: 5, slow: 20 });
  assert.equal(s.name, 'sma-cross(5,20)');
  assert.equal(typeof s.onBar, 'function');
  const b = createStrategy('breakout');
  assert.equal(b.name, 'breakout(20)');
  assert.equal(typeof b.onBar, 'function');
});

test('createStrategy：未知策略报错并列出可用清单', () => {
  assert.throws(() => createStrategy('nope'), /未知策略: nope（可用：sma-cross, breakout）/);
  assert.throws(() => createStrategy(undefined), /未知策略/);
});

test('createStrategy：参数原样透传（策略自己负责夹取）', () => {
  assert.equal(createStrategy('sma-cross', {}).name, 'sma-cross(10,30)');
  assert.equal(createStrategy('breakout', { lookback: 7 }).name, 'breakout(7)');
});
