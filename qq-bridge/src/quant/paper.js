// quant/paper.js · 模拟账户（paper trading）
//
// 一条铁律：**模拟账户和真钱账户共用同一套风控与记账代码**，只在"执行器"上分开。
// 这样 Phase 3 接真钱时，验证过的不是另一套逻辑。
//
// 成交模型（刻意保守，先让她体会成本）：
//   - 市价单按 bar/ticker 价成交，买入加 5bps 滑点、卖出减 5bps；
//   - 手续费 0.1%（taker），按成交名义额收；
//   - 最小名义 5 USDT（Binance NOTIONAL 过滤器）；
//   - 数量按交易所 stepSize 向下取整。

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './store.js';
import { stateDataPath } from '../domain/shared/project-paths.js';
import { checkRisk, rollDay, dayKey } from './risk.js';
import { cnyToQuote } from './config.js';

export const DEFAULT_ACCOUNT_FILE = process.env.QQ_INORI_QUANT_DIR
  ? path.join(process.env.QQ_INORI_QUANT_DIR, 'account.json')
  : stateDataPath('quant', 'account.json');
const EPS = 1e-9;

export function roundTo(x, digits = 8) {
  const f = 10 ** digits;
  return Math.round(Number(x) * f) / f;
}

export function floorToStep(qty, stepSize = 0.00001) {
  const step = Number(stepSize) > 0 ? Number(stepSize) : 0.00001;
  const n = Math.floor(Number(qty) / step + 1e-9);
  return roundTo(n * step, 10);
}

