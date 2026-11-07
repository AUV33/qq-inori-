// attention-bias.mjs · 注意力门的“内在偏置”（纯函数）
//
// 干什么：把 SelfState 与 PersonBelief 折算成注意门阈值的一个小偏置：
//   精力低/压力高 → 阈值上调（更保守）；社交饥饿/关系近/有未解之事 → 阈值下调（更愿意接）。
// 为什么：蓝图 C1——门是“要不要醒”的第一道闸，现状对情绪/关系/记忆全盲（软提示架构）。
// 输入输出：纯函数；无数据返回 bias 0。
// 失败模式：脏字段按缺失；偏置硬夹在 ±0.04，绝不主导判定。
// 不做什么：不读文件、不调用模型、不决定是否唤醒（只给阈值加减）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.5 / C1

export const ATTENTION_BIAS_VERSION = 1;
export const MAX_BIAS = 0.04;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {{self?:object|null, belief?:object|null, scene?:string}} input
 * @returns {{bias:number, reasons:string[]}}
 */
export function computeAttentionBias(input = {}) {
  const self = input.self && typeof input.self === 'object' ? input.self : null;
  const belief = input.belief && typeof input.belief === 'object' ? input.belief : null;
  let bias = 0;
  const reasons = [];

  if (self) {
    const energy = num(self.energy);
    const stress = num(self.stress);
    const hunger = num(self.socialHunger);
    if (energy !== null && energy <= 0.3) { bias += 0.015; reasons.push('精力低→更保守'); }
    if (stress !== null && stress >= 0.6) { bias += 0.015; reasons.push('压力高→更保守'); }
    if (hunger !== null && hunger >= 0.65) { bias -= 0.015; reasons.push('想找人说话→更愿意接'); }
  }

  if (belief) {
    // 群信念没有 affinity/trust：用 acceptance（这个群接纳她的程度）作为关系代理
    const acceptance = num(belief.acceptance);
    if (acceptance !== null && acceptance >= 0.65) { bias -= 0.01; reasons.push('这个群接纳她→更关注'); }
    const affinity = num(belief.affinity);
    const trust = num(belief.trust);
    if (affinity !== null && affinity >= 0.65) { bias -= 0.015; reasons.push('关系近→更关注'); }
    if (trust !== null && trust <= 0.3) { bias += 0.015; reasons.push('信任低→更谨慎'); }
    const loops = Array.isArray(belief.openLoops) ? belief.openLoops.filter((l) => l && l.status === 'open') : [];
    if (loops.length > 0) { bias -= 0.01; reasons.push('有未解之事→多留意'); }
  }

  const clamped = Math.max(-MAX_BIAS, Math.min(MAX_BIAS, bias));
  return { bias: Number(clamped.toFixed(4)), reasons };
}
