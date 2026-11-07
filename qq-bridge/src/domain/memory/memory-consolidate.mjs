// memory-consolidate.mjs · 相似记忆合并（R5 语义巩固第一步，影子优先）
//
// 干什么：把同类（fact/group-fact/impression）且文本高度相似的记忆聚成一组，
//         用既有的 mergeEntries 合并成一条（保留最新文本、最早时间、最高重要度、证据并集）。
// 为什么：同一个人/事会被反复写进多条事实；不合并会让召回里塞满近重复，稀释预算。
// 输入输出：纯函数；entries 进，{keep, clusters, mergedCount} 出；不读写文件。
// 失败模式：脏条目按不可合并；阈值默认 0.92（保守），只处理白名单 kind。
// 不做什么：不做语义摘要（需要模型）；不合并 digest/记忆片段；不删除任何内容（由调用方决定是否写）。
//
// 对应蓝图：docs/internal/_archive/规划/蓝图-世界级-20261103.md §4.4 / R5

import { mergeEntries } from '../leaves/inori-memory-organize.js';
// [SEMANTIC-COMPRESS] §5.11：同类 fact 压缩；默认关闭，由调用方显式 opt-in。
import { compressFacts } from './semantic-compress.mjs';

export const CONSOLIDATE_VERSION = 1;
export const DEFAULT_THRESHOLD = 0.85;
export const CONSOLIDATE_KINDS = Object.freeze(['fact', 'group-fact', 'impression']);

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function bigrams(text) {
  const s = normalizeText(text);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 字符二元组 Jaccard（与 memory-retrieve 的近似口径一致，故意不引分词器）。 */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * @param {object[]} entries
 * @param {{threshold?:number, kinds?:string[], maxClusters?:number}} opts
 */
export function consolidateSimilar(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const kinds = new Set(Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : CONSOLIDATE_KINDS);
  const maxClusters = Number.isFinite(opts.maxClusters) ? opts.maxClusters : 100;

  const clusters = [];
  const used = new Set();
  for (let i = 0; i < list.length && clusters.length < maxClusters; i += 1) {
    if (used.has(i)) continue;
    const base = list[i];
    if (!kinds.has(String(base.kind || ''))) continue;
    const members = [{ index: i, entry: base }];
    used.add(i);
    for (let j = i + 1; j < list.length; j += 1) {
      if (used.has(j)) continue;
      const other = list[j];
      if (String(other.kind || '') !== String(base.kind || '')) continue;
      if (similarity(base.text, other.text) < threshold) continue;
      members.push({ index: j, entry: other });
      used.add(j);
    }
    if (members.length > 1) {
      const merged = mergeEntries(members.map((m) => m.entry), members.map((m, k) => k));
      clusters.push({ members: members.map((m) => m.index), merged });
    }
  }

  const mergedIdx = new Set(clusters.flatMap((c) => c.members.slice(1)));
  const keep = list.filter((_, i) => !mergedIdx.has(i));
  // 合并后把 merged 对象替换到原位置（保持时间序的大致位置）
  for (const c of clusters) {
    const firstIdx = Math.min(...c.members);
    const pos = keep.findIndex((e) => e === list[firstIdx]);
    if (pos >= 0) keep[pos] = c.merged;
  }
  const mergedCount = clusters.reduce((sum, c) => sum + c.members.length - 1, 0);
  return { keep, clusters, mergedCount, threshold, kinds: [...kinds] };
}

/**
 * 近似去重 + 可选语义压缩。semantic=false 时与 consolidateSimilar 完全一致（默认安全）。
 */
export function consolidateWithSemantic(entries, opts = {}) {
  const base = consolidateSimilar(entries, opts);
  if (opts.semantic !== true) return { ...base, semantic: { entries: base.keep, groups: [], dropped: 0 } };
  const compressed = compressFacts(base.keep, { threshold: opts.compressThreshold, maxChars: opts.maxChars, now: opts.now });
  return { ...base, keep: compressed.entries, semantic: compressed };
}
