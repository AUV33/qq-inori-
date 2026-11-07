// interaction-shadow.mjs · 宪章 S8e/S8f：把“建议”做成一行可测的结构化影子（不发送）
//
// 干什么：给定感知 + 自我 + 关系 + 最近消息，算出 ToM/动作/群状态/预算/退场的建议行；
//   纯函数，可单测；宿主只负责决定是否写盘（默认关闭）。
// 为什么：影子建议账逻辑此前嵌在唤醒服务里，只能静态断言；抽出来后可以直接验证
//   “同一条消息，在 @她/min-gap/群气氛紧时分别会建议什么”。
// 输入输出：纯函数；不读盘、不发送、不写 prompt。
// 失败模式：无 perception 返回 null；坏字段按默认。
// 不做什么：不落原文、不落会话 key 原文（keyHash 由宿主传）。

import crypto from 'node:crypto';
import { evaluateGroupState, evaluateInteractionBudget, shouldWithdraw } from './group-health.mjs';
import { planResponse } from '../mind/expression-policy.mjs';

export const INTERACTION_SHADOW_VERSION = 1;

export function keyHashOf(key) {
  return crypto.createHash('sha1').update(String(key ?? '')).digest('hex').slice(0, 12);
}

/**
 * @param {{keyHash?:string, perception?:object|null, self?:object|null, bond?:object|null,
 *          scene?:'private'|'group', recentMessages?:Array, now?:number, text?:string}} input
 */
export function buildShadowRow(input = {}) {
  const perception = input.perception && typeof input.perception === 'object' ? input.perception : null;
  if (!perception) return null;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const scene = input.scene === 'group' ? 'group' : 'private';
  const recent = Array.isArray(input.recentMessages) ? input.recentMessages : [];
  const groupHealth = scene === 'group' ? evaluateGroupState({ messages: recent, now }) : null;
  const herMessages = recent.filter((m) => m && m.isSelf === true && Number.isFinite(Number(m.time)));
  const budget = evaluateInteractionBudget({ spokeAt: herMessages.map((m) => Number(m.time)), now });
  const lastSelfAt = herMessages.reduce((t, m) => Math.max(t, Number(m.time) || 0), 0);
  const othersAfter = recent.filter((m) => m && !m.isSelf && Number(m.time) > lastSelfAt).length;
  const withdraw = shouldWithdraw({ herMessages, othersAfter, now });
  const plan = planResponse({
    perception,
    self: input.self || null,
    bond: input.bond || null,
    scene,
    text: String(input.text ?? ''),
    groupHealth,
    budget,
  });
  return {
    v: INTERACTION_SHADOW_VERSION,
    at: now,
    keyHash: String(input.keyHash || ''),
    addressee: perception.addressee,
    speechAct: perception.speechAct,
    intent: plan.tom?.intent,
    intentConfidence: plan.tom?.confidence,
    move: plan.move?.move,
    explicitness: plan.move?.explicitness,
    confidence: plan.move?.confidence,
    group: groupHealth ? { label: groupHealth.label, health: groupHealth.health, negativeRate: groupHealth.negativeRate } : null,
    budget: { allowed: budget.allowed, reason: budget.reason },
    withdraw: { withdraw: withdraw.withdraw, reason: withdraw.reason },
  };
}
