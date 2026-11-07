// inori-cognition.js · 认知条目（她"想明白了的事"的结构化落点）
//
// 与记忆的区别：
//   data/memory/*.jsonl = 发生了什么（情节、事实、摘要，按时间流）
//   data/state/cognition.jsonl = 她提炼出的**认知**（概念/规律/判断），跨事件稳定，可被检索、可被推翻
//
// 纪律（判定权归她）：
//   - 只在她调用工具写下时新增（qq_cognition_add）；桥接不自动灌结论。
//   - 每条带 source（从哪来，如 lesson/reflect/browse/她说的）与 at；
//     失效用 invalidAt 标（被推翻/被自己降级），**不删**。
//   - 注入只递"你知道的事"，不催她把认知用起来。
//
// [COG-V2] 2026-10-27 结构升级（向后兼容：老条目缺字段按默认补齐，不迁移数据）：
//   kind       认知属于哪一类（关于他/群/世界/我/怎么做/其他）——注入时按类去重，避免一屏全是"怎么对他"
//   when       什么时候成立（适用条件）
//   unless     什么时候不成立（反例/例外）
//   evidence   证据来源 [{type, ref, note}]，来自哪条 lesson/记忆/事件
//   confidence 置信度 0.05~0.98；被印证上调、被推翻下调
//   up/down    被印证/被推翻的次数；down≥3 自动失效
//   usedCount  被注入过的次数（用没用她自己的事，由回合侧回填）
//   validAt/invalidAt  生效/失效时间（Graphiti 那套双时间的轻量版）

import fs from 'node:fs';
import { rewriteJsonl, withFileLock } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('cognition.jsonl'),
  maxInject: 3,
  minScore: 0.18,
};

export const KINDS = ['about-him', 'about-group', 'about-world', 'about-me', 'how-to', 'general'];

