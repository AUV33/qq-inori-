// quant/backtest.js · K 线回放回测
//
// 和模拟盘走**同一个** executeOrder / checkRisk，所以回测里成立的仓位约束，实盘也成立。
// 只做"单标的、逐 bar、收盘价成交"，不假装能拿到 bar 内的更优价格。

import { createAccount, equity, executeOrder, roundTo } from './paper.js';
import { rollDay } from './risk.js';

const EPS = 1e-9;

function maxDrawdownPct(curve) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * @param {{bars:Array, strategy:object, cfg:object, symbol:string}} args
 */
export function runBacktest({ bars, strategy, cfg, symbol = 'TEST' }) {
  if (!Array.isArray(bars) || bars.length < 2) throw new Error('回测至少需要 2 根 K 线');
  if (!strategy || typeof strategy.onBar !== 'function') throw new Error('策略缺少 onBar()');

  const sym = String(symbol).toUpperCase();
  const account = createAccount({
    initialCapitalCny: cfg.initialCapitalCny,
    cnyPerUsdt: cfg.cnyPerUsdt,
    quote: cfg.quote,
    now: Number(bars[0].openTime) || Date.now(),
  });
  strategy.init?.({ account, cfg, symbol: sym });

  const curve = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    account.lastPrices[sym] = bar.close;
    rollDay(account, Number(bar.closeTime) || Number(bar.openTime), equity(account));

    const eqNow = equity(account);
    const signal = strategy.onBar({ bars, i, bar, account, symbol: sym, equity: eqNow }) || null;

    if (signal?.action === 'buy' && account.positions[sym] == null) {
      const cap = eqNow * Number(cfg.risk?.maxPositionPct ?? 0.5) * 0.98;
      const wanted = Number(signal.notional ?? eqNow * Number(signal.fraction ?? 1));
      const notional = roundTo(Math.min(wanted, cap), 8);
      if (notional >= Number(cfg.minNotionalUsdt ?? 5) - EPS) {
        executeOrder(account, { symbol: sym, side: 'buy', notional, price: bar.close, ts: bar.closeTime }, cfg);
      }
    } else if (signal?.action === 'sell' && account.positions[sym] != null) {
      const pos = account.positions[sym];
      const ratio = signal.fraction == null ? 1 : Math.max(0, Math.min(1, Number(signal.fraction)));
      const qty = ratio >= 1 ? 'all' : roundTo(pos.qty * ratio, 10);
      if (qty === 'all' || qty > 0) {
        executeOrder(account, { symbol: sym, side: 'sell', qty, price: bar.close, ts: bar.closeTime }, cfg);
      }
    }
    curve.push(equity(account));
  }

  const initialEquity = account.initialEquity;
  const finalEquity = equity(account);
  const sells = account.trades.filter((t) => t.side === 'sell');
  const wins = sells.filter((t) => Number(t.realizedPnl) > 0);
  const feesPaid = roundTo(account.trades.reduce((s, t) => s + Number(t.fee ?? 0), 0), 8);
  const firstClose = Number(bars[0].close);
  const lastClose = Number(bars[bars.length - 1].close);

  return {
    symbol: sym,
    strategy: strategy.name ?? 'unknown',
    bars: bars.length,
    from: Number(bars[0].openTime),
    to: Number(bars[bars.length - 1].closeTime),
    initialEquity,
    finalEquity,
    totalReturnPct: roundTo(((finalEquity - initialEquity) / initialEquity) * 100, 4),
    benchmarkReturnPct: roundTo(((lastClose - firstClose) / firstClose) * 100, 4),
    maxDrawdownPct: roundTo(maxDrawdownPct(curve), 4),
    trades: account.trades.length,
    buys: account.trades.length - sells.length,
    sells: sells.length,
    winRatePct: sells.length ? roundTo((wins.length / sells.length) * 100, 2) : 0,
    feesPaid,
    curve,
    tradeLog: account.trades,
  };
}
