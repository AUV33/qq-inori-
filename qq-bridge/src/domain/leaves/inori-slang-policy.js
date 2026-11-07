// [SLANG-POLICY] 黑话提取的触发策略：普通按冷却走，出现「生词信号」时提前。
//
// 背景：黑话提取是模型调用（一次提取 = 一个隔离会话 + 多步），15 分钟一开太烧，
// 60 分钟一开又会让群里刚冒出来的新词最晚一小时才进库。这里把「什么时候开」
// 抽成纯函数：窗口里有 ≥N 条消息都在用、且不在词库/经验里的词 → urgent，
// 10 分钟就能再提一次；没有生词就按普通冷却（默认 60 分钟）。
//
// 纯函数、零状态：lastAt / hourStart / hourCount 由调用方持有并回写 next。
import { findUnknown } from './inori-gloss.js';

export const SLANG_POLICY_DEFAULTS = Object.freeze({
  urgentCooldownMs: 10 * 60 * 1000,
  maxPerHour: 3,
  urgentMinMessages: 3,
});

/**
 * 判断这次新消息是否该触发一次黑话提取。
 * @param {{lastAt?:number, hourStart?:number, hourCount?:number}} state 调用方持有的每群状态
 * @param {{now:number, messageCount:number, minMessages:number, cooldownMs:number,
 *          urgentCooldownMs?:number, urgent?:boolean, maxPerHour?:number}} opts
 * @returns {{extract:boolean, reason:string, next:{lastAt:number, hourStart:number, hourCount:number}}}
 */
export function decideSlangExtraction(state, opts = {}) {
  const now = Number(opts.now) || 0;
  const messageCount = Math.max(0, Number(opts.messageCount) || 0);
  const minMessages = Math.max(1, Number(opts.minMessages) || 1);
  const cooldownMs = Math.max(0, Number(opts.cooldownMs) || 0);
  const urgentCooldownMs = Math.max(0, Number(opts.urgentCooldownMs ?? SLANG_POLICY_DEFAULTS.urgentCooldownMs));
  const maxPerHour = Math.max(1, Number(opts.maxPerHour) || SLANG_POLICY_DEFAULTS.maxPerHour);
  const urgent = opts.urgent === true;

  const prev = state && typeof state === 'object' ? state : {};
  const lastAt = Number(prev.lastAt) || 0;
  let hourStart = Number(prev.hourStart) || now;
  let hourCount = Math.max(0, Number(prev.hourCount) || 0);
  if (now - hourStart >= 3600_000) {
    hourStart = now;
    hourCount = 0;
  }
  const base = { lastAt, hourStart, hourCount };
  const bumped = { lastAt: now, hourStart, hourCount: hourCount + 1 };

  if (messageCount < minMessages) return { extract: false, reason: 'too-few', next: base };

  const since = now - lastAt;
  if (since >= cooldownMs) return { extract: true, reason: 'regular', next: bumped };

  if (urgent && since >= urgentCooldownMs) {
    if (hourCount >= maxPerHour) return { extract: false, reason: 'hour-cap', next: base };
    return { extract: true, reason: 'urgent', next: bumped };
  }

  return { extract: false, reason: urgent ? 'urgent-cooldown' : 'cooldown', next: base };
}

/**
 * 窗口里有没有「生词信号」：出现 ≥minMessages 条消息、且不在 knownText 里的词。
 * 复用 inori-gloss 的提取规则（STOP/词界/碎屑过滤都在那边）；出错按「没有」处理，绝不挡主路。
 * @param {Array<{text?:string, plain?:string}>} messages
 * @param {string} knownText 已知词全文（黑话库 + 经验）
 * @param {{minMessages?:number}} opts
 * @returns {boolean}
 */
export function hasUrgentSignal(messages, knownText, opts = {}) {
  const minMessages = Math.max(2, Number(opts.minMessages) || SLANG_POLICY_DEFAULTS.urgentMinMessages);
  try {
    return findUnknown(messages, knownText, { minMessages, limit: 1 }).length > 0;
  } catch {
    return false;
  }
}
