// test-quant-core.test.mjs · 量化模块 Phase 1 的离线单测（不联网、不碰真实 state）
//
// 覆盖：配置解析/夹取、K 线解析与缓存回退、模拟盘成交与风控、回测指标口径。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveQuantConfig, QUANT_DEFAULTS, cnyToQuote } from '../src/quant/config.js';
import { parseKlines, getKlines, readCachedKlines, assertSymbol } from '../src/quant/market.js';
import { createAccount, executeOrder, equity, summary, loadAccount, saveAccount, floorToStep } from '../src/quant/paper.js';
import { checkRisk, rollDay, dayKey } from '../src/quant/risk.js';
import { runBacktest } from '../src/quant/backtest.js';
import { createStrategy, STRATEGY_NAMES } from '../src/quant/strategies/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 沙箱只允许仓库根的 .tmp/ 可写（qq-bridge/state 与 data/state 被 ACL 拦），测试临时文件放这
const TMP_ROOT = path.join(HERE, '..', '.tmp', `quant-test-${process.pid}-${Date.now()}`);

function tmpDir(name = '') {
  const d = path.join(TMP_ROOT, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fakeFetch(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

function klineRow(i, close) {
  const openTime = Date.UTC(2026, 0, 1) + i * 3600_000;
  return [openTime, String(close), String(close * 1.01), String(close * 0.99), String(close), '10', openTime + 3_599_999];
}

function barsFromCloses(closes) {
  return closes.map((c, i) => {
    const openTime = Date.UTC(2026, 0, 1) + i * 3600_000;
    return { openTime, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 10, closeTime: openTime + 3_599_999 };
  });
}

// ---------- config ----------

test('config: 默认关闭、本金 100 元、汇率 7.1', () => {
  const cfg = resolveQuantConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.initialCapitalCny, 100);
  assert.equal(cfg.cnyPerUsdt, 7.1);
  assert.equal(cfg.risk.maxPositionPct, 0.5);
  assert.equal(cfg.dataBaseUrl, QUANT_DEFAULTS.dataBaseUrl);
});

test('config: 100 元 ≈ 14.0845 USDT', () => {
  const cfg = resolveQuantConfig();
  assert.equal(cnyToQuote(100, cfg), 14.08450704);
});

test('config: 越界值被夹取，不是静默接受', () => {
  const cfg = resolveQuantConfig({ feeRate: 9, risk: { maxPositionPct: 5, maxTradesPerDay: 0 } });
  assert.equal(cfg.feeRate, 0.05);
  assert.equal(cfg.risk.maxPositionPct, 1);
  assert.equal(cfg.risk.maxTradesPerDay, 1);
});

test('config: 非白名单行情域名直接拒绝', () => {
  assert.throws(() => resolveQuantConfig({ dataBaseUrl: 'https://evil.example.com' }), /白名单/);
  assert.throws(() => resolveQuantConfig({ dataBaseUrl: 'http://data-api.binance.vision' }), /https/);
});

// ---------- market ----------

test('market: kline 数组归一化为数字 bar', () => {
  const bars = parseKlines([klineRow(0, 100), klineRow(1, 101)]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].close, 100);
  assert.equal(bars[1].openTime, Date.UTC(2026, 0, 1) + 3600_000);
});

test('market: 抓取成功写缓存，断网回退缓存并标 stale', async () => {
  const cacheDir = tmpDir('cache');
  const raw = [klineRow(0, 100), klineRow(1, 101), klineRow(2, 102)];
  const first = await getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 3, cacheDir, fetchImpl: fakeFetch(raw) });
  assert.equal(first.source, 'network');
  assert.equal(first.bars.length, 3);
  assert.ok(readCachedKlines({ symbol: 'BTCUSDT', interval: '1h', cacheDir }));

  const failing = async () => { throw new Error('ENETDOWN'); };
  const second = await getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 3, cacheDir, fetchImpl: failing });
  assert.equal(second.source, 'cache');
  assert.equal(second.stale, true);
  assert.equal(second.bars[2].close, 102);
});

test('market: 非法交易对/周期被拒绝（防路径注入）', () => {
  assert.throws(() => assertSymbol('../../etc/passwd'), /非法交易对/);
  assert.throws(() => assertSymbol('BTC USDT'), /非法交易对/);
});

