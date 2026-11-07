// group-health.mjs · 宪章 §5.14/§5.15：群状态、关系健康、互动预算、退场
//
// 干什么：从最近消息折出群健康（活跃/平衡/负性/新鲜度），给出互动预算（限频/最小间隔）
//   与退场判断（她说太多/没人接/沉默够久）；都是纯函数，供动作层与影子日志使用。
// 为什么：交互层缺失时只有"回不回"，没有"这个群现在什么气氛、我该不该再说、该不该退"。
//   群不是私聊的放大版：抢话、冷场、互怼都需要不同的动作。
// 输入输出：纯函数；缺字段按默认；不读盘、不调模型。
// 失败模式：空消息返回 cold/unknown；不抛错。
// 不做什么：不判定"谁对谁错"、不生成文本、不直接发送。

export const GROUP_HEALTH_VERSION = 1;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function senderKey(msg) {
  return String(msg?.userId ?? msg?.sender ?? '') || 'unknown';
}

/**
 * @param {{messages:Array, now?:number, windowMs?:number, staleMs?:number}} input
 */
export function evaluateGroupState({ messages, now = Date.now(), windowMs = 30 * 60 * 1000, staleMs = 24 * 3600 * 1000 } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  const recent = rows.filter((m) => !Number.isFinite(Number(m.time)) || Number(now) - Number(m.time) <= windowMs);
  const total = recent.length;
  const participants = new Set(recent.map(senderKey).filter((k) => k && k !== 'unknown'));
  const selfMessages = recent.filter((m) => m.isSelf === true).length;
  const negative = recent.filter((m) => String(m.tone ?? m.polarity ?? '') === 'neg').length;
  const questions = recent.filter((m) => /[?？]|吗|呢|怎么|什么/.test(String(m.text ?? m.plain ?? ''))).length;
  const lastAt = rows.reduce((t, m) => Math.max(t, Number(m.time) || 0), 0);
  const ageMs = lastAt ? Math.max(0, Number(now) - lastAt) : null;

  const activityScore = clamp01(total / 12);
  const balance = total ? Math.min(1, participants.size / Math.max(1, total * 0.5)) : 0;
  const negativeRate = total ? negative / total : 0;
  const freshness = ageMs === null ? 0 : clamp01(1 - ageMs / staleMs);
  const health = Math.round(clamp01(activityScore * 0.4 + balance * 0.25 + (1 - negativeRate) * 0.2 + freshness * 0.15) * 100) / 100;
  const label = total === 0
    ? (rows.length && ageMs !== null && ageMs > staleMs ? 'cold' : 'unknown')
    : (negativeRate >= 0.4 && total >= 4 ? 'tense' : (health >= 0.7 ? 'warm' : (health >= 0.45 ? 'neutral' : 'cold')));
  return {
    v: GROUP_HEALTH_VERSION,
    at: Number(now), windowMs,
    total, participants: participants.size, selfMessages, questions,
    negative, negativeRate: Math.round(negativeRate * 1000) / 1000,
    lastAt, ageMs,
    health, label,
    herShare: total ? Math.round((selfMessages / total) * 1000) / 1000 : 0,
  };
}

/**
 * 互动预算：最小间隔 + 每小时上限。返回 allowed / waitMs / remaining / reason。
 */
export function evaluateInteractionBudget({ spokeAt = [], now = Date.now(), minGapMs = 20 * 1000, maxPerHour = 12 } = {}) {
  const times = (Array.isArray(spokeAt) ? spokeAt : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const last = times.length ? times[times.length - 1] : 0;
  const recent = times.filter((t) => now - t < 3600 * 1000);
  const gapMs = last ? Math.max(0, now - last) : Infinity;
  if (gapMs < minGapMs) return { allowed: false, waitMs: minGapMs - gapMs, remaining: Math.max(0, maxPerHour - recent.length), reason: 'min-gap' };
  if (recent.length >= maxPerHour) return { allowed: false, waitMs: 0, remaining: 0, reason: 'hourly-cap' };
  return { allowed: true, waitMs: 0, remaining: Math.max(0, maxPerHour - recent.length), reason: 'ok' };
}

/**
 * 退场判断：她说太多/没人接/沉默够久。
 * @param {{herMessages:Array, othersAfter:number, now?:number, minQuietMs?:number, maxMonologue?:number}} input
 */
export function shouldWithdraw({ herMessages = [], othersAfter = 0, now = Date.now(), minQuietMs = 10 * 60 * 1000, maxMonologue = 3 } = {}) {
  const rows = (Array.isArray(herMessages) ? herMessages : []).filter((m) => m && Number.isFinite(Number(m.time)));
  const lastSelf = rows.reduce((t, m) => Math.max(t, Number(m.time) || 0), 0);
  const quietFor = lastSelf ? Math.max(0, Number(now) - lastSelf) : 0;
  if (rows.length > 0 && othersAfter === 0 && quietFor >= minQuietMs) return { withdraw: true, reason: 'no-response', quietMs: quietFor };
  if (rows.length >= maxMonologue && othersAfter === 0) return { withdraw: true, reason: 'monologue', quietMs: quietFor };
  if (quietFor >= 3 * minQuietMs && othersAfter === 0) return { withdraw: true, reason: 'idle', quietMs: quietFor };
  return { withdraw: false, reason: 'stay', quietMs: quietFor };
}

/** 一行可注入/日志用的群气氛（不是命令）。 */
export function renderGroupHealthLine(state) {
  if (!state || state.total === 0) return '';
  const map = { warm: '聊得热乎', neutral: '正常', cold: '有点冷', tense: '气氛紧' };
  return `群里${map[state.label] || state.label}：${state.total} 条 / ${state.participants} 人，她占 ${Math.round(state.herShare * 100)}%${state.negative ? `，负性 ${Math.round(state.negativeRate * 100)}%` : ''}。`;
}
