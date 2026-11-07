// quality-policy.mjs · 质量趋势 → 主动性调节（C4 第二半，纯函数）
//
// 干什么：把“真漏接率 / 有意不回率 / 被接住率”折算成可解释的调节量。
//   - 没回合（noTurn）→ 真漏接，偏 caution；
//   - 回合但 no_action（turnOther）→ 有意不回，只作 watch；
//   - 被接住率低 → 主动收着点。
// 为什么：直接拿 missedRate 会把“忙/有意不回”当真漏接，阈值会被噪声带偏。
// 输入输出：纯函数；指标进，{level, initiativeScale, gateThresholdDelta, reasons} 出。
// 失败模式：无样本 → unknown，调节中性。
// 不做什么：不直接改配置/热路径；调用方决定是否应用。

export const QUALITY_POLICY_VERSION = 2;

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function decideQualityPolicy(metrics = {}, opts = {}) {
  const noTurnCaution = Number.isFinite(opts.noTurnCaution) ? opts.noTurnCaution : 0.25;
  const noTurnWatch = Number.isFinite(opts.noTurnWatch) ? opts.noTurnWatch : 0.12;
  const turnOtherCaution = Number.isFinite(opts.turnOtherCaution) ? opts.turnOtherCaution : 0.6;
  const turnOtherWatch = Number.isFinite(opts.turnOtherWatch) ? opts.turnOtherWatch : 0.4;
  const caughtCaution = Number.isFinite(opts.caughtCaution) ? opts.caughtCaution : 0.15;
  const caughtWatch = Number.isFinite(opts.caughtWatch) ? opts.caughtWatch : 0.25;
  const minSamples = Number.isFinite(opts.minSamples) ? opts.minSamples : 5;

  const samples = Number(metrics.samples) || 0;
  if (metrics.noData === true || samples < minSamples) {
    return { v: QUALITY_POLICY_VERSION, level: 'unknown', initiativeScale: 1, gateThresholdDelta: 0, reasons: ['样本不足，不做调节'] };
  }

  const noTurn = clamp01(metrics.noTurnRate ?? metrics.missedRate);
  const turnOther = clamp01(metrics.turnOtherRate ?? 0);
  const caught = metrics.caughtRate === undefined ? null : clamp01(metrics.caughtRate);
  const reasons = [];
  let level = 'normal';
  let initiativeScale = 1;

  const caution = noTurn >= noTurnCaution || turnOther >= turnOtherCaution || (caught !== null && caught <= caughtCaution);
  const watch = noTurn >= noTurnWatch || turnOther >= turnOtherWatch || (caught !== null && caught <= caughtWatch);
  if (caution) {
    level = 'caution';
    initiativeScale = caught !== null && caught <= caughtCaution ? 0.7 : 0.85;
    if (noTurn >= noTurnCaution) reasons.push('真漏接率偏高 → 先排查调度（' + noTurn.toFixed(2) + '）');
    if (turnOther >= turnOtherCaution) reasons.push('有意不回率偏高 → 复查判定（' + turnOther.toFixed(2) + '）');
    if (caught !== null && caught <= caughtCaution) reasons.push('被接住率低 → 主动收着点（' + caught.toFixed(2) + '）');
  } else if (watch) {
    level = 'watch';
    initiativeScale = 0.9;
    reasons.push('质量信号偏弱（真漏接 ' + noTurn.toFixed(2) + ' / 有意不回 ' + turnOther.toFixed(2) + ' / 被接住 ' + (caught === null ? '-' : caught.toFixed(2)) + '）');
  } else {
    reasons.push('质量信号正常');
  }

  return { v: QUALITY_POLICY_VERSION, level, initiativeScale, gateThresholdDelta: 0, reasons };
}