// ---------- paper ----------

function freshAccount() {
  return createAccount({ initialCapitalCny: 100, cnyPerUsdt: 7.1 });
}

test('paper: 建账户 100 元 → 14.0845 USDT 现金', () => {
  const a = freshAccount();
  assert.equal(a.cash, 14.08450704);
  assert.equal(equity(a), 14.08450704);
  assert.deepEqual(a.positions, {});
});

test('paper: 买入含滑点与手续费，现金/持仓/净值一致', () => {
  const a = freshAccount();
  const cfg = resolveQuantConfig();
  const res = executeOrder(a, { symbol: 'BTCUSDT', side: 'buy', notional: 6, price: 100, ts: Date.UTC(2026, 0, 1) }, cfg);
  assert.equal(res.ok, true, res.reason);
  const fill = res.fill;
  assert.ok(fill.price > 100, '买入价应加滑点');
  assert.ok(fill.fee > 0);
  assert.equal(a.positions.BTCUSDT.qty, floorToStep(6 / fill.price, 0.00001));
  assert.equal(a.cash, Number((14.08450704 - fill.notional - fill.fee).toFixed(8)));
  assert.equal(a.day.trades, 1);
});

test('paper: 名义额低于 5 USDT 被拒', () => {
  const a = freshAccount();
  const cfg = resolveQuantConfig();
  const res = executeOrder(a, { symbol: 'BTCUSDT', side: 'buy', notional: 4.8, price: 100, ts: Date.UTC(2026, 0, 1) }, cfg);
  assert.equal(res.ok, false);
  assert.match(res.reason, /最小/);
});

test('paper: 现金不足被拒，账户不变', () => {
  const a = freshAccount();
  const cfg = resolveQuantConfig();
  const before = JSON.stringify(a);
  const res = executeOrder(a, { symbol: 'BTCUSDT', side: 'buy', notional: 100, price: 100, ts: Date.UTC(2026, 0, 1) }, cfg);
  assert.equal(res.ok, false);
  assert.equal(JSON.stringify(a), before);
});

test('paper: 卖出 all 清仓并记实现盈亏', () => {
  const a = freshAccount();
  const cfg = resolveQuantConfig();
  const ts = Date.UTC(2026, 0, 1);
  assert.equal(executeOrder(a, { symbol: 'BTCUSDT', side: 'buy', notional: 6, price: 100, ts }, cfg).ok, true);
  const res = executeOrder(a, { symbol: 'BTCUSDT', side: 'sell', qty: 'all', price: 110, ts: ts + 3600_000 }, cfg);
  assert.equal(res.ok, true, res.reason);
  assert.equal(a.positions.BTCUSDT, undefined);
  assert.ok(res.fill.realizedPnl > 0);
  assert.ok(a.cash > 14.08450704);
});

test('paper: 没有持仓时卖出被拒', () => {
  const a = freshAccount();
  const cfg = resolveQuantConfig();
  const res = executeOrder(a, { symbol: 'ETHUSDT', side: 'sell', qty: 'all', price: 3000 }, cfg);
  assert.equal(res.ok, false);
});

test('paper: 保存/读回账户一致', () => {
  const dir = tmpDir('account');
  const file = path.join(dir, 'account.json');
  const a = freshAccount();
  assert.equal(saveAccount(a, file).ok, true);
  const { account: b, created } = loadAccount(file);
  assert.equal(created, false);
  assert.deepEqual(b.positions, a.positions);
  assert.equal(b.cash, a.cash);
});

test('paper: summary 带净值与收益', () => {
  const s = summary(freshAccount());
  assert.match(s, /净值/);
  assert.match(s, /0\.00%/);
});

// ---------- risk ----------

test('risk: 日成交笔数到上限后拒绝买入、放行卖出', () => {
  const cfg = resolveQuantConfig({ risk: { maxTradesPerDay: 1 } });
  const a = freshAccount();
  const ts = Date.UTC(2026, 0, 1);
  assert.equal(executeOrder(a, { symbol: 'BTCUSDT', side: 'buy', notional: 6, price: 100, ts }, cfg).ok, true);
  const second = executeOrder(a, { symbol: 'BTCUSDT', side: 'buy', notional: 6, price: 100, ts }, cfg);
  assert.equal(second.ok, false);
  assert.match(second.reason, /成交/);
  assert.equal(executeOrder(a, { symbol: 'BTCUSDT', side: 'sell', qty: 'all', price: 101, ts }, cfg).ok, true);
});

