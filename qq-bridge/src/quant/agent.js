// quant/agent.js · 给她用的量化工具层（薄封装，不引入新交易逻辑）
//
// 分工：config/market/paper/risk/backtest 是引擎（单测锁死的确定性代码），
// 这里只做三件事：读 config.json 的 quant 段、把引擎结果包成模型能读的文字、记决策日记。
//
// 安全边界：
//   - 只有模拟盘；没有真钱执行器（真钱在 Q-5，另写计划、另加风控门）。
//   - 下单冷却 30 秒：防连点，也防群友 prompt injection 刷单。
//   - quant.enabled=false 时所有写操作拒绝（读操作也一并拒绝，避免"看不见但能调"）。

import fs from 'node:fs';
import path from 'node:path';
import { bridgePath, stateDataPath } from '../domain/shared/project-paths.js';
import { readJsonl, appendJsonl } from './store.js';
import { resolveQuantConfig } from './config.js';
import { getKlines, getTicker, readCachedKlines } from './market.js';
import { loadAccount, saveAccount, executeOrder, equity, summary, DEFAULT_ACCOUNT_FILE } from './paper.js';
import { runBacktest } from './backtest.js';
import { createStrategy, STRATEGY_NAMES } from './strategies/index.js';

export const JOURNAL_FILE = process.env.QQ_INORI_QUANT_DIR
  ? path.join(process.env.QQ_INORI_QUANT_DIR, 'journal.jsonl')
  : stateDataPath('quant', 'journal.jsonl');

export const ORDER_COOLDOWN_MS = 30_000;
let lastOrderAt = 0;

/** 只给测试用：重置冷却，避免用例之间互相影响 */
export function _resetCooldownForTest() {
  lastOrderAt = 0;
}

/** 每次调用重新读 config.json：主人改开关不需要重启 MCP（注册期仍要重启） */
export function loadQuantConfig() {
  // 测试/离线钩子：直接给一段 quant 配置 JSON，不读 config.json
  if (process.env.QQ_INORI_QUANT_JSON) {
    try { return resolveQuantConfig(JSON.parse(process.env.QQ_INORI_QUANT_JSON)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'agent.js:37'); }
  }
  let raw = {};
  try {
    const text = fs.readFileSync(bridgePath('config.json'), 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text)?.quant ?? {};
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'agent.js:43'); }
  return resolveQuantConfig(raw);
}

function fmtPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtTime(ms) {
  try {
    const d = new Date(Number(ms));
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return '—'; }
}

function ensureEnabled(cfg) {
  if (!cfg.enabled) return { ok: false, reason: '量化模块没开（config.json 的 quant.enabled=false）' };
  return null;
}

// ---------- 读 ----------

export function quantStatus() {
  const cfg = loadQuantConfig();
  const { account, created } = loadAccount(DEFAULT_ACCOUNT_FILE, cfg);
  const eq = equity(account);
  const retPct = account.initialEquity > 0 ? ((eq - account.initialEquity) / account.initialEquity) * 100 : 0;
  const marks = Object.entries(account.lastPrices ?? {})
    .map(([s, p]) => `${s} ${Number(p).toFixed(2)}`)
    .join('，') || '还没记过价';
  const lines = [
    `量化模拟盘${created ? '（首次创建）' : ''}：${summary(account)}`,
    `本金 ${cfg.initialCapitalCny} 元（汇率 ${cfg.cnyPerUsdt} → ${account.initialEquity.toFixed(4)} ${cfg.quote}），收益 ${fmtPct(retPct)}`,
    `风控：单仓≤${(cfg.risk.maxPositionPct * 100).toFixed(0)}%、日亏≤${(cfg.risk.maxDailyLossPct * 100).toFixed(0)}% 停买、每日≤${cfg.risk.maxTradesPerDay} 笔、最多 ${cfg.risk.maxOpenPositions} 仓、下单冷却 ${ORDER_COOLDOWN_MS / 1000}s`,
    `已记的价：${marks}`,
    `可用策略：${STRATEGY_NAMES.join('、')}；这是模拟盘，不碰真钱。`,
  ];
  return { ok: true, text: lines.join('\n'), account: { equity: eq, cash: account.cash, positions: account.positions } };
}