export const KIND_LABEL = {
  'about-him': '关于他',
  'about-group': '关于群',
  'about-world': '关于世界',
  'about-me': '关于我',
  'how-to': '怎么做',
  general: '其他',
};

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '').replace(/[\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 两个字符串的二元组重合度（0~1） */
export function overlap(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 老条目补默认值：读的时候补，不写回（避免迁移数据）。 */
export function normalize(e, index = 0) {
  if (!e || typeof e !== 'object') return null;
  const text = String(e.text ?? '').trim();
  if (!text) return null;
  const evidence = Array.isArray(e.evidence) ? e.evidence.filter(Boolean) : [];
  return {
    ...e,
    id: String(e.id || `c${index}`),
    text,
    concept: String(e.concept || text),
    gist: String(e.gist || ''),
    kind: KINDS.includes(e.kind) ? e.kind : 'general',
    subject: String(e.subject || ''),
    when: String(e.when || ''),
    unless: String(e.unless || ''),
    evidence,
    tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
    source: String(e.source || 'she'),
    confidence: clamp(e.confidence ?? 0.55, 0.05, 0.98),
    times: Math.max(1, Number(e.times) || 1),
    up: Math.max(0, Number(e.up) || 0),
    down: Math.max(0, Number(e.down) || 0),
    usedCount: Math.max(0, Number(e.usedCount) || 0),
    at: e.at || null,
    usedAt: e.usedAt || null,
    validAt: e.validAt || e.at || null,
    invalidAt: e.invalidAt || e.supersededAt || null,
    supersededBy: e.supersededBy || null,
  };
}

export function load(file = DEFAULTS.file) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return rows.map((l, i) => { try { return normalize(JSON.parse(l), i); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function save(items, file = DEFAULTS.file) {
  const written = rewriteJsonl(file, Array.isArray(items) ? items : [], { source: 'cognition/save' });
  if (!written.ok) throw new Error(written.error || '认知库写入失败');
  return items;
}

/** 锁内重新读取并完成一次读-改-写，避免并发调用拿旧快照互相覆盖。 */
export function transact(mutator, file = DEFAULTS.file) {
  if (typeof mutator !== 'function') return { ok: false, error: 'mutator 必须是函数' };
  return withFileLock(file, () => {
    const current = load(file);
    const result = mutator(current);
    const rows = Array.isArray(result?.items) ? result.items : current;
    if (result?.ok === false) return result;
    const written = rewriteJsonl(file, rows, { source: 'cognition/transact' });
    if (!written.ok) return { ok: false, error: written.error || '认知库写入失败', items: current };
    return result ?? { ok: true, items: rows };
  }, { source: 'cognition/transact' });
}

/** 认知的"主体"：同一主体只留一条有效判断，避免同一件事换个说法就再堆一条。 */
export function subjectOf(concept, gist = '') {
  const raw = String(concept || gist || '').trim();
  if (!raw) return '';
  const head = raw.split(/[（(：:，,。；;！!？?\n「」]/)[0].trim();
  const cut = head.replace(/(靠|是|要|让|把|在|的|本质|不自然|会|能|先|别).*$/, '').trim();
  return (cut || head).slice(0, 24);
}

/**
 * 新增一条认知；同一主体（subject）或重合 ≥0.6 视为同一条 → 更新正文而不是堆一条新的。
 * [JUDGMENT-ONLY] how-to（操作步骤）不进认知：那属于技能/记忆；认知只收"想明白的判断"。
 * [WHEN] requireWhen=true 时，没写适用条件直接拒绝（MCP/HTTP 入口开启；单测可关）。
 */
export function add(items, { concept, gist, kind, subject, when, unless, evidence, tags = [], source = 'she', confidence, supersedes = '', requireWhen = false } = {}, now = new Date()) {
  const list = Array.isArray(items) ? [...items] : [];
  const c = String(concept ?? '').trim();
  const g = String(gist ?? '').trim();
  if (!c && !g) return { ok: false, error: 'concept 和 gist 至少给一个', items: list };
  if (kind === 'how-to') return { ok: false, error: 'how-to 是操作步骤，去 skill_save 或 memory_save；认知只收判断/规律', items: list };
  if (requireWhen && !String(when ?? '').trim()) return { ok: false, error: '认知要写清什么时候成立（when）', items: list };
  const body = [c, g].filter(Boolean).join('：');
  const ev = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  const subj = String(subject || subjectOf(c, g)).trim().slice(0, 24);
  const sup = String(supersedes || '').trim();
  const old = sup ? list.find((x) => String(x.id) === sup) : null;
  if (sup && !old) return { ok: false, error: `没有这条认知：${sup}`, items: list };
  if (old) {
    old.invalidAt = now.toISOString();
    old.supersededBy = 'replaced';
    old.updatedAt = now.toISOString();
  }
  // 同一主体已有有效条目 → 更新它；除非这次明确是 replace（supersedes）。
  const hit = !old && list.find((x) => !x.invalidAt && !x.supersededAt
    && ((subj && String(x.subject || '') === subj && String(x.subject || '')) || overlap(String(x.text ?? ''), body) >= 0.6));
  if (hit) {
    hit.text = body;
    hit.concept = c || hit.concept;
    hit.gist = g || hit.gist;
    if (subj) hit.subject = subj;
    hit.updatedAt = now.toISOString();
    hit.times = (Number(hit.times) || 1) + 1;
    if (kind && KINDS.includes(kind)) hit.kind = kind;
    if (when) hit.when = String(when);
    if (unless) hit.unless = String(unless);
    if (Array.isArray(tags) && tags.length) hit.tags = [...new Set([...(hit.tags || []), ...tags.map(String)])].slice(0, 12);
    if (ev.length) hit.evidence = [...(hit.evidence || []), ...ev].slice(-20);
    if (confidence != null) hit.confidence = clamp(confidence, 0.05, 0.98);
    return { ok: true, items: list, entry: hit, updated: true };
  }
  const newId = `c${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (old) old.supersededBy = newId;
  const entry = normalize({
    id: newId,
    at: now.toISOString(),
    text: body,
    concept: c || body,
    gist: g,
    kind: KINDS.includes(kind) ? kind : 'general',
    subject: subj,
    when: String(when || ''),
    unless: String(unless || ''),
    evidence: ev,
    source: String(source || 'she'),
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 12) : [],
    confidence: confidence == null ? 0.55 : clamp(confidence, 0.05, 0.98),
    times: 1,
    up: 0,
    down: 0,
    usedCount: 0,
    validAt: now.toISOString(),
    invalidAt: null,
  });
  list.push(entry);
  return { ok: true, items: list, entry, updated: false, replaced: old ? String(old.id) : '' };
}

/** 仍有效的条目（失效的不进检索、不注入） */
function activeOnly(items) {
  return (Array.isArray(items) ? items : []).filter((x) => x && x.text && !x.invalidAt && !x.supersededAt);
}

/** 按当前话题挑几条相关的；不相关就不给（宁缺勿滥） */
export function pickForQuery(items, query, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const list = activeOnly(items);
  const q = String(query ?? '').trim();
  if (!list.length) return [];
  if (!q) return list.slice(-o.maxInject);
  const scored = list.map((x) => ({
    x,
    s: overlap(`${x.text}${x.when ? ` ${x.when}` : ''}`, q) + (x.tags || []).reduce((a, t) => a + (q.includes(t) ? 0.3 : 0), 0),
  }))
    .filter((r) => r.s >= o.minScore)
    .sort((a, b) => b.s - a.s || (b.x.confidence || 0) - (a.x.confidence || 0))
    .slice(0, o.maxInject);
  return scored.map((r) => r.x);
}

function oneLine(x) {
  const head = `- ${String(x.text).slice(0, 160)}`;
  const parts = [];
  if (x.when) parts.push(`什么时候成立：${String(x.when).slice(0, 80)}`);
  if (x.unless) parts.push(`例外：${String(x.unless).slice(0, 60)}`);
  const ev = Array.isArray(x.evidence) ? x.evidence.length : 0;
  if (ev) parts.push(`依据 ${ev} 条`);
  const pct = Math.round((Number(x.confidence) || 0.55) * 100);
  if (pct < 65) parts.push(`拿不准（${pct}%）`);
  return parts.length ? `${head}（${parts.join('｜')}）` : head;
}

/**
 * 渲染注入块：按 kind 去重（一屏别全是"怎么对他"），最多 3 条。
 * 返回 { text, ids }：ids 供调用方回填 usedCount。
 */
export function render(items, query) {
  const picked = pickForQuery(items, query, { maxInject: 5 });
  if (!picked.length) return { text: '', ids: [] };
  const seenKind = new Set();
  const chosen = [];
  for (const x of picked) {
    const k = x.kind || 'general';
    if (seenKind.has(k) && chosen.length >= 1) continue;
    seenKind.add(k);
    chosen.push(x);
    if (chosen.length >= 3) break;
  }
  const lines = chosen.map(oneLine).join('\n');
  const text = `【你已经想明白的事】${lines}\n（这些是你自己攒下来的认知，不是规矩；跟眼前的事对不上就别硬套。）\n\n`;
  return { text, ids: chosen.map((x) => x.id).filter(Boolean) };
}

/** 注入用的一段事实（没有就空串）；兼容旧调用方 */
export function renderLine(items, query) {
  return render(items, query).text;
}

/** 回填"这条被注入了"：只动 usedAt/usedCount */
export function markUsed(items, ids, now = new Date()) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!set.size) return items;
  for (const x of items) {
    if (x && set.has(String(x.id))) {
      x.usedAt = now.toISOString();
      x.usedCount = (Number(x.usedCount) || 0) + 1;
    }
  }
  return items;
}

/**
 * 她给一条认知打分：up=印证 / down=推翻。
 * confidence 跟着动；down 累计到 3 次自动失效（invalidAt），但不删原文。
 */
export function vote(items, id, dir = 'up', now = new Date()) {
  const entry = (Array.isArray(items) ? items : []).find((x) => x && String(x.id) === String(id));
  if (!entry) return { ok: false, error: `没有这条认知：${id}`, items };
  if (dir === 'down') {
    entry.down = (Number(entry.down) || 0) + 1;
    entry.confidence = clamp((Number(entry.confidence) || 0.55) - 0.15, 0.05, 0.98);
    if (entry.down >= 3 && !entry.invalidAt) {
      entry.invalidAt = now.toISOString();
      entry.supersededBy = 'self:down>=3';
    }
  } else {
    entry.up = (Number(entry.up) || 0) + 1;
    entry.confidence = clamp((Number(entry.confidence) || 0.55) + 0.08, 0.05, 0.98);
  }
  entry.updatedAt = now.toISOString();
  return { ok: true, items, entry };
}

/** 直接判无效（被新的推翻 / 她明确说这条不对了） */
export function supersede(items, id, reason = 'superseded', now = new Date()) {
  const entry = (Array.isArray(items) ? items : []).find((x) => x && String(x.id) === String(id));
  if (!entry) return { ok: false, error: `没有这条认知：${id}`, items };
  entry.invalidAt = now.toISOString();
  entry.supersededBy = String(reason || 'superseded').slice(0, 80);
  entry.updatedAt = now.toISOString();
  return { ok: true, items, entry };
}

/** 一行统计（日志/接口用） */
export function stats(items) {
  const list = Array.isArray(items) ? items : [];
  const act = activeOnly(list);
  const bySource = {};
  const byKind = {};
  for (const x of list) {
    bySource[x.source || '?'] = (bySource[x.source || '?'] || 0) + 1;
    if (!x.invalidAt) byKind[x.kind || 'general'] = (byKind[x.kind || 'general'] || 0) + 1;
  }
  const withEvidence = act.filter((x) => Array.isArray(x.evidence) && x.evidence.length).length;
  const avgConfidence = act.length ? Math.round((act.reduce((a, x) => a + (Number(x.confidence) || 0.55), 0) / act.length) * 100) / 100 : 0;
  return {
    total: list.length,
    active: act.length,
    invalid: list.length - act.length,
    bySource,
    byKind,
    withEvidence,
    neverUsed: act.filter((x) => !x.usedCount).length,
    avgConfidence,
  };
}
