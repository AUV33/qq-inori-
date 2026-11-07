// inori-memory-views.js · 记忆视图统一（读取期去重，不迁移数据）
//
// 问题：同一件事可能以 group-digest / day-digest / fact / browse 多种视图各存一份，
// 检索时互相竞争、还可能在注入里重复出现。
// 做法：不迁移存储，只在「组装注入文本」时把同一时间窗内的同文/近重复合并成一条，
// 保留重要度更高（同重要度取更长）的那条。零 LLM、幂等。
export const DEFAULTS = { windowMs: 7 * 24 * 3600 * 1000, threshold: 0.85 };

function importanceOf(e) {
  const n = Number(e?.importance);
  if (Number.isFinite(n) && n >= 1) return Math.min(5, Math.max(1, n));
  const k = String(e?.kind ?? '');
  if (k === 'fact' || k === 'group-fact') return 4;
  if (k === 'event') return 3;
  if (k === 'group-digest' || k === 'day-digest' || k === 'group-compact' || k === 'browse') return 2;
  return 3;
}

export function normalizeText(t) {
  return String(t ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

function overlap(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

function tsOf(e) {
  const t = Date.parse(String(e?.time || e?.day || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function better(a, b) {
  const ia = importanceOf(a);
  const ib = importanceOf(b);
  if (ia !== ib) return ia > ib;
  return String(a?.text ?? '').length > String(b?.text ?? '').length;
}

/** 把同文/近重复（同时间窗）合并；返回 {entries, dropped, merged} */
export function unifyEntries(entries, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const kept = [];
  const dropped = [];
  for (const e of list) {
    const n = normalizeText(e.text);
    if (!n) { kept.push(e); continue; }
    const t = tsOf(e);
    let idx = -1;
    for (let i = 0; i < kept.length; i += 1) {
      const k = kept[i];
      const kn = normalizeText(k.text);
      if (!kn) continue;
      if (kn === n) { idx = i; break; } // 完全同文：无论时间窗都只留一条（保较新）
      if (overlap(n, kn) >= o.threshold) {
        const tk = tsOf(k);
        if (t != null && tk != null && Math.abs(t - tk) <= o.windowMs) { idx = i; break; }
      }
    }
    if (idx < 0) { kept.push(e); continue; }
    const cur = kept[idx];
    // [MEM-VIEWS] 完全同文 → 保留较新的那条（时间更新，不丢"最近发生过"）
    if (normalizeText(cur.text) === n) {
      const te = tsOf(e);
      const tc = tsOf(cur);
      const newer = te != null && tc != null && te > tc;
      if (newer || better(e, cur)) { kept[idx] = e; dropped.push(cur); } else dropped.push(e);
      continue;
    }
    if (better(e, cur)) { kept[idx] = e; dropped.push(cur); } else dropped.push(e);
  }
  return { entries: kept, dropped, merged: dropped.length };
}

export { overlap as textOverlap };
