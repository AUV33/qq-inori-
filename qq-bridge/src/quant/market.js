// quant/market.js · 只读行情（Binance 公共数据域，无需 API key）
//
// 边界：
//   1) 只读，不下单、不碰账户；
//   2) 域名白名单在 config.js 里，这里只拼 path；
//   3) 网络失败时回退本地缓存并标 stale=true，绝不因为一次断网让回测崩掉；
//   4) fetch 可注入，单测不联网。

import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../domain/shared/project-paths.js';
import { writeJsonAtomic } from './store.js';

// 默认落在 data/state/quant/cache；沙箱/测试可用 QQ_INORI_QUANT_DIR 改根目录
export const DEFAULT_CACHE_DIR = process.env.QQ_INORI_QUANT_DIR
  ? path.join(process.env.QQ_INORI_QUANT_DIR, 'cache')
  : stateDataPath('quant', 'cache');

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;
const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);

export function assertSymbol(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new Error(`非法交易对: ${symbol}`);
  return s;
}

export function assertInterval(interval) {
  const i = String(interval ?? '');
  if (!INTERVALS.has(i)) throw new Error(`非法 K 线周期: ${interval}`);
  return i;
}

/** 带超时的 GET JSON；非 2xx 抛错 */
export async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Binance kline 数组 → 归一化 bar（价格都是 Number，时间戳 ms） */
export function parseKlines(raw) {
  if (!Array.isArray(raw)) throw new Error('klines 响应不是数组');
  return raw.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  })).filter((b) => Number.isFinite(b.close) && b.close > 0);
}

function cacheFile({ symbol, interval, cacheDir = DEFAULT_CACHE_DIR }) {
  return path.join(cacheDir, `${symbol}_${interval}.json`);
}

export function readCachedKlines({ symbol, interval, cacheDir = DEFAULT_CACHE_DIR }) {
  const file = cacheFile({ symbol: assertSymbol(symbol), interval: assertInterval(interval), cacheDir });
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(j.bars) || !j.bars.length) return null;
    return { symbol: j.symbol, interval: j.interval, bars: j.bars, fetchedAt: Number(j.fetchedAt) || 0 };
  } catch {
    return null;
  }
}

/**
 * 抓 K 线：成功则写缓存；失败则回退缓存。
 * @returns {{bars:Array, source:'network'|'cache', stale:boolean, fetchedAt:number}}
 */
export async function getKlines({
  symbol, interval = '1h', limit = 500,
  baseUrl = 'https://data-api.binance.vision',
  cacheDir = DEFAULT_CACHE_DIR,
  fetchImpl = fetch,
  timeoutMs = 8000,
  now = Date.now(),
} = {}) {
  const sym = assertSymbol(symbol);
  const itv = assertInterval(interval);
  const n = Math.max(1, Math.min(1000, Math.round(Number(limit) || 500)));
  const url = `${baseUrl}/api/v3/klines?symbol=${sym}&interval=${itv}&limit=${n}`;

  try {
    const raw = await fetchJson(url, { fetchImpl, timeoutMs });
    const bars = parseKlines(raw);
    if (!bars.length) throw new Error('行情返回空');
    const payload = { symbol: sym, interval: itv, fetchedAt: now, bars };
    writeJsonAtomic(cacheFile({ symbol: sym, interval: itv, cacheDir }), payload);
    return { bars, source: 'network', stale: false, fetchedAt: now };
  } catch (e) {
    const cached = readCachedKlines({ symbol: sym, interval: itv, cacheDir });
    if (cached) return { bars: cached.bars, source: 'cache', stale: true, fetchedAt: cached.fetchedAt, error: String(e?.message ?? e) };
    throw new Error(`行情抓取失败且无缓存: ${sym} ${itv} — ${String(e?.message ?? e)}`);
  }
}

/** 最新价（24h ticker） */
export async function getTicker({
  symbol, baseUrl = 'https://data-api.binance.vision',
  fetchImpl = fetch, timeoutMs = 8000,
} = {}) {
  const sym = assertSymbol(symbol);
  const j = await fetchJson(`${baseUrl}/api/v3/ticker/24hr?symbol=${sym}`, { fetchImpl, timeoutMs });
  const price = Number(j?.lastPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`ticker 无有效价格: ${sym}`);
  return {
    symbol: sym,
    price,
    changePct: Number(j?.priceChangePercent),
    high: Number(j?.highPrice),
    low: Number(j?.lowPrice),
    volume: Number(j?.volume),
  };
}

/** 交易规则（步长/最小价格/最小名义），下单校验用 */
export async function getSymbolRules({
  symbol, baseUrl = 'https://data-api.binance.vision',
  fetchImpl = fetch, timeoutMs = 8000,
} = {}) {
  const sym = assertSymbol(symbol);
  const j = await fetchJson(`${baseUrl}/api/v3/exchangeInfo?symbol=${sym}`, { fetchImpl, timeoutMs });
  const s = j?.symbols?.[0];
  if (!s) throw new Error(`exchangeInfo 没有 ${sym}`);
  const f = (type) => (s.filters ?? []).find((x) => x.filterType === type) ?? {};
  const lot = f('LOT_SIZE');
  const priceFilter = f('PRICE_FILTER');
  const notional = f('NOTIONAL');
  return {
    symbol: sym,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    stepSize: Number(lot.stepSize ?? 0.00001) || 0.00001,
    minQty: Number(lot.minQty ?? 0),
    tickSize: Number(priceFilter.tickSize ?? 0.01) || 0.01,
    minNotional: Number(notional.minNotional ?? 5) || 5,
  };
}
