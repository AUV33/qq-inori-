// semantic-compress.mjs · 宪章 §5.11/§5.4：同类 fact 的语义压缩（不靠模型）
//
// 干什么：把同一主题下**相关但不同**的稳定事实（"喜欢吃披萨" + "爱吃意餐"）压成一条
//   "主题：A；B" 的常驻事实；不相关的不硬并，情景事件不参与。
// 为什么：语义钉会把 owner 事实永久保留；不压缩的话，同类事实越积越多，召回预算被近重复稀释。
// 输入输出：纯函数；entries 进，{entries, groups, dropped} 出；不改原数组。
// 失败模式：坏条目原样保留；合并后超长就放弃合并（宁可不压）。
// 不做什么：不生成新语义（只拼接原句）、不调模型、不删除非 fact 条目。

export const SEMANTIC_COMPRESS_VERSION = 1;
// 中文短句的 bigram Jaccard 天然偏低（「喜欢吃披萨」vs「喜欢吃意餐」≈0.33）；
// 0.35 会让“同类但不同”的事实永远合不了，故降到 0.25，并靠 theme 分组兜底。
export const COMPRESS_DEFAULT_THRESHOLD = 0.25;

function norm(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}
function bigrams(text) {
  const s = norm(text); const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function groupKey(entry) {
  return String(entry?.theme || entry?.who || 'general');
}
function isFact(entry) {
  return !!entry && typeof entry === 'object' && (entry.pinned === true || String(entry.kind || '') === 'fact');
}

/**
 * @param {object[]} entries
 * @param {{threshold?:number, maxGroup?:number, maxChars?:number, now?:number}} opts
 */
export function compressFacts(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : COMPRESS_DEFAULT_THRESHOLD;
  const maxGroup = Number.isFinite(opts.maxGroup) ? Math.max(2, opts.maxGroup) : 6;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 200;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const groupsByKey = new Map();
  list.forEach((entry, index) => {
    if (!isFact(entry)) return;
    const key = groupKey(entry);
    if (!groupsByKey.has(key)) groupsByKey.set(key, []);
    groupsByKey.get(key).push({ index, entry });
  });

  const replace = new Map(); // index -> merged
  const remove = new Set();
  const groups = [];
  for (const [key, rows] of groupsByKey) {
    const used = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      if (used.has(i)) continue;
      const cluster = [rows[i]];
      used.add(i);
      for (let j = i + 1; j < rows.length && cluster.length < maxGroup; j += 1) {
        if (used.has(j)) continue;
        if (jaccard(rows[i].entry.text, rows[j].entry.text) < threshold) continue;
        const candidate = [...cluster, rows[j]];
        const text = candidate.map((r) => String(r.entry.text ?? '').trim()).filter(Boolean).join('；');
        if (text.length > maxChars) continue;
        cluster.push(rows[j]);
        used.add(j);
      }
      if (cluster.length < 2) continue;
      const base = cluster[0].entry;
      const merged = {
        ...base,
        text: cluster.map((r) => String(r.entry.text ?? '').trim()).filter(Boolean).join('；').slice(0, maxChars),
        kind: 'fact',
        pinned: true,
        mentions: cluster.reduce((n, r) => n + (Number(r.entry.mentions) || 0), 0),
        importance: Math.max(...cluster.map((r) => Number(r.entry.importance) || 0), 3),
        mergedFrom: cluster.map((r) => r.entry.id || r.entry.text).filter(Boolean).slice(0, 12),
        compressedAt: now,
      };
      replace.set(cluster[0].index, merged);
      for (const r of cluster.slice(1)) remove.add(r.index);
      groups.push({ key, from: cluster.length, text: merged.text });
    }
  }
  const out = [];
  list.forEach((entry, index) => {
    if (remove.has(index)) return;
    out.push(replace.has(index) ? replace.get(index) : entry);
  });
  return { v: SEMANTIC_COMPRESS_VERSION, entries: out, groups, dropped: remove.size };
}