export async function quantQuote({ symbol = 'BTCUSDT' } = {}) {
  const cfg = loadQuantConfig();
  const t = await getTicker({ symbol, baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs });
  return {
    ok: true,
    text: `${t.symbol} 最新 ${t.price}（24h ${fmtPct(t.changePct)}，高 ${t.high} / 低 ${t.low}）`,
    ticker: t,
  };
}

export async function quantKlines({ symbol = 'BTCUSDT', interval = '1h', limit = 24 } = {}) {
  const cfg = loadQuantConfig();
  const n = Math.max(2, Math.min(500, Math.round(Number(limit) || 24)));
  const r = await getKlines({ symbol, interval, limit: n, baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs });
  const closes = r.bars.map((b) => Number(b.close));
  const first = closes[0];
  const last = closes[closes.length - 1];
  const high = Math.max(...r.bars.map((b) => Number(b.high)));
  const low = Math.min(...r.bars.map((b) => Number(b.low)));
  const changePct = ((last - first) / first) * 100;
  return {
    ok: true,
    text: `${String(symbol).toUpperCase()} ${interval} 最近 ${closes.length} 根：${first} → ${last}（${fmtPct(changePct)}），区间高 ${high} / 低 ${low}${r.stale ? '（用的是本地缓存）' : ''}`,
    bars: closes.length,
    first,
    last,
    high,
    low,
    changePct,
    stale: !!r.stale,
  };
}

export async function quantBacktest({ strategy = 'sma-cross', symbol = 'BTCUSDT', interval = '1h', limit = 500, params = {} } = {}) {
  const cfg = loadQuantConfig();
  const n = Math.max(50, Math.min(1000, Math.round(Number(limit) || 500)));
  const strat = createStrategy(strategy, params);
  let bars = readCachedKlines({ symbol, interval })?.bars ?? null;
  if (!bars || bars.length < n) {
    const got = await getKlines({ symbol, interval, limit: n, baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs });
    bars = got.bars;
  }
  const r = runBacktest({ bars, strategy: strat, cfg, symbol });
  return {
    ok: true,
    text: [
      `回测 ${strat.name} ${r.symbol} ${interval}（${r.bars} 根）`,
      `策略 ${fmtPct(r.totalReturnPct)} ｜ 同期涨跌 ${fmtPct(r.benchmarkReturnPct)} ｜ 最大回撤 ${r.maxDrawdownPct.toFixed(2)}%`,
      `成交 ${r.trades} 笔（买 ${r.buys} / 卖 ${r.sells}）｜ 胜率 ${r.winRatePct.toFixed(1)}% ｜ 手续费 ${r.feesPaid.toFixed(6)} USDT`,
      '这是历史回放，不代表以后能赚；先看它能不能跑赢同期涨跌。',
    ].join('\n'),
    metrics: {
      totalReturnPct: r.totalReturnPct,
      benchmarkReturnPct: r.benchmarkReturnPct,
      maxDrawdownPct: r.maxDrawdownPct,
      trades: r.trades,
      winRatePct: r.winRatePct,
      feesPaid: r.feesPaid,
    },
  };
}

export function quantJournal({ limit = 20 } = {}) {
  const rows = readJsonl(JOURNAL_FILE).slice(-Math.max(1, Math.min(200, Number(limit) || 20)));
  if (!rows.length) return { ok: true, text: '还没有交易/决策记录。', rows: [] };
  const lines = rows.map((r) => {
    if (r.kind === 'note') return `${fmtTime(r.ts)} [想法] ${r.text}${r.tags?.length ? `（${r.tags.join('/')}）` : ''}`;
    const side = r.side === 'buy' ? '买' : '卖';
    const pnl = r.realizedPnl != null ? `，实现 ${Number(r.realizedPnl).toFixed(4)}` : '';
    return `${fmtTime(r.ts)} ${side} ${r.symbol} ${r.qty}@${Number(r.price).toFixed(2)}${pnl}`;
  });
  return { ok: true, text: lines.join('\n'), rows };
}

// ---------- 写 ----------

export function quantNote({ text, tags = [] } = {}) {
  const cfg = loadQuantConfig();
  const off = ensureEnabled(cfg);
  if (off) return off;
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reason: '想法是空的' };
  if (body.length > 2000) return { ok: false, reason: '想法太长（上限 2000 字）' };
  const safeTags = (Array.isArray(tags) ? tags : []).map((t) => String(t).slice(0, 20)).slice(0, 5);
  const r = appendJsonl(JOURNAL_FILE, { ts: Date.now(), kind: 'note', text: body, tags: safeTags });
  if (!r.ok) return { ok: false, reason: `写日记失败：${r.error ?? '未知'}` };
  return { ok: true, text: '记下了。' };
}

