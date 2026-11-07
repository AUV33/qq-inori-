// quant/risk 金标：卖出永远放行；买入的净值/日笔数/日亏/持仓数/单仓占比五道硬拦截。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, rollDay, checkRisk } from '../src/quant/risk.js';

const account = (over = {}) => ({ positions: {}, day: null, ...over });

test('dayKey：按 UTC 日期切片', () => {
  assert.equal(dayKey(Date.UTC(2026, 10, 2, 23, 59)), '2026-11-02');
});

test('rollDay：跨日重置当日统计，startEquity 用当日第一笔前的净值', () => {
  const acc = { day: { date: '2026-11-01', startEquity: 100, trades: 5 } };
  const day = rollDay(acc, Date.UTC(2026, 10, 2, 1, 0), 88);
  assert.equal(day.date, '2026-11-02');
  assert.equal(day.startEquity, 88);
  assert.equal(day.trades, 0);
  // 同日再调不重置
  assert.equal(rollDay(acc, Date.UTC(2026, 10, 2, 2, 0), 50).startEquity, 88);
});

test('checkRisk：卖出永远放行（只受持仓数量约束，由 paper 校验）', () => {
  assert.deepEqual(checkRisk(account(), {}, { side: 'sell', symbol: 'BTC', notional: 999, equityNow: 100 }), { ok: true });
});

test('checkRisk：净值无效 → 拒绝', () => {
  for (const equityNow of [0, -1, NaN, undefined, 'x']) {
    const r = checkRisk(account(), {}, { side: 'buy', symbol: 'BTC', notional: 10, equityNow });
    assert.equal(r.ok, false);
    assert.match(r.reason, /净值无效/);
  }
});

test('checkRisk：当日成交笔数到上限 → 拒绝', () => {
  const r = checkRisk(account({ day: { trades: 10, startEquity: 100 } }), {}, { side: 'buy', symbol: 'BTC', notional: 10, price: 1, equityNow: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /今日成交已达 10 笔上限/);
  const custom = checkRisk(account({ day: { trades: 3, startEquity: 100 } }), { risk: { maxTradesPerDay: 3 } }, { side: 'buy', symbol: 'BTC', notional: 10, price: 1, equityNow: 100 });
  assert.equal(custom.ok, false);
});

test('checkRisk：当日亏损到上限 → 停止买入', () => {
  const r = checkRisk(account({ day: { trades: 1, startEquity: 100 } }), {}, { side: 'buy', symbol: 'BTC', notional: 10, price: 1, equityNow: 90 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /今日亏损已达 10% 上限/);
  // 只亏 9% 还能买
  assert.equal(checkRisk(account({ day: { trades: 1, startEquity: 100 } }), {}, { side: 'buy', symbol: 'BTC', notional: 10, price: 1, equityNow: 91 }).ok, true);
});

test('checkRisk：持仓数量到上限 → 拒绝开新仓；已有该仓则不受此限', () => {
  const acc = account({ positions: { A: { qty: 1 }, B: { qty: 1 } } });
  const r = checkRisk(acc, {}, { side: 'buy', symbol: 'C', notional: 5, price: 1, equityNow: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /持仓数已达 2 个上限/);
  const add = checkRisk(acc, {}, { side: 'buy', symbol: 'A', notional: 5, price: 1, equityNow: 100 });
  assert.equal(add.ok, true, '给已有持仓加仓不算开新仓');
});

test('checkRisk：单仓占比超上限 → 拒绝（含已有仓位 + 本次名义金额）', () => {
  const acc = account({ positions: { A: { qty: 40 } }, day: { trades: 0, startEquity: 100 } });
  const r = checkRisk(acc, {}, { side: 'buy', symbol: 'A', notional: 20, price: 1, equityNow: 100 });
  assert.equal(r.ok, false, '40+20=60 > 50%');
  assert.match(r.reason, /单仓将达 60\.0%，超过 50% 上限/);
  const ok = checkRisk(acc, {}, { side: 'buy', symbol: 'A', notional: 5, price: 1, equityNow: 100 });
  assert.equal(ok.ok, true, '45% 仍在限内');
});

test('checkRisk：风控参数可覆盖（maxPositionPct / maxOpenPositions / maxDailyLossPct）', () => {
  const acc = account({ positions: { A: { qty: 1 } }, day: { trades: 0, startEquity: 100 } });
  assert.equal(checkRisk(acc, { risk: { maxOpenPositions: 1 } }, { side: 'buy', symbol: 'B', notional: 5, price: 1, equityNow: 100 }).ok, false);
  assert.equal(checkRisk(account({ day: { trades: 0, startEquity: 100 } }), { risk: { maxPositionPct: 0.2 } }, { side: 'buy', symbol: 'A', notional: 30, price: 1, equityNow: 100 }).ok, false);
  assert.equal(checkRisk(account({ day: { trades: 0, startEquity: 100 } }), { risk: { maxDailyLossPct: 0.05 } }, { side: 'buy', symbol: 'A', notional: 5, price: 1, equityNow: 94 }).ok, false);
});
