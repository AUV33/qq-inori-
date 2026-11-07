// quant/paper 金标：模拟账户的成交模型（滑点/手续费/步长/最小名义）与「被拒不留副作用」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAccount, equity, positionOf, executeOrder, roundTo, floorToStep, loadAccount, saveAccount, summary,
} from '../src/quant/paper.js';

const cfg = { feeRate: 0.001, slippageBps: 5, minNotionalUsdt: 5, risk: { maxPositionPct: 1, maxTradesPerDay: 100 } };
const account = (over = {}) => ({ ...createAccount({ initialCapitalCny: 710, cnyPerUsdt: 7.1 }), ...over });

test('createAccount：按汇率把人民币本金换成计价货币，现金=初始净值', () => {
  const a = createAccount({ initialCapitalCny: 710, cnyPerUsdt: 7.1 });
  assert.equal(a.quote, 'USDT');
  assert.equal(a.initialEquity, 100);
  assert.equal(a.cash, 100);
  assert.deepEqual(a.positions, {});
  assert.equal(a.day.trades, 0);
});

test('equity：没有标记价时退回成本价；有标记价用最新价', () => {
  const a = account({ cash: 50, positions: { BTC: { qty: 1, avgPrice: 10 } }, lastPrices: {} });
  assert.equal(equity(a), 60);
  a.lastPrices.BTC = 20;
  assert.equal(equity(a), 70);
});

test('roundTo / floorToStep：按步长向下取整（不能超出交易所精度）', () => {
  assert.equal(roundTo(1.234567891, 4), 1.2346);
  assert.equal(floorToStep(1.239, 0.01), 1.23);
  assert.equal(floorToStep(0.000019, 0.00001), 0.00001);
  assert.equal(floorToStep(1, 0), 1);
});

test('executeOrder 买入：加滑点、扣手续费、更新均价与现金', () => {
  const a = account();
  const r = executeOrder(a, { symbol: 'btc', side: 'buy', price: 10, notional: 20, ts: Date.now() }, cfg, { stepSize: 0.00001 });
  assert.equal(r.ok, true);
  const fill = r.fill;
  assert.equal(fill.symbol, 'BTC');
  assert.equal(fill.price, roundTo(10 * 1.0005, 8), '买入价含 5bps 滑点');
  assert.ok(fill.fee > 0);
  assert.equal(a.day.trades, 1);
  assert.ok(a.positions.BTC.qty > 0);
  assert.ok(Math.abs(a.cash + fill.notional + fill.fee - 100) < 1e-6, '现金 = 初始 - 名义 - 手续费');
});

test('executeOrder 买入：加仓时均价按加权平均', () => {
  const a = account();
  executeOrder(a, { symbol: 'BTC', side: 'buy', price: 10, notional: 20 }, cfg);
  const firstAvg = a.positions.BTC.avgPrice;
  executeOrder(a, { symbol: 'BTC', side: 'buy', price: 20, notional: 20 }, cfg);
  assert.ok(a.positions.BTC.avgPrice > firstAvg, '第二次买更贵，均价应上移');
});

test('executeOrder 拒绝：非法参数被拒且**不留副作用**（lastPrices/day 要回滚）', () => {
  const cases = [
    [{ symbol: '', side: 'buy', price: 10, notional: 20 }, /缺少交易对/],
    [{ symbol: 'BTC', side: 'buy', price: 0, notional: 20 }, /价格无效/],
    [{ symbol: 'BTC', side: 'buy', price: 10, notional: 0 }, /下单数量无效/],
    [{ symbol: 'BTC', side: 'buy', price: 10, notional: 0.0000001 }, /数量小于交易所步长|下单数量无效/],
    [{ symbol: 'BTC', side: 'buy', price: 10, notional: 1 }, /低于最小 5 USDT/],
    [{ symbol: 'BTC', side: 'buy', price: 10, notional: 100000 }, /现金不足|单仓/],
  ];
  for (const [order, re] of cases) {
    const a = account({ lastPrices: {}, day: { date: '2026-11-02', startEquity: 100, trades: 3 } });
    const before = JSON.stringify(a);
    const r = executeOrder(a, order, cfg);
    assert.equal(r.ok, false, JSON.stringify(order));
    assert.match(r.reason, re);
    assert.equal(JSON.stringify(a), before, `被拒的单子不能留下任何副作用：${JSON.stringify(order)}`);
  }
});

test('executeOrder 卖出：部分卖出保留残余持仓，卖光删除持仓并记已实现盈亏', () => {
  const a = account();
  executeOrder(a, { symbol: 'BTC', side: 'buy', price: 10, notional: 20 }, cfg);
  const qty = a.positions.BTC.qty;
  const half = executeOrder(a, { symbol: 'BTC', side: 'sell', price: 12, qty: qty / 2 }, cfg);
  assert.equal(half.ok, true);
  assert.ok(a.positions.BTC, '还有一半持仓');
  assert.ok(half.fill.realizedPnl > 0, '卖得比均价高，应有正盈亏');

  const all = executeOrder(a, { symbol: 'BTC', side: 'sell', price: 12, qty: 'all' }, cfg);
  assert.equal(all.ok, true);
  assert.equal(a.positions.BTC, undefined, '卖光要删掉持仓');
  assert.equal(positionOf(a, 'BTC'), null);
});

test('executeOrder 卖出：没有持仓 → 拒绝；数量超过持仓按持仓卖', () => {
  const empty = account();
  assert.match(executeOrder(empty, { symbol: 'BTC', side: 'sell', price: 10, qty: 1 }, cfg).reason, /没有 BTC 持仓/);

  const a = account();
  executeOrder(a, { symbol: 'BTC', side: 'buy', price: 10, notional: 20 }, cfg);
  const over = executeOrder(a, { symbol: 'BTC', side: 'sell', price: 10, qty: 999 }, cfg);
  assert.equal(over.ok, true);
  assert.equal(a.positions.BTC, undefined, '按实际持仓卖光');
});

test('loadAccount / saveAccount / summary：缺失时新建、往返一致、摘要带净值与持仓', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-paper-'));
  const file = path.join(dir, 'account.json');
  const created = loadAccount(file, { initialCapitalCny: 710, cnyPerUsdt: 7.1 });
  assert.equal(created.created, true);
  assert.equal(created.account.cash, 100, '710 元 / 7.1 = 100 USDT');

  executeOrder(created.account, { symbol: 'BTC', side: 'buy', price: 10, notional: 20 }, cfg);
  assert.deepEqual(saveAccount(created.account, file), { ok: true });
  const reloaded = loadAccount(file);
  assert.equal(reloaded.created, false);
  assert.ok(reloaded.account.positions.BTC.qty > 0);

  const text = summary(reloaded.account);
  assert.match(text, /净值 /);
  assert.match(text, /持仓：BTC /);
  assert.match(text, /今日成交 1 笔/);
});
