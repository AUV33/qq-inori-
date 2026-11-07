// sticker-autocollect.mjs · 自动收藏的「节奏闸」（2026-10-28）
//
// 事故：autoCollect 只有 maxPerDay=5，没有节奏限制。结果 10/28 00:14–00:26 十二分钟内
// 连着收了 5 张，额度用光，之后 23 个小时一次都不再收——她看起来像"不收藏了"。
//
// 这个纯函数只回答一件事：**现在允许自动收吗**。允许时返回要写回的 meta 增量
// （日计数 +1、小时计数 +1、lastAutoAt=now）；不允许时也返回需要落盘的 meta
// （跨天/跨小时时把计数归零），避免调用方各自维护时间边界。
//
// 纪律：额度只增不减、时间边界用本地时区（和她自己感知的"今天/这个小时"一致）。

export const CAPTION_MAX_ATTEMPTS = 3;
export const CAPTION_BACKOFF_BASE_MS = 30 * 60 * 1000;
export const CAPTION_BACKOFF_MAX_MS = 6 * 3600 * 1000;

/**
 * 表情池打标重试闸：失败后指数退避，最多 3 次，避免「打标永远失败 → 每 3 分钟
 * 重试同一张 → 整晚烧 402」的循环。纯函数，调用方只负责把 attempts/failedAt 落盘。
 *
 * @param {{captionAttempts?:number, captionFailedAt?:number, captionSkipped?:boolean}} item
 * @param {{now?:number, maxAttempts?:number, baseMs?:number, maxMs?:number}} [opts]
 * @returns {{ok:boolean, skip?:boolean, reason:string, waitMs?:number, attempts:number}}
 */
export function evaluateCaptionRetry(item = {}, {
  now = Date.now(),
  maxAttempts = CAPTION_MAX_ATTEMPTS,
  baseMs = CAPTION_BACKOFF_BASE_MS,
  maxMs = CAPTION_BACKOFF_MAX_MS,
} = {}) {
  const attempts = Math.max(0, Number(item?.captionAttempts) || 0);
  if (item?.captionSkipped || attempts >= maxAttempts) {
    return { ok: false, skip: true, reason: 'max-attempts', attempts };
  }
  const last = Number(item?.captionFailedAt) || 0;
  if (last > 0) {
    const waitMs = Math.min(maxMs, Math.max(0, baseMs) * (2 ** Math.max(0, attempts - 1)));
    if (now - last < waitMs) return { ok: false, reason: 'backoff', waitMs: waitMs - (now - last), attempts };
  }
  return { ok: true, reason: 'allow', attempts };
}

/**
 * @param {object} p
 * @param {object} [p.meta] sticker-pool-meta.json 的当前内容
 * @param {number} [p.now]
 * @param {number} [p.maxPerDay]
 * @param {number} [p.maxPerHour]
 * @param {number} [p.minIntervalMs] 两次自动收藏的最小间隔（0=不限制）
 * @returns {{ok:boolean, reason:string, metaPatch:object}}
 */
export function evaluateAutoCollect({
  meta = {},
  now = Date.now(),
  maxPerDay = 5,
  maxPerHour = 2,
  minIntervalMs = 0,
} = {}) {
  const d = new Date(now);
  const day = d.toLocaleDateString('sv-SE');
  const hour = d.getHours();
  const sameDay = meta.autoDay === day;
  const sameHour = sameDay && Number(meta.autoHourDay ? meta.autoHourDay === day : false) && Number(meta.autoHour) === hour;
  const dayCount = sameDay ? Number(meta.autoCount) || 0 : 0;
  const hourCount = sameHour ? Number(meta.autoHourCount) || 0 : 0;
  const base = {
    autoDay: day,
    autoCount: dayCount,
    autoHourDay: day,
    autoHour: hour,
    autoHourCount: hourCount,
    lastAutoAt: Number(meta.lastAutoAt) || 0,
  };
  if (dayCount >= maxPerDay) return { ok: false, reason: 'cap', metaPatch: base };
  if (hourCount >= maxPerHour) return { ok: false, reason: 'hour-cap', metaPatch: base };
  const last = Number(meta.lastAutoAt) || 0;
  if (minIntervalMs > 0 && last > 0 && now - last < minIntervalMs) {
    return { ok: false, reason: 'paced', waitMs: minIntervalMs - (now - last), metaPatch: base };
  }
  return {
    ok: true,
    reason: 'allow',
    metaPatch: { ...base, autoCount: dayCount + 1, autoHourCount: hourCount + 1, lastAutoAt: now },
  };
}
