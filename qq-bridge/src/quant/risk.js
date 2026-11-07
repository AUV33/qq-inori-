// quant/risk.js · 下单风控（纯函数）
//
// 这些规则不是"建议"，是硬拦截：模拟账户和（未来的）真钱账户走同一套 checkRisk。
// 故意保守：100 元本金下，单仓最多 50%（≈7 USDT）、日亏 10% 停买、每天最多 10 笔。

const EPS = 1e-9;

export function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** 跨日重置当日统计（startEquity 用当日第一笔前的净值） */
export function rollDay(account, ts, equityNow) {
  const key = dayKey(ts);
  if (!account.day || account.day.date !== key) {
    account.day = { date: key, startEquity: Number(equityNow) || 0, trades: 0 };
  }
  return account.day;
}

/**
 * 买入前检查。卖出永远放行（只受持仓数量约束，在 paper 里校验）。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkRisk(account, cfg, { side, symbol, notional, price, equityNow } = {}) {
  if (String(side) !== 'buy') return { ok: true };

  const risk = cfg?.risk ?? {};
  const equity = Number(equityNow);
  if (!Number.isFinite(equity) || equity <= 0) return { ok: false, reason: '净值无效' };

  // 注意：跨日重置由 executeOrder 用**订单时间戳**做，这里不再调 rollDay——
  // 否则回测里 Date.now() 会把 day 重置成"今天"，日交易上限与日亏损限制全部失效。

  const maxTrades = Number(risk.maxTradesPerDay ?? 10);
  if ((account.day?.trades ?? 0) >= maxTrades) {
    return { ok: false, reason: `今日成交已达 ${maxTrades} 笔上限` };
  }

  const maxLossPct = Number(risk.maxDailyLossPct ?? 0.1);
  const startEquity = Number(account.day?.startEquity ?? equity);
  if (startEquity > 0 && (startEquity - equity) / startEquity >= maxLossPct - EPS) {
    return { ok: false, reason: `今日亏损已达 ${(maxLossPct * 100).toFixed(0)}% 上限，停止买入` };
  }

  const positions = account.positions ?? {};
  const held = positions[symbol]?.qty ?? 0;
  const maxOpen = Number(risk.maxOpenPositions ?? 2);
  if (held <= EPS && Object.keys(positions).length >= maxOpen) {
    // 提示里要用**解析后的**上限，否则默认值情况下会写出「已达 undefined 个上限」
    return { ok: false, reason: `持仓数已达 ${maxOpen} 个上限` };
  }

  const maxPct = Number(risk.maxPositionPct ?? 0.5);
  const currentValue = held > 0 ? held * Number(price) : 0;
  const projected = currentValue + Number(notional);
  if (projected > equity * maxPct + 1e-6) {
    return { ok: false, reason: `单仓将达 ${(projected / equity * 100).toFixed(1)}%，超过 ${(maxPct * 100).toFixed(0)}% 上限` };
  }

  return { ok: true };
}