export function createAccount({ initialCapitalCny = 100, cnyPerUsdt = 7.1, quote = 'USDT', now = Date.now() } = {}) {
  const cfg = { cnyPerUsdt };
  const initialEquity = cnyToQuote(initialCapitalCny, cfg);
  return {
    version: 1,
    quote: String(quote || 'USDT').toUpperCase(),
    initialCapitalCny: Number(initialCapitalCny),
    cnyPerUsdt: Number(cnyPerUsdt),
    initialEquity,
    cash: initialEquity,
    positions: {},
    lastPrices: {},
    day: { date: dayKey(now), startEquity: initialEquity, trades: 0 },
    trades: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 净值 = 现金 + 持仓按最新标记价估值（没有标记价时退回成本价） */
export function equity(account) {
  let total = Number(account?.cash ?? 0);
  for (const [symbol, pos] of Object.entries(account?.positions ?? {})) {
    const qty = Number(pos?.qty ?? 0);
    if (qty <= 0) continue;
    const mark = Number(account?.lastPrices?.[symbol] ?? pos?.avgPrice ?? 0);
    total += qty * mark;
  }
  return roundTo(total, 8);
}

export function positionOf(account, symbol) {
  const p = account?.positions?.[String(symbol).toUpperCase()];
  return p && Number(p.qty) > EPS ? p : null;
}

function clone(account) {
  return JSON.parse(JSON.stringify(account));
}

/** 失败时必须把 account 恢复原样：被拒绝的单子不能留下 lastPrices/day 的副作用 */
function makeReject(account) {
  const snapshot = clone(account);
  return (reason) => {
    for (const k of Object.keys(account)) delete account[k];
    Object.assign(account, snapshot);
    return { ok: false, reason };
  };
}

/**
 * 执行一笔市价单（就地修改 account）。
 * @param order {{symbol:string, side:'buy'|'sell', price:number, qty?:number|'all', notional?:number, ts?:number}}
 * @param cfg 已 resolve 的 quant 配置
 * @param opts {{stepSize?:number}}
 */
export function executeOrder(account, order, cfg, { stepSize = 0.00001 } = {}) {
  const symbol = String(order?.symbol ?? '').toUpperCase();
  const side = order?.side === 'sell' ? 'sell' : 'buy';
  const price = Number(order?.price);
  const ts = Number(order?.ts ?? Date.now());
  const feeRate = Number(cfg?.feeRate ?? 0.001);
  const slip = Number(cfg?.slippageBps ?? 5) / 10_000;
  const minNotional = Number(cfg?.minNotionalUsdt ?? 5);

  const reject = makeReject(account);
  if (!symbol) return reject('缺少交易对');
  if (!Number.isFinite(price) || price <= 0) return reject('价格无效');

  account.lastPrices[symbol] = price;
  rollDay(account, ts, equity(account));

  if (side === 'buy') {
    const fillPrice = roundTo(price * (1 + slip), 8);
    const wantQty = order.notional != null
      ? Number(order.notional) / fillPrice
      : Number(order.qty);
    if (!Number.isFinite(wantQty) || wantQty <= 0) return reject('下单数量无效');
    const qty = floorToStep(wantQty, stepSize);
    if (qty <= 0) return reject('数量小于交易所步长');
    const notional = roundTo(qty * fillPrice, 8);
    if (notional < minNotional - EPS) return reject(`名义额 ${notional.toFixed(4)} 低于最小 ${minNotional} USDT`);

    const riskCheck = checkRisk(account, cfg, { side, symbol, notional, price: fillPrice, equityNow: equity(account) });
    if (!riskCheck.ok) return reject(riskCheck.reason);

    const fee = roundTo(notional * feeRate, 8);
    const total = roundTo(notional + fee, 8);
    if (total > Number(account.cash) + EPS) return reject(`现金不足：需要 ${total.toFixed(4)}，可用 ${Number(account.cash).toFixed(4)}`);

    const prev = account.positions[symbol] ?? { qty: 0, avgPrice: 0 };
    const newQty = roundTo(prev.qty + qty, 10);
    const avgPrice = newQty > 0 ? roundTo((prev.qty * prev.avgPrice + notional) / newQty, 8) : 0;
    account.positions[symbol] = { qty: newQty, avgPrice };
    account.cash = roundTo(Number(account.cash) - total, 8);
    account.day.trades += 1;

    const fill = { ts, symbol, side, qty, price: fillPrice, notional, fee, cashAfter: account.cash };
    account.trades.push(fill);
    account.updatedAt = ts;
    return { ok: true, fill, equity: equity(account) };
  }

  // sell
  const pos = positionOf(account, symbol);
  if (!pos) return reject(`没有 ${symbol} 持仓`);
  const fillPrice = roundTo(price * (1 - slip), 8);
  const wantQty = order.qty === 'all' || order.qty == null ? Number(pos.qty) : Number(order.qty);
  if (!Number.isFinite(wantQty) || wantQty <= 0) return reject('卖出数量无效');
  const qty = roundTo(Math.min(wantQty, Number(pos.qty)), 10);
  if (qty <= 0) return reject('卖出数量为 0');

  const notional = roundTo(qty * fillPrice, 8);
  const fee = roundTo(notional * feeRate, 8);
  const realizedPnl = roundTo((fillPrice - Number(pos.avgPrice)) * qty - fee, 8);

  const left = roundTo(Number(pos.qty) - qty, 10);
  if (left <= EPS) delete account.positions[symbol];
  else account.positions[symbol] = { qty: left, avgPrice: Number(pos.avgPrice) };
  account.cash = roundTo(Number(account.cash) + notional - fee, 8);
  account.day.trades += 1;

  const fill = { ts, symbol, side, qty, price: fillPrice, notional, fee, realizedPnl, cashAfter: account.cash };
  account.trades.push(fill);
  account.updatedAt = ts;
  return { ok: true, fill, equity: equity(account) };
}

export function loadAccount(file = DEFAULT_ACCOUNT_FILE, { initialCapitalCny = 100, cnyPerUsdt = 7.1, quote = 'USDT' } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && j.positions) {
      j.trades = Array.isArray(j.trades) ? j.trades : [];
      j.lastPrices = j.lastPrices && typeof j.lastPrices === 'object' ? j.lastPrices : {};
      return { account: j, created: false };
    }
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'paper.js:171'); }
  return { account: createAccount({ initialCapitalCny, cnyPerUsdt, quote }), created: true };
}

export function saveAccount(account, file = DEFAULT_ACCOUNT_FILE) {
  return writeJsonAtomic(file, account);
}

/** 给模型/人看的一行摘要 */
export function summary(account) {
  const eq = equity(account);
  const retPct = account.initialEquity > 0 ? ((eq - account.initialEquity) / account.initialEquity) * 100 : 0;
  const pos = Object.entries(account.positions ?? {})
    .filter(([, p]) => Number(p.qty) > 0)
    .map(([s, p]) => `${s} ${p.qty}@${p.avgPrice}`)
    .join('，') || '空仓';
  return `净值 ${eq.toFixed(4)} ${account.quote}（${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%），现金 ${Number(account.cash).toFixed(4)}，持仓：${pos}，今日成交 ${account.day?.trades ?? 0} 笔`;
}
