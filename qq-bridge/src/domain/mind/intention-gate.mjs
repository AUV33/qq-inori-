// intention-gate.mjs · 把「意志」接到「要不要现在开口」的时机上（F1b / 蓝图 G4）
//
// 纯函数：不调模型、不读写文件。输入 meta-controller 的 selected 意图，
// 输出 { allow, boost, type, reason }：允许/拦截，以及给概率的缩放系数。
//
// 设计意图：主动性不再只由概率/定时器决定——她累到见底时不该在群里插话，
// 想整理/巩固时不该硬接话；有人直接对她说时则明确放行。

export const INTENTION_GATE_VERSION = 1;

const BLOCK = new Set(['rest', 'reflect', 'consolidate']);

/**
 * @param {{selected?:object|null}|null} result selectIntention 的返回
 * @param {{scope?:string}} opts
 */
export function gateProactive(result, { scope = 'join' } = {}) {
  const sel = result && result.selected && typeof result.selected === 'object' ? result.selected : null;
  if (!sel) {
    return { v: INTENTION_GATE_VERSION, allow: true, boost: 1, type: null, scope, reason: '没有明确意图，交给概率' };
  }
  const type = String(sel.type || '');
  const reason = String(sel.reason || type || '');
  if (BLOCK.has(type)) {
    return { v: INTENTION_GATE_VERSION, allow: false, boost: 0, type, scope, reason };
  }
  let boost = 1;
  if (type === 'reply') boost = 1.8;
  else if (type === 'initiate') boost = 1.3;
  else if (type === 'repair') boost = 1.1;
  else if (type === 'explore') boost = 1.0;
  return { v: INTENTION_GATE_VERSION, allow: true, boost, type, scope, reason };
}
