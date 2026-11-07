// inori-adapt.js · 参数自适应：从"追了有没有用"里学自己的行为
//
// 这是三层学习里最硬的一层——它不是记录，是**改行为**。
// 规则（与用户口径一致）：
//   追了 ≥5 次且回报率 < 30% → 每天最多追 1 次（被无视就少追）
//   回报率 > 70%             → 放回 3 次
//   中间区间                 → 2 次（保守）
//   样本不足（<5）           → 不动，避免一两次偶发就改参数
//
// 纯函数，可复现；调用方负责落盘与日志。

export const DEFAULTS = {
  minSamples: 5,   // 少于这么多次不作判断
  lowRate: 0.3,    // 低于它 → 降到 lowMax
  highRate: 0.7,   // 高于它 → 回到 baseMax
  lowMax: 1,
  midMax: 2,
  baseMax: 3,
};

/**
 * @param {number} count     今天追了几次
 * @param {number} unanswered 其中没被回应的次数
 * @param {number} currentMax 当前每天上限
 * @returns {{ok:boolean, replyRate:number, maxPerDay:number, changed:boolean, reason:string}}
 */
export function computeChaseAdapt(count, unanswered, currentMax, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = Math.max(0, Number(count) || 0);
  const un = Math.min(Math.max(0, Number(unanswered) || 0), n);
  const cur = Math.max(1, Number(currentMax) || o.baseMax);
  const answered = Math.max(0, n - un);
  const rate = n > 0 ? answered / n : 0;

  if (n < o.minSamples) {
    return { ok: false, replyRate: rate, maxPerDay: cur, changed: false, reason: `insufficient(${n}/${o.minSamples})` };
  }
  let target;
  if (rate < o.lowRate) target = o.lowMax;
  else if (rate > o.highRate) target = o.baseMax;
  else target = o.midMax;
  target = Math.max(1, Math.min(o.baseMax, target));
  return {
    ok: true,
    replyRate: rate,
    maxPerDay: target,
    changed: target !== cur,
    reason: `rate=${(rate * 100).toFixed(0)}%(${answered}/${n})`,
  };
}

/** 给日志用的一行 */
export function describeAdapt(r) {
  if (!r) return '无数据';
  if (!r.ok) return `样本不足，保持 ${r.maxPerDay}（${r.reason}）`;
  return `回报率 ${(r.replyRate * 100).toFixed(0)}% → maxPerDay ${r.changed ? '调整为 ' : '保持 '}${r.maxPerDay}（${r.reason}）`;
}
