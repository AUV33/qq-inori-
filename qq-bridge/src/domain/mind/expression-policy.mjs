// expression-policy.mjs · 表达策略：由内在状态/关系/场合决定“怎么发”（纯函数）
//
// 干什么：给出这一轮的发送意图：几条、大概多长、间隔、语气、是否带表情。
// 为什么：蓝图 C2——情绪/关系目前只影响“回不回”，不影响“怎么回”；发送层对 affect 全盲。
// 输入输出：纯函数；{self, belief, scene} 进，{messages, targetChars, delayMs, tone, emoji, reasons} 出。
// 失败模式：缺字段按默认；不抛错。
// 不做什么：不写文案、不调用模型、不直接发送；实际发送仍由 send 管线裁决。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.8 / C2

// [MOVE] §5.16：先把"这一下做什么动作"选出来，再由表达策略决定"怎么说"。
import { chooseMove } from '../conversation/move-selector.mjs';
// [TOM] 计划里带上意图候选与一行可读的读心（给日志/影子）。
import { inferIntent, renderIntentLine } from '../conversation/theory-of-mind.mjs';
// [GROUP-HEALTH] 计划里带一行群气氛（给日志/影子，不是命令）。
import { renderGroupHealthLine } from '../conversation/group-health.mjs';

export const EXPRESSION_POLICY_VERSION = 1;

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * @param {{self?:object|null, belief?:object|null, scene?:'private'|'group'|'task'|string}} input
 */
export function planExpression(input = {}) {
  const self = input.self && typeof input.self === 'object' ? input.self : {};
  const belief = input.belief && typeof input.belief === 'object' ? input.belief : {};
  const scene = typeof input.scene === 'string' && input.scene ? input.scene : 'private';
  const reasons = [];

  const group = scene === 'group';
  let messages = group ? 1 : 1;
  let targetChars = group ? 45 : 70;
  let delayMs = group ? 2500 : 1500;
  let tone = 'neutral';
  let emoji = false;

  const energy = num(self.energy, 0.6);
  const stress = num(self.stress, 0.1);
  const affection = num(self.affection ?? self.affect?.affection, 0);
  const anger = num(self.affect?.anger, 0);
  const affectionBond = num(belief.affinity, 0.5);

  if (stress >= 0.6 || anger >= 0.5) {
    targetChars = Math.min(targetChars, 40);
    delayMs += 1500;
    tone = 'serious';
    reasons.push('压力/火气高 → 话短、慢一点');
  }
  if (energy <= 0.3) {
    targetChars = Math.min(targetChars, 35);
    delayMs += 1200;
    reasons.push('精力低 → 话少');
  }
  if (affection >= 0.5 || affectionBond >= 0.7) {
    tone = stress >= 0.6 ? tone : 'warm';
    emoji = true;
    reasons.push('亲近 → 语气放软、可带表情');
  }
  if (group) {
    messages = 1;
    reasons.push('群聊 → 尽量一条说完');
  } else if (targetChars >= 60 && affection >= 0.3) {
    messages = 2;
    reasons.push('私聊且亲近 → 可以分两条');
  }

  return {
    v: EXPRESSION_POLICY_VERSION,
    scene,
    messages,
    targetChars: Math.round(clamp(targetChars, 20, 120)),
    delayMs: Math.round(clamp(delayMs, 500, 8000)),
    tone,
    emoji,
    reasons,
  };
}

/**
 * 动作 + 表达的一体化计划：先 chooseMove，再 planExpression；只给建议，不发送。
 * @param {{perception?:object|null, self?:object|null, belief?:object|null, bond?:object|null, scene?:string, text?:string, isOwner?:boolean}} input
 */
export function planResponse(input = {}) {
  const tom = inferIntent({ perception: input.perception, bond: input.bond ?? input.belief, text: input.text, scene: input.scene });
  const move = chooseMove({
    perception: input.perception,
    self: input.self,
    bond: input.bond ?? input.belief,
    scene: input.scene,
    text: input.text,
    isOwner: input.isOwner,
    budget: input.budget,
    groupHealth: input.groupHealth,
    tom,
  });
  const expression = planExpression({ self: input.self, belief: input.bond ?? input.belief, scene: input.scene });
  return {
    v: EXPRESSION_POLICY_VERSION,
    move,
    tom,
    intentLine: renderIntentLine(tom),
    expression,
    groupHealthLine: renderGroupHealthLine(input.groupHealth),
    reasons: [...move.reasons, ...expression.reasons],
  };
}
