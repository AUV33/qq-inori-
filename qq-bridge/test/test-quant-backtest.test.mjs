// quant/backtest 金标：逐 bar 回测——和模拟盘同一套 executeOrder/checkRisk，只做收盘价成交。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../src/quant/backtest.js';

const cfg = {
  initialCapitalCny: 710, cnyPerUsdt: 7.1, quote: 'USDT',
  feeRate: 0.001, slippageBps: 5, minNotionalUsdt: 5,
  risk: { maxPositionPct: 0.5, maxDailyLossPct: 0.9, maxTradesPerDay: 100, maxOpenPositions: 2 },
};
const bar = (i, close, openTime) => ({ openTime: openTime + i * 60000, closeTime: openTime + (i + 1) * 60000, close, high: close, low: close });
const bars = (closes, t0 = 1_800_000_000_000) => closes.map((c, i) => bar(i, c, t0));

test('参数校验：K 线少于 2 根 / 策略缺 onBar 直接报错', () => {
  assert.throws(() => runBacktest({ bars: [bar(0, 10, 1)], strategy: { onBar() {} }, cfg }), /至少需要 2 根/);
  assert.throws(() => runBacktest({ bars: bars([1, 2]), strategy: {}, cfg }), /缺少 onBar/);
});

test('不交易策略：净值不变、无成交、benchmark 反映买入持有', () => {
  const r = runBacktest({
    bars: bars([10, 20]),
    strategy: { name: 'hold', onBar: () => null },
    cfg, symbol: 'test',
  });
  assert.equal(r.symbol, 'TEST');
  assert.equal(r.strategy, 'hold');
  assert.equal(r.trades, 0);
  assert.equal(r.finalEquity, r.initialEquity);
  assert.equal(r.totalReturnPct, 0);
  assert.equal(r.benchmarkReturnPct, 100, '10→20 是 +100%');
  assert.equal(r.curve.length, 2);
});

test('买卖一轮：按收盘价成交、计入手续费与滑点，统计买卖笔数与胜率', () => {
  const signals = ['buy', null, 'sell', null];
  const r = runBacktest({
    bars: bars([10, 11, 20, 20]),
    strategy: {
      name: 'one-round',
      onBar: ({ i }) => (signals[i] ? { action: signals[i], fraction: 1 } : null),
    },
    cfg,
  });
  assert.equal(r.buys, 1);
  assert.equal(r.sells, 1);
  assert.equal(r.winRatePct, 100, '20 卖出比买入价高，算赢');
  assert.ok(r.feesPaid > 0);
  assert.ok(r.finalEquity > r.initialEquity);
  assert.equal(r.tradeLog.length, 2);
});

test('仓位上限：单仓不超过净值的 maxPositionPct（回测与实盘同一套风控）', () => {
  const r = runBacktest({
    bars: bars([10, 10, 10]),
    strategy: { onBar: ({ i }) => (i === 0 ? { action: 'buy', fraction: 1 } : null) },
    cfg,
  });
  const buy = r.tradeLog.find((t) => t.side === 'buy');
  assert.ok(buy.notional <= r.initialEquity * 0.5 + 1e-6, `名义额 ${buy.notional} 超出单仓上限`);
});

test('signal.notional 可显式指定，但仍受上限与最小名义约束', () => {
  const r = runBacktest({
    bars: bars([10, 10, 10]),
    strategy: { onBar: ({ i }) => (i === 0 ? { action: 'buy', notional: 1000 } : null) },
    cfg,
  });
  const buy = r.tradeLog.find((t) => t.side === 'buy');
  assert.ok(buy.notional <= r.initialEquity * 0.5 + 1e-6);

  const tiny = runBacktest({
    bars: bars([10, 10, 10]),
    strategy: { onBar: ({ i }) => (i === 0 ? { action: 'buy', notional: 0.001 } : null) },
    cfg,
  });
  assert.equal(tiny.trades, 0, '低于最小名义不成交');
});

test('部分卖出：fraction 决定卖多少，卖光后可以再买', () => {
  const acts = ['buy', 'sell', 'buy', 'sell'];
  const r = runBacktest({
    bars: bars([10, 12, 12, 15]),
    strategy: { onBar: ({ i }) => (acts[i] ? { action: acts[i], fraction: acts[i] === 'sell' ? 0.5 : 1 } : null) },
    cfg,
  });
  const sells = r.tradeLog.filter((t) => t.side === 'sell');
  assert.ok(sells.length >= 2, '两次卖出都应成交');
  assert.ok(sells[0].qty > 0);
});

test('最大回撤：单调下跌时回撤为正，上涨时回撤 0', () => {
  const up = runBacktest({ bars: bars([10, 11, 12]), strategy: { onBar: () => null }, cfg });
  assert.equal(up.maxDrawdownPct, 0);

  const down = runBacktest({
    bars: bars([10, 8, 5]),
    strategy: { onBar: ({ i }) => (i === 0 ? { action: 'buy', fraction: 1 } : null) },
    cfg,
  });
  assert.ok(down.maxDrawdownPct > 0);
});

test('mock 策略的 init 会被调用一次（可初始化状态）', () => {
  let inits = 0;
  runBacktest({
    bars: bars([10, 11]),
    strategy: { onBar: () => null, init: () => { inits += 1; } },
    cfg,
  });
  assert.equal(inits, 1);
});

test('结果字段齐全：from/to/curve/bars 与策略名', () => {
  const r = runBacktest({ bars: bars([10, 11, 12]), strategy: { name: 's', onBar: () => null }, cfg, symbol: 'btc' });
  assert.equal(r.bars, 3);
  assert.equal(r.curve.length, 3);
  assert.equal(r.from, 1_800_000_000_000);
  assert.ok(r.to > r.from);
  assert.equal(r.symbol, 'BTC');
});
