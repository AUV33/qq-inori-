// inori-reflect.js · 夜间反思的纯逻辑部分
//
// 为什么需要「确定性触发」：实测 qq_memory_append / lesson_write 这些写入工具的
// 调用次数都是 0 —— 依赖模型自觉 = 永远是 0。所以反思必须由 harness 定时发起，
// 并且**检查产出**（lesson 条数有没有增加），不能只看"叫过了"。
//
// 本模块只做纯计算（时间窗判断、提示词构造、产出对比），
// 真正的投递与落盘由桥接调用现有路径完成。

import { loadText } from './inori-prompts.js';

// [PROMPTS] 兜底文本（data/prompts/reflect.md 缺失时用）：只做一件事，不凑数。
export const DEFAULT_REFLECT_GUIDE = [
  '今天不用汇报，也不用凑数。只想一件事：',
  '今天有没有哪条判断被证明是对的，或者被现实打脸？',
  '- 有：用 lesson_write 记一条，最多一条。写「什么情况下、我怎么判断、后来发生了什么」。',
  '  关于他/关系/人的判断，track 写 reading，并补一句反例/例外。',
  '  如果能反复用、以后都成立，再用 cognition_save 记成认知（必须写清 when）。',
  '- 没有：什么都别写，回一句「今天没有」就结束。',
  '',
  '不要整理目标，不要写群学习，不要复盘操作，不要为了完成反思硬写。',
].join('\n');

export const DEFAULTS = {
  hourStart: 2,        // 反思窗口开始（本地时间，整点）
  hourEnd: 5,          // 结束
  minLessons: 0,       // 不设最低产出：今天没有就是没有
  maxLessons: 1,       // 最多一条判断
  cooldownHours: 20,   // 两次反思至少隔多久（防同一天重复跑）
};

/**
 * 现在该不该跑反思。
 * @param {Date} now
 * @param {number|null} lastRunAt 上次成功的毫秒时间戳
 * @param {object} opts
 * @returns {{run:boolean, reason:string}}
 */
export function shouldRun(now, lastRunAt, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const hour = now.getHours();
  if (hour < o.hourStart || hour >= o.hourEnd) return { run: false, reason: `outside-window(${hour}h)` };
  if (lastRunAt) {
    const gapH = (now.getTime() - lastRunAt) / 3600000;
    if (gapH < o.cooldownHours) return { run: false, reason: `cooldown(${gapH.toFixed(1)}h<${o.cooldownHours}h)` };
  }
  return { run: true, reason: 'ok' };
}

/**
 * 构造反思提示词。给出明确产出要求与格式，避免她又去"回消息"。
 * @param {{date:string, lessonCount:number, recentCount:number, memoryCount:number}} stats
 */
export function buildPrompt(stats, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const s = stats ?? {};
  return [
    `【夜间反思 · ${s.date ?? ''}】`,
    '现在不聊天，也没人等你回话。做一件事就好：把今天想明白的东西记下来。',
    '',
    `现在你攒了 ${s.lessonCount ?? 0} 条经验，今天有过 ${s.recentCount ?? 0} 条对话、${s.memoryCount ?? 0} 条记忆。`,
    '',
    loadText('reflect', DEFAULT_REFLECT_GUIDE)
      .replace(/\{\{minLessons\}\}/g, String(o.minLessons))
      .replace(/\{\{maxLessons\}\}/g, String(o.maxLessons)),
  ].join('\n');
}

/**
 * 反思产出检查：对比跑之前的条数。
 * @returns {{ok:boolean, added:number, reason:string}}
 */
export function checkOutcome(beforeCount, afterCount, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const added = Math.max(0, Number(afterCount) - Number(beforeCount));
  // [TRUTH] 这条检查存在的意义就是「不能只看叫过了」：一条都没产出必须算失败，
  // 否则 minLessons 默认 0 时 `added >= 0` 恒真 → 反思永远报成功、重试路径永不触发。
  if (added > 0 && added >= o.minLessons) return { ok: true, added, reason: 'enough' };
  if (added > 0) return { ok: false, added, reason: `partial(${added}<${o.minLessons})` };

  // [THOUGHT-TRUTH] 三分类，别把「想了但没写工具」当成「没想」。
  // 实测 2026-11-03：反思整夜 18 次 reason=none、thought=null，但 11-04 日志里
  // 有 `[focus] 本轮反思没有【FOCUS】块` —— 她确实输出了文本，只是没调用 lesson_write。
  // 旧口径把这种情况判为失败并无限重试到「今夜用尽」，既烧钱又让成长维恒为 0。
  const t = o.thought;
  const hasThought = t && t.kind === 'completed' && Number(t.len) > 0
    && (!o.sessionId || !t.sessionId || t.sessionId === o.sessionId);
  if (hasThought) {
    return {
      ok: false, added: 0, reason: 'thought-only', settled: true,
      // 她的原话是事实，框架不替她生成 lesson 内容，只留存并让她下次看得见。
      thought: { kind: t.kind, len: Number(t.len) || 0, head: String(t.head || '').slice(0, 200), sessionId: t.sessionId || null },
    };
  }
  return { ok: false, added: 0, reason: 'no-turn', settled: false };
}
