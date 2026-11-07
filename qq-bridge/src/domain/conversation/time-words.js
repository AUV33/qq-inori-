// time-words.js · 把毫秒时间差说成人话（纯函数，可单测）
//
// 为什么单独一个模块：以前时间间隔只写「N 分钟前」，隔一夜醒来就变成「720 分钟前」——
// 既不像人话，也丢了「隔了一夜」这个信息。这里只做换算，不做任何决策。

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * 距今多久（人话）。
 * 刚刚 / N 分钟前 / N 小时前 / 昨天 / 前天 / N 天前
 * @param {number} ms 已经过去的毫秒数
 * @returns {string}
 */
export function humanizeGap(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  const min = Math.floor(v / MIN);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(v / HOUR);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(v / DAY);
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  return `${days} 天前`;
}

/**
 * 持续了多久（不带「前」）：刚刚 / N 分钟 / N 小时 / N 天
 * 用于「闲了 X」「睡了 X」这类持续态。
 */
export function humanizeDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  const min = Math.floor(v / MIN);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟`;
  const hours = Math.floor(v / HOUR);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(v / DAY)} 天`;
}

/** 从时间戳算人话间隔；时间戳无效返回空串 */
export function humanizeAgo(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  return humanizeGap(now - t);
}

/**
 * 挂心/目标这类"放了多久"的说法。
 * 今天挂上的 / 挂了 1 天 / 挂了 N 天
 */
export function humanizeAge(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  const days = Math.floor(v / DAY);
  if (days < 1) return '今天挂上的';
  if (days === 1) return '挂了 1 天';
  return `挂了 ${days} 天`;
}
