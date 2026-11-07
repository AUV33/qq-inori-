// self-thread.mjs · 宪章 §5.20：跨 idle 的"那根线"（此刻在想什么）
//
// 干什么：把内核的 selfThread（thought/at）+ 当前自我状态（情绪/精力/社交饥饿/注意力）
//   折成一张可读的连续自我卡片；久别重逢时能说清"刚还在想 X 的同一个她"。
//   同时给出 stale：离线太久时明确"线有点远了"，而不是假装刚才还在想。
// 为什么：T8/G28 的缺口是"跨沉默的体验连续"；没有 self-thread，重逢就是冷启动。
// 输入输出：纯函数；{kernelState,selfState,now} 进，卡片/一行文本出。
// 失败模式：缺字段按空/默认；不抛错。
// 不做什么：不写盘、不改内核状态、不生成叙事；只做读取与呈现。

import { sanitizePromptSnippet } from '../shared/prompt-safety.mjs';

export const SELF_THREAD_VERSION = 1;
export const SELF_THREAD_STALE_MS = 6 * 3600 * 1000;

function moodLabel(valence) {
  const v = Number(valence) || 0;
  if (v >= 0.25) return '轻快';
  if (v <= -0.25) return '低落';
  return '平稳';
}

function ageText(ms) {
  if (ms == null) return '';
  if (ms < 60 * 1000) return '（刚刚）';
  if (ms < 3600 * 1000) return `（${Math.round(ms / 60000)} 分钟前）`;
  if (ms < 24 * 3600 * 1000) return `（${Math.round(ms / 3600000)} 小时前）`;
  return `（${Math.round(ms / 86400000)} 天前）`;
}

/**
 * @param {{kernelState?:object|null, selfState?:object|null, now?:number, staleMs?:number}} input
 */
export function buildSelfThread({ kernelState, selfState, now = Date.now(), staleMs = SELF_THREAD_STALE_MS, fallbackThought = '', fallbackAt = 0 } = {}) {
  const k = kernelState && typeof kernelState === 'object' ? kernelState : {};
  const s = selfState && typeof selfState === 'object' ? selfState : {};
  // 内核 selfThread 为空时，宿主可传最近 thoughts 作为锚点兜底；渲染层仍按 stale 标注。
  const kernelThought = String(k.selfThread?.thought ?? '').trim();
  const thought = kernelThought || String(fallbackThought ?? '').trim();
  const thoughtAt = kernelThought ? (Number(k.selfThread?.at) || 0) : (Number(fallbackAt) || 0);
  const ageMs = thoughtAt > 0 ? Math.max(0, Number(now) - thoughtAt) : null;
  const stale = !thought || ageMs === null || ageMs > Number(staleMs);
  const affect = k.affect && typeof k.affect === 'object' ? k.affect : (s.affect && typeof s.affect === 'object' ? s.affect : {});
  const valence = Number.isFinite(Number(k.valence)) ? Number(k.valence) : Number(s.valence) || 0;
  const goals = Array.isArray(k.goals) ? k.goals : [];
  const activeGoals = goals.filter((g) => g && g.status !== 'done' && g.status !== 'dropped').slice(0, 3).map((g) => String(g.text ?? g.goal ?? '').slice(0, 60)).filter(Boolean);
  return {
    v: SELF_THREAD_VERSION,
    now: Number(now),
    thought,
    thoughtAt,
    thoughtAgeMs: ageMs,
    stale,
    staleReason: !thought ? 'no-thought' : (stale ? 'too-long' : 'fresh'),
    mood: moodLabel(valence),
    valence,
    affect,
    energy: Number.isFinite(Number(k.energy)) ? Number(k.energy) : Number(s.energy) || 0,
    socialHunger: Number.isFinite(Number(k.socialHunger)) ? Number(k.socialHunger) : Number(s.socialHunger) || 0,
    attention: Number.isFinite(Number(k.attention)) ? Number(k.attention) : null,
    activeGoals,
  };
}

/** 一行可注入文本；没有 thought 返回空串。stale 时明确“线有点远了”。 */
export function renderSelfThreadLine(thread) {
  if (!thread || !String(thread.thought ?? '').trim()) return '';
  const thought = sanitizePromptSnippet(thread.thought, { maxChars: 160 });
  if (!thought) return '';
  const age = ageText(thread.thoughtAgeMs);
  if (thread.stale) return `【上次离线时脑子里的那根线】${thought}${age}——隔得有点久了，别假装刚才还在想。`;
  return `【刚才在想的事】${thought}${age}`;
}