function cooldownLeft() {
  const left = ORDER_COOLDOWN_MS - (Date.now() - lastOrderAt);
  return left > 0 ? left : 0;
}

export async function quantBuy({ symbol = 'BTCUSDT', notional = 0, price = null } = {}) {
  const cfg = loadQuantConfig();
  const off = ensureEnabled(cfg);
  if (off) return off;
  const left = cooldownLeft();
  if (left > 0) return { ok: false, reason: `下单太快了，再等 ${Math.ceil(left / 1000)} 秒` };
  const n = Number(notional);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: '买入金额无效' };

  const px = Number.isFinite(Number(price)) && Number(price) > 0
    ? Number(price)
    : (await getTicker({ symbol, baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs })).price;
  const { account } = loadAccount(DEFAULT_ACCOUNT_FILE, cfg);
  const res = executeOrder(account, { symbol, side: 'buy', price: px, notional: n, ts: Date.now() }, cfg);
  if (!res.ok) return res;
  lastOrderAt = Date.now();
  saveAccount(account);
  appendJsonl(JOURNAL_FILE, { kind: 'trade', ...res.fill });
  return {
    ok: true,
    text: `买成了：${res.fill.symbol} ${res.fill.qty}@${res.fill.price.toFixed(2)}，手续费 ${res.fill.fee}。\n${summary(account)}`,
    fill: res.fill,
  };
}

export async function quantSell({ symbol = 'BTCUSDT', qty = 'all', price = null } = {}) {
  const cfg = loadQuantConfig();
  const off = ensureEnabled(cfg);
  if (off) return off;
  const left = cooldownLeft();
  if (left > 0) return { ok: false, reason: `下单太快了，再等 ${Math.ceil(left / 1000)} 秒` };

  const px = Number.isFinite(Number(price)) && Number(price) > 0
    ? Number(price)
    : (await getTicker({ symbol, baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs })).price;
  const { account } = loadAccount(DEFAULT_ACCOUNT_FILE, cfg);
  const want = String(qty).toLowerCase() === 'all' ? 'all' : Number(qty);
  const res = executeOrder(account, { symbol, side: 'sell', price: px, qty: want, ts: Date.now() }, cfg);
  if (!res.ok) return res;
  lastOrderAt = Date.now();
  saveAccount(account);
  appendJsonl(JOURNAL_FILE, { kind: 'trade', ...res.fill });
  const pnl = res.fill.realizedPnl != null ? `，这笔记了 ${res.fill.realizedPnl.toFixed(4)} USDT` : '';
  return {
    ok: true,
    text: `卖成了：${res.fill.symbol} ${res.fill.qty}@${res.fill.price.toFixed(2)}，手续费 ${res.fill.fee}${pnl}。\n${summary(account)}`,
    fill: res.fill,
  };
}

// ---------- 给 own-life 的一行快照（纯本地读，不联网） ----------

export function quantSnapshotLine(now = Date.now()) {
  const cfg = loadQuantConfig();
  if (!cfg.enabled) return null;
  let account;
  try {
    ({ account } = loadAccount(DEFAULT_ACCOUNT_FILE, cfg));
  } catch {
    return null;
  }
  const eq = equity(account);
  const retPct = account.initialEquity > 0 ? ((eq - account.initialEquity) / account.initialEquity) * 100 : 0;
  const pos = Object.entries(account.positions ?? {})
    .filter(([, p]) => Number(p.qty) > 0)
    .map(([s, p]) => `${s} ${p.qty}`)
    .join('，') || '空仓';
  const marks = Object.entries(account.lastPrices ?? {})
    .slice(-2)
    .map(([s, p]) => `${s} ${Number(p).toFixed(2)}（${fmtTime(account.updatedAt ?? now)}）`)
    .join('，') || '还没记过价';
  return `【量化】你自己的模拟盘：${eq.toFixed(2)} ${account.quote}（${fmtPct(retPct)}），${pos}；${marks}。这是给你的 100 块练手钱，亏了不心疼，赚了算你的。行情用 qq_quant_quote，账本用 qq_quant_status，想法用 qq_quant_note 记一句；真要下单去 qq_tools 的「量化」里。`;
}
