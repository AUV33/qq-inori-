// memory-retention.mjs · 记忆保留/遗忘的纯策略（蓝图 R5 第一块）
//
// 干什么：给每条记忆算一个 0..1 的保留分（重要度/时近/被回忆次数/来源），
//         当文件超过上限时，只把“分数最低且非保护”的条目移出（归档可恢复）。
// 为什么：现状只有“90 天一刀切”，没有“重要性×时近×使用”的守恒律；文件长到上限时会静默丢老记忆。
// 输入输出：纯函数；entries 进，{keep, archive, scored} 出。
// 失败模式：脏条目按最低分；保护条目永不归档；未超上限时全保留。
// 不做什么：不读写文件、不做语义合并（巩固是下一步）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.4

export const RETENTION_VERSION = 1;
export const DEFAULT_MAX_ENTRIES = 2000;

const DAY = 86400000;

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function entryAgeDays(entry, now) {
  const at = Number(entry?.at) || Date.parse(String(entry?.time || '')) || Date.parse(String(entry?.day || '')) || 0;
  if (!at) return 999;
  return Math.max(0, (now - at) / DAY);
}

/** 保护：她自己写的、明确重要的、被 pin 的、事实类，不进遗忘池。 */
export function isProtected(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (entry.pinned === true) return true;
  if (String(entry.src || entry.source || '') === 'her') return true;
  if (Number(entry.importance) >= 4) return true;
  const kind = String(entry.kind || '');
  if (kind === 'fact' || kind === 'group-fact' || kind === 'self-model') return true;
  return false;
}

/**
 * 保留分：重要度 0.5、时近 0.3、被回忆 0.2；保护条目不参与归档，但仍返回分数。
 * @param {object} entry
 * @param {{now?:number}} opts
 */
export function retentionScore(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return 0;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const imp = clamp01((num(entry.importance, 3) - 1) / 4);
  const ageDays = entryAgeDays(entry, now);
  const recency = Math.pow(0.5, ageDays / 90);
  const recalls = Math.max(0, num(entry.mentions, 0)) + Math.max(0, num(entry.recallCount, 0)) + Math.max(0, num(entry.hits, 0));
  const recallScore = clamp01(Math.log1p(recalls) / Math.log1p(20));
  return Number((0.5 * imp + 0.3 * recency + 0.2 * recallScore).toFixed(4));
}

/**
 * 按上限保留：未超上限全留；超了才按分数从低到高移出非保护条目。
 * @param {object[]} entries
 * @param {{now?:number, maxEntries?:number}} opts
 */
export function partitionForRetention(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? Math.floor(opts.maxEntries) : DEFAULT_MAX_ENTRIES;
  const scored = list.map((entry, index) => ({ entry, index, score: retentionScore(entry, { now }), protected: isProtected(entry) }));
  if (scored.length <= maxEntries) return { keep: list, archive: [], scored, maxEntries };

  const protectedRows = scored.filter((r) => r.protected);
  const normal = scored.filter((r) => !r.protected).sort((a, b) => b.score - a.score || a.index - b.index);
  const keepCount = Math.max(protectedRows.length, maxEntries);
  const keepNormal = normal.slice(0, Math.max(0, keepCount - protectedRows.length));
  const archiveRows = normal.slice(Math.max(0, keepCount - protectedRows.length));
  const keepSet = new Set([...protectedRows, ...keepNormal].map((r) => r.index));
  const keep = list.filter((_, i) => keepSet.has(i));
  const archive = archiveRows.map((r) => r.entry);
  return { keep, archive, scored, maxEntries };
}
