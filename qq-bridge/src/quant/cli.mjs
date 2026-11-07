#!/usr/bin/env node
// quant/cli.mjs · 人工可跑的量化命令行（Phase 1 验证入口）
//
// 用法（在 qq-bridge 目录下）：
//   node src/quant/cli.mjs fetch BTCUSDT 1h 500
//   node src/quant/cli.mjs backtest sma-cross BTCUSDT 1h 500
//   node src/quant/cli.mjs backtest breakout BTCUSDT 1h 500 --lookback=20
//   node src/quant/cli.mjs account
//   node src/quant/cli.mjs buy BTCUSDT 5
//   node src/quant/cli.mjs sell BTCUSDT all
//
// 注意：这是**模拟盘**入口，不连任何交易所下单接口。

import fs from 'node:fs';
import { bridgePath } from '../domain/shared/project-paths.js';
import { resolveQuantConfig } from './config.js';
import { getKlines, getTicker, readCachedKlines } from './market.js';
import { loadAccount, saveAccount, executeOrder, summary } from './paper.js';
import { createStrategy, STRATEGY_NAMES } from './strategies/index.js';
import { runBacktest } from './backtest.js';

function loadConfig() {
  let raw = {};
  try {
    const text = fs.readFileSync(bridgePath('config.json'), 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text)?.quant ?? {};
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'cli.mjs:27'); }
  return resolveQuantConfig(raw);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else positional.push(a);
  }
  return { positional, flags };
}

function fmtDate(ms) {
  try { return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 16); } catch { return String(ms); }
}

function fmtNum(x, digits = 4) {
  return Number(x).toFixed(digits);
}

async function cmdFetch({ positional }) {
  const [symbol = 'BTCUSDT', interval = '1h', limit = '500'] = positional;
  const cfg = loadConfig();
  const r = await getKlines({ symbol, interval, limit: Number(limit), baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs });
  const first = r.bars[0];
  const last = r.bars[r.bars.length - 1];
  console.log(`[fetch] ${symbol} ${interval} 共 ${r.bars.length} 根，来源 ${r.source}${r.stale ? '（stale）' : ''}`);
  console.log(`  ${fmtDate(first.openTime)} 开 ${first.open} → ${fmtDate(last.closeTime)} 收 ${last.close}`);
}

async function cmdBacktest({ positional, flags }) {
  const [strategyName = 'sma-cross', symbol = 'BTCUSDT', interval = '1h', limit = '500'] = positional;
  const cfg = loadConfig();
  const params = {};
  for (const [k, v] of Object.entries(flags)) {
    if (k === 'fast' || k === 'slow' || k === 'lookback') params[k] = Number(v);
  }
  const strategy = createStrategy(strategyName, params);
  let data = readCachedKlines({ symbol, interval });
  if (!data || data.bars.length < Number(limit)) {
    const got = await getKlines({ symbol, interval, limit: Number(limit), baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs });
    data = { bars: got.bars };
  }
  const r = runBacktest({ bars: data.bars, strategy, cfg, symbol });
  console.log(`[backtest] ${strategy.name} ${r.symbol} ${interval}（${r.bars} 根，${fmtDate(r.from)} ~ ${fmtDate(r.to)}）`);
  console.log(`  本金 ${fmtNum(r.initialEquity)} → 净值 ${fmtNum(r.finalEquity)} USDT`);
  console.log(`  策略收益 ${r.totalReturnPct >= 0 ? '+' : ''}${fmtNum(r.totalReturnPct, 2)}%  |  同期涨跌 ${r.benchmarkReturnPct >= 0 ? '+' : ''}${fmtNum(r.benchmarkReturnPct, 2)}%`);
  console.log(`  最大回撤 ${fmtNum(r.maxDrawdownPct, 2)}%  |  成交 ${r.trades} 笔（买 ${r.buys}/卖 ${r.sells}）  |  胜率 ${fmtNum(r.winRatePct, 1)}%  |  手续费 ${fmtNum(r.feesPaid, 6)} USDT`);
}

function cmdAccount({ flags }) {
  const cfg = loadConfig();
  const { account, created } = loadAccount(undefined, cfg);
  if (created) console.log('[account] 首次运行，已按本金创建模拟账户');
  console.log(`[account] ${summary(account)}`);
  if (flags.trades) {
    for (const t of account.trades.slice(-20)) {
      console.log(`  ${fmtDate(t.ts)} ${t.side} ${t.symbol} ${t.qty}@${t.price} 费 ${t.fee}`);
    }
  }
}

async function cmdTrade({ positional }, side) {
  const [symbol = 'BTCUSDT', amount] = positional;
  const cfg = loadConfig();
  const { account } = loadAccount(undefined, cfg);
  const ticker = await getTicker({ symbol, baseUrl: cfg.dataBaseUrl, timeoutMs: cfg.requestTimeoutMs });
  const order = side === 'buy'
    ? { symbol, side, price: ticker.price, notional: Number(amount) }
    : { symbol, side, price: ticker.price, qty: amount === 'all' ? 'all' : Number(amount) };
  const res = executeOrder(account, order, cfg);
  if (!res.ok) {
    console.error(`[${side}] 被拒绝：${res.reason}`);
    process.exitCode = 1;
    return;
  }
  saveAccount(account);
  console.log(`[${side}] ${res.fill.symbol} ${res.fill.qty}@${res.fill.price} 费 ${res.fill.fee}`);
  console.log(`  成交后：${summary(account)}`);
}

const HELP = `量化模拟盘 CLI（不连真钱）
  fetch <symbol> [interval] [limit]
  backtest <strategy> <symbol> [interval] [limit] [--fast=10 --slow=30 --lookback=20]
  account [--trades]
  buy <symbol> <notionalUsdt>
  sell <symbol> <qty|all>
策略：${STRATEGY_NAMES.join(', ')}`;

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  if (cmd === 'fetch') return cmdFetch({ positional: positional.slice(1), flags });
  if (cmd === 'backtest') return cmdBacktest({ positional: positional.slice(1), flags });
  if (cmd === 'account') return cmdAccount({ flags });
  if (cmd === 'buy') return cmdTrade({ positional: positional.slice(1), flags }, 'buy');
  if (cmd === 'sell') return cmdTrade({ positional: positional.slice(1), flags }, 'sell');
  console.error(`未知命令：${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error('[quant] 失败：', String(e?.message ?? e));
  process.exitCode = 1;
});
