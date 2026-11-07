// inori-memory-organize.js · 记忆库的有序整理（纯函数，读写分离）
//
// 为什么要它（2026-10-27 体检实测）：
//   私聊 28 条 / 群656 88 条 / 群686 46 条，其中「群像快照」「想自己待会儿…累计 N 次」这类
//   **滚动摘要每刷新一次就多留一条**：group-digest 占群库 75%，近重复 5 对全是它们。
//   结果：检索时同一件事的多个旧快照互相竞争，theme/情节字段还大面积缺失。
//
// 纪律（判定权归她）：
//   本模块只做**机械识别**（完全重复 / 近似重复 / 滚动快照旧版本），
//   合并与删除一律不自动执行——产出候选，由桥接归档旧快照（可检索）或她自己动手（qq_memory_*）。

export const DEFAULTS = {
  nearThreshold: 0.8,   // 二元组 Jaccard ≥ 0.8 视为近似重复
  nearMinLen: 20,       // 太短的句子不比（噪声大）
  snapshotMinLen: 8,
};

// ── 文本工具 ────────────────────────────────────────────────────────────────

export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, '').replace(/[\p{P}]/gu, '');
}

export function bigrams(text) {
  const s = normalizeText(text);
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const A = typeof a === 'string' ? bigrams(a) : a;
  const B = typeof b === 'string' ? bigrams(b) : b;
  if (!A || !B || !A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// ── 完全重复 ────────────────────────────────────────────────────────────────

/** 找出文本完全相同的条目组（去空白后比较）。返回 [[i,j,...], ...] */
export function findExactDuplicates(entries) {
  const groups = new Map();
  (Array.isArray(entries) ? entries : []).forEach((e, i) => {
    const k = normalizeText(e?.text);
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// ── 近似重复 ────────────────────────────────────────────────────────────────

/** 近似重复对：jaccard ≥ threshold 且长度达阈值。返回 [{i,j,score}]，按相似度降序 */
export function findNearDuplicates(entries, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = Array.isArray(entries) ? entries : [];
  const grams = list.map((e) => bigrams(e?.text));
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (normalizeText(list[i]?.text).length < o.nearMinLen) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      if (normalizeText(list[j]?.text).length < o.nearMinLen) continue;
      const s = similarity(grams[i], grams[j]);
      if (s >= o.nearThreshold) out.push({ i, j, score: +s.toFixed(2) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── 滚动快照族 ──────────────────────────────────────────────────────────────

// 「每刷新一次写一条」的快照族：只保留最近 N 份，更旧的归档（可检索，不删）。
// ⚠️ 群聊窗口摘要 / day-digest 是历史记录，**不在**这里——那是要留着的，不能当旧快照清。
const SNAPSHOT_FAMILIES = [
  { family: 'group-portrait', re: /^近\s*24\s*h\s*群像/, keep: 1 },        // 群像快照：每 24h 刷新，旧的没意义
  { family: 'wish-retry', re: /想自己待会儿.*累计\s*\d+\s*次/, keep: 1 },    // 愿望被挡的累计快照
  { family: 'browse-digest', re: /^今天网上看过[:：]/, keep: 3 },            // 冲浪摘要：留最近 3 天
];

/** 判断属于哪一族快照：返回 {family, keep} 或 null */
export function snapshotFamily(text) {
  const t = String(text ?? '').trim();
  if (t.length < DEFAULTS.snapshotMinLen) return null;
  for (const f of SNAPSHOT_FAMILIES) if (f.re.test(t)) return { family: f.family, keep: f.keep };
  return null;
}

/**
 * 旧快照：按族只保留最近 keep 份，其余列为可归档。
 * @returns {{ archive: Array<{index:number, family:string}>, kept: Record<string, number> }}
 */
export function outdatedSnapshots(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const fams = new Map();
  list.forEach((e, i) => {
    const hit = snapshotFamily(e?.text);
    if (!hit) return;
    if (!fams.has(hit.family)) fams.set(hit.family, { keep: hit.keep, idxs: [] });
    fams.get(hit.family).idxs.push(i);
  });
  const archive = [];
  const kept = {};
  for (const [family, info] of fams) {
    const scored = info.idxs.map((i) => ({ i, t: String(list[i]?.time ?? list[i]?.at ?? '') }));
    scored.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const keepCount = Math.max(1, Number(info.keep) || 1);
    const keepIdx = scored.slice(Math.max(0, scored.length - keepCount)).map((x) => x.i);
    kept[family] = keepIdx.length;
    for (const x of scored) if (!keepIdx.includes(x.i)) archive.push({ index: x.i, family });
  }
  archive.sort((a, b) => a.index - b.index);
  return { archive, kept };
}

// ── 合并 ────────────────────────────────────────────────────────────────────

/**
 * 把一组条目合并成一条（保留最新文本 + 合并元信息）。
 * 不写盘；返回新条目，调用方决定是否替换。
 */


// ── 索引 ────────────────────────────────────────────────────────────────────

/** 建一份可注入/可统计的索引：按 kind / theme / 天 计数 + 条目引用 */
export function buildIndex(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byKind = {};
  const byTheme = {};
  const byDay = {};
  const noTheme = [];
  list.forEach((e, i) => {
    const kind = String(e?.kind || '-');
    byKind[kind] = (byKind[kind] || 0) + 1;
    const theme = String(e?.theme || '').trim();
    if (theme) byTheme[theme] = (byTheme[theme] || 0) + 1;
    else if (kind !== 'day-digest') noTheme.push(i);
    const day = String(e?.day || '');
    if (day) byDay[day] = (byDay[day] || 0) + 1;
  });
  return { total: list.length, byKind, byTheme, byDay, noTheme };
}

/**
 * 一次整理：产出「可归档的旧快照」+「近似重复候选」+ 索引。
 * 只描述，不动数据。
 */
export function planOrganize(entries, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = Array.isArray(entries) ? entries : [];
  const org = outdatedSnapshots(list);
  const archive = org.archive.map((x) => x.index);
  const dupGroups = findExactDuplicates(list);
  const near = findNearDuplicates(list, o);
  return {
    total: list.length,
    archiveIndexes: archive,
    exactGroups: dupGroups,
    nearPairs: near,
    index: buildIndex(list),
    summary: {
      archive: archive.length,
      exactDupGroups: dupGroups.length,
      nearPairs: near.length,
      noTheme: buildIndex(list).noTheme.length,
    },
  };
}

/** 一行给日志/注入用的事实句 */
export function describePlan(plan) {
  if (!plan) return '';
  const s = plan.summary || {};
  const parts = [`共 ${plan.total} 条`];
  if (s.archive) parts.push(`旧快照可归档 ${s.archive} 条`);
  if (s.exactDupGroups) parts.push(`完全重复 ${s.exactDupGroups} 组`);
  if (s.nearPairs) parts.push(`近似重复 ${s.nearPairs} 对`);
  if (s.noTheme) parts.push(`无主题 ${s.noTheme} 条`);
  return parts.join('，');
}

export function mergeEntries(entries, idxs) {
  const list = Array.isArray(entries) ? entries : [];
  const picked = (Array.isArray(idxs) ? idxs : []).map((i) => list[i]).filter(Boolean);
  if (!picked.length) return null;
  if (picked.length === 1) return { ...picked[0] };
  const byTime = [...picked].sort((a, b) => String(a.time ?? a.at ?? '').localeCompare(String(b.time ?? b.at ?? '')));
  const latest = byTime[byTime.length - 1];
  const first = byTime[0];
  const union = (key) => {
    const out = [];
    for (const e of picked) {
      const v = e[key];
      const arr = Array.isArray(v) ? v : (v ? [v] : []);
      for (const x of arr) if (x && !out.includes(x)) out.push(x);
    }
    return out;
  };
  const maxImportance = Math.max(...picked.map((e) => Number(e.importance) || 0));
  return {
    ...latest,
    day: first.day ?? latest.day,
    time: first.time ?? latest.time,
    // [F2-PROVENANCE] 合并后的派生记忆也带溯源：取最早 recordedAt、代表性 src 与嵌入模型版本。
    recordedAt: first.recordedAt ?? latest.recordedAt,
    src: (union('src')[0]) ?? latest.src,
    embedModel: latest.embedModel ?? first.embedModel,
    importance: maxImportance || latest.importance,
    mentions: union('mentions'),
    who: latest.who ?? first.who,
    felt: latest.felt ?? first.felt,
    theme: latest.theme ?? first.theme,
    mergedFrom: picked.length,
    mergedAt: new Date().toISOString(),
  };
}
