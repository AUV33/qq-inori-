// quant/config.js · 量化模块的配置默认值与解析（纯函数，无 IO）
//
// 设计约束：
//   1) 默认**关闭**（enabled=false）：没被主人打开前，任何自主下单循环都不跑；
//   2) 100 元本金与真钱对齐：initialCapitalCny=100 + cnyPerUsdt=7.1 → 约 14.08 USDT；
//   3) 风控上限写死在默认值里，改配置也要过 resolveQuantConfig 的夹取；
//   4) 行情只允许白名单域名（目前只有 Binance 公共数据域），防止配置被改成任意 URL。

export const QUANT_DEFAULTS = Object.freeze({
  enabled: false,
  market: 'crypto',
  dataBaseUrl: 'https://data-api.binance.vision',
  quote: 'USDT',
  initialCapitalCny: 100,
  cnyPerUsdt: 7.1,
  feeRate: 0.001,        // 0.1% taker
  slippageBps: 5,        // 5 bps = 0.05%
  minNotionalUsdt: 5,    // Binance NOTIONAL 过滤器
  requestTimeoutMs: 8000,
  risk: Object.freeze({
    maxPositionPct: 0.5,   // 单仓不超过净值的 50%（14 USDT 下最多 7 USDT）
    maxDailyLossPct: 0.1,  // 单日亏 10% 停买
    maxTradesPerDay: 10,   // 每天最多 10 笔成交
    maxOpenPositions: 2,   // 最多同时持有 2 个币种
  }),
});

export const ALLOWED_DATA_HOSTS = Object.freeze(['data-api.binance.vision']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function num(value, fallback, lo = -Infinity, hi = Infinity) {
  // [NULL-IS-UNSET] 显式 null/空串按"没写"处理：否则 Number(null)=0 会让
  // feeRate/slippageBps 静默变成 0（等于免手续费、无滑点），与"刻意保守"的成交模型相反。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, lo, hi);
}

/** 只允许白名单域名，且必须是 https */
export function assertDataBaseUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`quant.dataBaseUrl 不是合法 URL: ${url}`); }
  if (u.protocol !== 'https:') throw new Error('quant.dataBaseUrl 必须是 https');
  if (!ALLOWED_DATA_HOSTS.includes(u.hostname)) {
    throw new Error(`quant.dataBaseUrl 域名不在白名单: ${u.hostname}（允许：${ALLOWED_DATA_HOSTS.join(', ')}）`);
  }
  return u.origin;
}

/**
 * 把 config.json 里的 quant 块与默认值合并并夹取。
 * 任何非法值都退回默认，不抛错（除 dataBaseUrl 越界，那属于配置错误要显式报）。
 */
export function resolveQuantConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const risk = r.risk && typeof r.risk === 'object' ? r.risk : {};
  const out = {
    enabled: r.enabled === true,
    market: r.market === 'crypto' ? 'crypto' : QUANT_DEFAULTS.market,
    dataBaseUrl: assertDataBaseUrl(r.dataBaseUrl ?? QUANT_DEFAULTS.dataBaseUrl),
    quote: String(r.quote ?? QUANT_DEFAULTS.quote).toUpperCase(),
    initialCapitalCny: num(r.initialCapitalCny, QUANT_DEFAULTS.initialCapitalCny, 1, 1_000_000),
    cnyPerUsdt: num(r.cnyPerUsdt, QUANT_DEFAULTS.cnyPerUsdt, 0.01, 1000),
    feeRate: num(r.feeRate, QUANT_DEFAULTS.feeRate, 0, 0.05),
    slippageBps: num(r.slippageBps, QUANT_DEFAULTS.slippageBps, 0, 500),
    minNotionalUsdt: num(r.minNotionalUsdt, QUANT_DEFAULTS.minNotionalUsdt, 0, 1_000_000),
    requestTimeoutMs: num(r.requestTimeoutMs, QUANT_DEFAULTS.requestTimeoutMs, 1000, 60_000),
    risk: {
      maxPositionPct: num(risk.maxPositionPct, QUANT_DEFAULTS.risk.maxPositionPct, 0.01, 1),
      maxDailyLossPct: num(risk.maxDailyLossPct, QUANT_DEFAULTS.risk.maxDailyLossPct, 0.01, 1),
      maxTradesPerDay: Math.round(num(risk.maxTradesPerDay, QUANT_DEFAULTS.risk.maxTradesPerDay, 1, 1000)),
      maxOpenPositions: Math.round(num(risk.maxOpenPositions, QUANT_DEFAULTS.risk.maxOpenPositions, 1, 50)),
    },
  };
  return out;
}

/** 100 元人民币按汇率折算成计价币（默认 USDT） */
export function cnyToQuote(cny, cfg) {
  return Number((Number(cny) / cfg.cnyPerUsdt).toFixed(8));
}
