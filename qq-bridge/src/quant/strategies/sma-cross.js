// quant/strategies/sma-cross.js · 双均线（趋势过滤）
//
// 语义：快线在慢线上方 = 持有；下方 = 空仓。
// 这样在单调趋势里也能在预热结束后进场，而不是死等一个可能永远不出现的"交叉瞬间"。
// 只作参考实现：它的价值不是能赚钱，而是给回测一个已知行为的基线。

function avgClose(bars, from, to) {
  let sum = 0;
  for (let i = from; i <= to; i += 1) sum += Number(bars[i].close);
  return sum / (to - from + 1);
}

export function smaCrossStrategy({ fast = 10, slow = 30 } = {}) {
  const f = Math.max(2, Math.round(Number(fast) || 10));
  const s = Math.max(f + 1, Math.round(Number(slow) || 30));
  return {
    name: `sma-cross(${f},${s})`,
    onBar({ bars, i, account, symbol }) {
      if (i < s) return null;
      const fastNow = avgClose(bars, i - f + 1, i);
      const slowNow = avgClose(bars, i - s + 1, i);
      const above = fastNow > slowNow;
      const held = Number(account.positions[symbol]?.qty ?? 0) > 0;
      if (above && !held) return { action: 'buy', fraction: 1 };
      if (!above && held) return { action: 'sell', fraction: 1 };
      return null;
    },
  };
}
