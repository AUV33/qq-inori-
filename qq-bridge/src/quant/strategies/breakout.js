// quant/strategies/breakout.js · 唐奇安通道突破
//
// 收盘价突破前 lookback 根的最高价 → 买；跌破前 lookback 根的最低价 → 卖。
// 比双均线更"追涨杀跌"，用来对比同一段行情下两种风格的成本与回撤。

export function breakoutStrategy({ lookback = 20 } = {}) {
  const n = Math.max(5, Math.round(Number(lookback) || 20));
  return {
    name: `breakout(${n})`,
    onBar({ bars, i, account, symbol }) {
      if (i <= n) return null;
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - n; k < i; k += 1) {
        if (Number(bars[k].high) > hi) hi = Number(bars[k].high);
        if (Number(bars[k].low) < lo) lo = Number(bars[k].low);
      }
      const close = Number(bars[i].close);
      const held = Number(account.positions[symbol]?.qty ?? 0) > 0;
      if (!held && close > hi) return { action: 'buy', fraction: 1 };
      if (held && close < lo) return { action: 'sell', fraction: 1 };
      return null;
    },
  };
}
