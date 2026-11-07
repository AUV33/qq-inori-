// quant strategies 金标：双均线（趋势过滤）与唐奇安突破的入场/出场语义、预热与参数边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smaCrossStrategy } from '../src/quant/strategies/sma-cross.js';
import { breakoutStrategy } from '../src/quant/strategies/breakout.js';

const bar = (close, high = close, low = close) => ({ close, high, low });
const flat = (n, price) => Array.from({ length: n }, () => bar(price));
const account = (qty = 0) => ({ positions: { BTC: { qty } } });

test('sma-cross：预热期不出信号', () => {
  const s = smaCrossStrategy({ fast: 2, slow: 4 });
  assert.equal(s.onBar({ bars: flat(4, 100), i: 3, account: account(), symbol: 'BTC' }), null);
});

test('sma-cross：快线上穿慢线买入，跌破卖出，且不会重复买', () => {
  const s = smaCrossStrategy({ fast: 2, slow: 4 });
  // 下跌后拉升：快线会站到慢线上方
  const bars = [bar(10), bar(9), bar(8), bar(7), bar(9), bar(11)];
  const i = bars.length - 1;
  const buy = s.onBar({ bars, i, account: account(0), symbol: 'BTC' });
  assert.deepEqual(buy, { action: 'buy', fraction: 1 });
  assert.equal(s.onBar({ bars, i, account: account(1), symbol: 'BTC' }), null, '已经持有就不再买');

  const down = [bar(10), bar(11), bar(12), bar(13), bar(11), bar(9)];
  const sell = s.onBar({ bars: down, i: down.length - 1, account: account(1), symbol: 'BTC' });
  assert.deepEqual(sell, { action: 'sell', fraction: 1 });
  assert.equal(s.onBar({ bars: down, i: down.length - 1, account: account(0), symbol: 'BTC' }), null, '空仓不卖');
});

test('sma-cross：参数被夹到合法范围，名字反映实际参数', () => {
  const tiny = smaCrossStrategy({ fast: 1, slow: 1 });
  assert.equal(tiny.name, 'sma-cross(2,3)', 'fast≥2、slow>fast');
  const weird = smaCrossStrategy({ fast: 'abc', slow: -5 });
  // fast 非数字 → 回落 10；slow 负数会被夹到 fast+1（不是回落 30，只有非数字才回落）
  assert.equal(weird.name, 'sma-cross(10,11)');
  assert.equal(smaCrossStrategy({ fast: 'abc', slow: 'abc' }).name, 'sma-cross(10,30)', '两个都非数字才回落默认');
});

test('breakout：突破前 lookback 根最高价买入，跌破最低价卖出', () => {
  const s = breakoutStrategy({ lookback: 5 });
  const bars = [...Array.from({ length: 6 }, (_, k) => bar(100 + k, 105 + k, 95 + k)), bar(200, 200, 200)];
  const buy = s.onBar({ bars, i: bars.length - 1, account: account(0), symbol: 'BTC' });
  assert.deepEqual(buy, { action: 'buy', fraction: 1 });

  const down = [...Array.from({ length: 6 }, (_, k) => bar(100 + k, 105 + k, 95 + k)), bar(50, 50, 50)];
  const sell = s.onBar({ bars: down, i: down.length - 1, account: account(1), symbol: 'BTC' });
  assert.deepEqual(sell, { action: 'sell', fraction: 1 });
});

test('breakout：区间内不动手；lookback 边界（i<=n 不判）', () => {
  const s = breakoutStrategy({ lookback: 5 });
  const bars = [...Array.from({ length: 6 }, () => bar(100, 105, 95)), bar(101, 101, 101)];
  assert.equal(s.onBar({ bars, i: bars.length - 1, account: account(0), symbol: 'BTC' }), null, '没突破就不动');
  assert.equal(s.onBar({ bars, i: 5, account: account(0), symbol: 'BTC' }), null, 'i<=lookback 处于预热');
});

test('breakout：lookback 最小 5，非法值回落 20', () => {
  assert.equal(breakoutStrategy({ lookback: 1 }).name, 'breakout(5)');
  assert.equal(breakoutStrategy({ lookback: 'x' }).name, 'breakout(20)');
  assert.equal(breakoutStrategy().name, 'breakout(20)');
});
