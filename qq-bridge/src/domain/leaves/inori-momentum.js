// inori-momentum.js · 记忆的动量（Amory 的 momentum-aware consolidation）
//
// 为什么要有动量：现在同一条记忆再被提到，只是刷新时间，权重不变。
// 结果「他天天提的事」和「他提过一次的事」在她眼里一样重 —— 这不对。
//
// 规则（照 Amory 的非线性，避免线性膨胀）：
//   momentum = 1 - exp(-mentions / K)     K=5
//     提 1 次 → 0.18，提 3 次 → 0.45，提 10 次 → 0.86（越往后涨得越慢）
//   回落：超过 DECAY_DAYS(14) 天没再提到 → 每个周期 ×0.8
//     这样「他以前天天提、最近不提了」这件事本身也能被看见
//
// 纯函数、零依赖；写入侧（memory-mcp）用 bump()，检索侧用 momentumOf()。

export const K = 5;
export const DECAY_DAYS = 14;
export const DECAY_FACTOR = 0.8;
const DAY = 86400000;

/** 单个条目的动量（会按"多久没提"打折） */
export function momentumOf(entry, now = Date.now()) {
  const mentions = Math.max(0, Number(entry?.mentions) || 0);
  if (!mentions) return 0;
  const base = 1 - Math.exp(-mentions / K);
  const last = Number(entry?.lastMentionAt) || Number(entry?.at) || 0;
  if (!last) return Number(base.toFixed(3));
  const idleDays = Math.max(0, (now - last) / DAY);
  const periods = Math.floor(idleDays / DECAY_DAYS);
  const decayed = base * Math.pow(DECAY_FACTOR, periods);
  return Number(Math.max(0, Math.min(1, decayed)).toFixed(3));
}

/** 记一次提及：mentions+1，刷新 lastMentionAt */
export function bump(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return entry;
  entry.mentions = Math.max(0, Number(entry.mentions) || 0) + 1;
  entry.lastMentionAt = now;
  entry.momentum = momentumOf(entry, now);
  return entry;
}

/** 给检索打分用：相关性为主，动量为辅，最近说过一点加成 */
export function rankScore({ similarity, momentum, lastAt }, now = Date.now(), w = { sim: 0.6, mom: 0.3, rec: 0.1 }) {
  const sim = Number.isFinite(similarity) ? similarity : 0;
  const mom = Number.isFinite(momentum) ? momentum : 0;
  const last = Number(lastAt) || 0;
  const ageDays = last ? (now - last) / DAY : 999;
  const rec = ageDays <= 1 ? 1 : ageDays <= 7 ? 0.6 : ageDays <= 30 ? 0.3 : 0.1;
  return Number((w.sim * sim + w.mom * mom + w.rec * rec).toFixed(4));
}


// ── v2 打分（2026-11-03，蓝图 R5）─────────────────────────────────────────
// 为什么加：v1 的 rankScore 之后又叠加 kind/importance/recency/lexical 四个常数项
// （lexical 最高 0.2），常数可以压过语义相似度——这是 CodeBuddy 审计 B4。
// v2 把一切归一化后加权，词面/类型只能做微调；默认不切换（MEMORY_SCORE_V2=1 才启用），
// 先影子比较，符合蓝图“先测量再切换”。
export const V2_WEIGHTS = Object.freeze({
  sim: 0.55, importance: 0.15, momentum: 0.10, recency: 0.08, lexical: 0.07, kind: 0.03, relationship: 0.02,
});

export function normalizeImportance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, (n - 1) / 4));
}

function recencyScore(lastAt, now) {
  const last = Number(lastAt) || 0;
  if (!last) return 0.1;
  const ageDays = Math.max(0, (now - last) / DAY);
  return ageDays <= 1 ? 1 : ageDays <= 7 ? 0.6 : ageDays <= 30 ? 0.3 : 0.1;
}

function clampSigned(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

/**
 * 归一化加权的检索打分（0..1）。
 * @param {{similarity:number, importance?:number, momentum?:number, lastAt?:number,
 *          boosts?:{lexical?:number, kind?:number, relationship?:number}}} input
 *        importance 可直接传 1..5（内部归一化），也可传 0..1（<=1 视为已归一化）。
 */
export function rankScoreV2(input = {}, now = Date.now(), w = V2_WEIGHTS) {
  const sim = Math.max(0, Math.min(1, Number(input.similarity) || 0));
  const impRaw = Number(input.importance);
  const imp = Number.isFinite(impRaw) ? (impRaw > 1 ? normalizeImportance(impRaw) : Math.max(0, Math.min(1, impRaw))) : 0.5;
  const mom = Math.max(0, Math.min(1, Number(input.momentum) || 0));
  const rec = recencyScore(input.lastAt, now);
  const boosts = input.boosts && typeof input.boosts === 'object' ? input.boosts : {};
  const lex = Math.max(0, Math.min(1, Number(boosts.lexical) || 0));
  const kind = clampSigned(boosts.kind);
  const rel = Math.max(0, Math.min(1, Number(boosts.relationship) || 0));
  const score = w.sim * sim + w.importance * imp + w.momentum * mom + w.recency * rec
    + w.lexical * lex + w.kind * kind + w.relationship * rel;
  return Number(Math.max(0, Math.min(1, score)).toFixed(4));
}