test('risk: 日亏损超限后拒绝买入', () => {
  const cfg = resolveQuantConfig();
  const a = freshAccount();
  a.cash = 5;
  a.day = { date: dayKey(Date.now()), startEquity: 14.08, trades: 0 };
  const check = checkRisk(a, cfg, { side: 'buy', symbol: 'BTCUSDT', notional: 5, price: 100, equityNow: equity(a) });
  assert.equal(check.ok, false);
  assert.match(check.reason, /亏损/);
});

test('risk: 持仓数上限', () => {
  const cfg = resolveQuantConfig({ risk: { maxOpenPositions: 1 } });
  const a = freshAccount();
  a.positions.ETHUSDT = { qty: 0.001, avgPrice: 3000 };
  const check = checkRisk(a, cfg, { side: 'buy', symbol: 'BTCUSDT', notional: 5, price: 100, equityNow: equity(a) });
  assert.equal(check.ok, false);
  assert.match(check.reason, /持仓数/);
});

test('risk: 单仓占净值比例上限', () => {
  const cfg = resolveQuantConfig();
  const a = freshAccount();
  const check = checkRisk(a, cfg, { side: 'buy', symbol: 'BTCUSDT', notional: 8, price: 100, equityNow: equity(a) });
  assert.equal(check.ok, false);
  assert.match(check.reason, /单仓/);
});

test('risk: 跨日重置当日统计', () => {
  const a = freshAccount();
  const d1 = Date.UTC(2026, 0, 1);
  const d2 = Date.UTC(2026, 0, 2);
  a.day = { date: dayKey(d1), startEquity: 14, trades: 9 };
  rollDay(a, d2, 13);
  assert.equal(a.day.date, dayKey(d2));
  assert.equal(a.day.trades, 0);
  assert.equal(a.day.startEquity, 13);
});

// ---------- backtest ----------

test('backtest: 先涨后跌的行情里双均线会开平仓，指标口径自洽', () => {
  const closes = [];
  for (let i = 0; i < 40; i += 1) closes.push(100 + i);
  for (let i = 0; i < 40; i += 1) closes.push(140 - i * 1.5);
  const bars = barsFromCloses(closes);
  const cfg = resolveQuantConfig();
  const strategy = createStrategy('sma-cross', { fast: 2, slow: 4 });
  const r = runBacktest({ bars, strategy, cfg, symbol: 'BTCUSDT' });

  assert.equal(r.bars, 80);
  assert.equal(r.curve.length, 80);
  assert.ok(r.trades >= 2, `至少一买一卖，实际 ${r.trades}`);
  assert.equal(r.buys + r.sells, r.trades);
  assert.ok(r.maxDrawdownPct >= 0);
  assert.ok(r.feesPaid > 0);
  assert.ok(Number.isFinite(r.totalReturnPct));
});

test('backtest: 无交易时胜率为 0 且净值等于本金', () => {
  const bars = barsFromCloses(Array.from({ length: 20 }, () => 100));
  const cfg = resolveQuantConfig();
  const strategy = { name: 'noop', onBar: () => null };
  const r = runBacktest({ bars, strategy, cfg, symbol: 'BTCUSDT' });
  assert.equal(r.trades, 0);
  assert.equal(r.winRatePct, 0);
  assert.equal(r.finalEquity, r.initialEquity);
});

test('backtest: 至少两根 K 线，否则报错', () => {
  const cfg = resolveQuantConfig();
  assert.throws(() => runBacktest({ bars: [barsFromCloses([100])[0]], strategy: { onBar() {} }, cfg }), /2 根/);
});

test('strategies: 注册表可列出并创建', () => {
  assert.deepEqual(STRATEGY_NAMES.sort(), ['breakout', 'sma-cross']);
  assert.equal(createStrategy('breakout', { lookback: 10 }).name, 'breakout(10)');
  assert.throws(() => createStrategy('nope'), /未知策略/);
});
