// inori-raw-memory.mjs · 原文层 + 结构化主张（claims）
//
// 为什么需要它（2026-10-30）：
//   现有「记忆库」里一半是 digest/compact 摘要，原子 fact 只有 27 条；对话原文不在库里，
//   只活在每会话 100 条窗口里。于是「我答应过他什么」「群里有人吵架吗」这类问题，
//   语义检索给不出答案——不是检索算法差，是数据源里没有可检索的原文。
//
// 这一层只做三件事，全部纯函数/显式 IO：
//   1) 原文落盘：data/raw/<scope>.jsonl，保留 30 天（appendRaw / loadRaw / pruneRaw）
//   2) 原文检索：字面打分（bigram 覆盖 + 整串包含 + 关键词），不依赖嵌入服务（searchRaw）
//   3) 结构化主张：从原文里按高精度规则抽「承诺 / 偏好 / 冲突」，写成 kind=claim 的记忆行（extractClaims）
//
// 纪律：
//   · 原文只进不退、按 scope 分文件（群/私聊），不跨 scope 读取；
//   · 抽取宁缺毋滥：规则只收高置信句式，宁可漏也不编；
//   · 不参与学习：这些是「记忆」，学习链路仍只看会话消息且跳过 isSelf。

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, rewriteJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

export const RAW_MAX_CHARS = 400;
export const RAW_KEEP_DAYS = 30;
export const RAW_MAX_PER_FILE = 20000;

/** scope 归一化：group:123 / group_123 → group_123；其余 → private。 */
export function rawScope(key) {
  const s = String(key ?? '').trim();
  if (!s) return 'private';
  const m = /^group[:：_\s]*(\d+)$/.exec(s);
  return m ? `group_${m[1]}` : 'private';
}

/** 原文文件路径（dir 是 data/raw 目录）。 */
export function rawFile(dir, scope) {
  return path.join(dir, `${rawScope(scope)}.jsonl`);
}

/**
 * 追加一条原文。text 压成单行、截 400 字；空文本不写。
 * @returns {boolean}
 */
export function appendRaw(dir, { key = '', at = Date.now(), sender = '', userId = null, text = '', seq = null, isSelf = false, quoteTargetIsSelf = false } = {}) {
  try {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, RAW_MAX_CHARS);
    if (!body) return false;
    const scope = rawScope(key);
    const row = {
      at: new Date(Number(at) || Date.now()).toISOString(),
      time: Number(at) || Date.now(),
      scope,
      key: String(key ?? ''),
      seq: seq ?? null,
      sender: String(sender ?? '').slice(0, 40),
      userId: userId == null ? null : String(userId),
      isSelf: !!isSelf,
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      text: body,
    };
    const r = appendJsonl(rawFile(dir, scope), row, { source: 'bridge/raw' });
    return r?.ok !== false;
  } catch { return false; }
}

/** 读原文（按时间正序）。 */
export function loadRaw(dir, scope, { sinceMs = 0, limit = 5000 } = {}) {
  try {
    const file = rawFile(dir, scope);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && x.text);
    const cut = Number(sinceMs) || 0;
    const kept = cut ? rows.filter((r) => (Number(r.time) || 0) >= cut) : rows;
    return kept.slice(-Math.max(1, Number(limit) || 5000));
  } catch { return []; }
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

function bigramCoverage(query, text) {
  const q = norm(query);
  const t = norm(text);
  if (q.length < 2 || t.length < 2) return 0;
  const grams = new Set();
  for (let i = 0; i < q.length - 1; i += 1) grams.add(q.slice(i, i + 2));
  let hit = 0;
  for (const g of grams) if (t.includes(g)) hit += 1;
  return hit / Math.max(1, grams.size);
}

// 检索时忽略的超高频词（否则「什么/怎么」会把所有句子都算命中）
const STOP = /什么|怎么|为什么|是不是|有没有|多少|哪个|这句|那句|一下|帮我|我们|他们|你们|这个|那个/;

/** 原文字面检索：bigram 覆盖 0.6 + 整串命中 0.25 + 关键词 0.15，返回按分降序。 */
export function searchRaw(rows, query, { limit = 8, minScore = 0.12 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const plain = q.replace(STOP, ' ').trim() || q;
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.text) continue;
    const cov = bigramCoverage(plain, r.text);
    const includes = norm(r.text).includes(norm(plain).slice(0, Math.max(2, Math.min(8, plain.length)))) ? 1 : 0;
    const kw = (plain.match(/[\u4e00-\u9fa5]{2,}/g) ?? []).filter((w) => norm(r.text).includes(norm(w))).length;
    const score = cov * 0.6 + includes * 0.25 + Math.min(0.15, kw * 0.05);
    if (score >= minScore) out.push({ row: r, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

/** 剪掉超期/超量的原文（保留非 raw 以外不涉及，本函数只管原文文件）。 */
export function pruneRaw(dir, { maxAgeDays = RAW_KEEP_DAYS, maxPerFile = RAW_MAX_PER_FILE, now = Date.now() } = {}) {
  const out = { removed: 0, files: 0, errors: [] };
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x) => x && x.text);
      if (!rows.length) continue;
      const cut = now - maxAgeDays * 86400000;
      let kept = rows.filter((r) => {
        const t = Number(r.time) || Date.parse(String(r.at ?? '')) || 0;
        return !(t && t < cut);
      });
      if (kept.length > maxPerFile) kept = kept.slice(-maxPerFile);
      if (kept.length === rows.length) continue;
      rewriteJsonl(file, kept, { source: 'bridge/raw-prune' });
      out.removed += rows.length - kept.length;
      out.files += 1;
    } catch (error) { out.errors.push(`${name}: ${error?.message ?? error}`); }
  }
  return out;
}

// ── 结构化主张（claims）──────────────────────────────────────────────────
// 只收高精度句式；宁缺毋滥。抽出来的行写成 kind='claim'，进记忆库（会被嵌入、可被语义检索）。
const CLAIM_RULES = [
  { type: 'promise', re: /答应|说好|约好|讲定|保证|一定(?:会|要|给)|我会(?:给|帮|记)/ },
  { type: 'preference', re: /喜欢|不喜欢|讨厌|最爱|想吃|不想吃|受不了/ },
  { type: 'conflict', re: /吵架|吵了|吵起来|骂你|怼你|翻脸|撕破脸|生气/ },
  { type: 'plan', re: /打算|准备|计划|下周|明天(?:要|去)|回头(?:去|弄)/ },
];

/**
 * 从原文里抽主张。相同文本（二元组重合 ≥0.85）只留一条。
 * @returns {Array<{type:string, text:string, at:number, seq:any, sender:string, isSelf:boolean}>}
 */
export function extractClaims(rows) {
  const out = [];
  const seen = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const text = String(r?.text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 4 || text.length > 200) continue;
    const hit = CLAIM_RULES.find((rule) => rule.re.test(text));
    if (!hit) continue;
    if (seen.some((s) => bigramCoverage(s, text) >= 0.85)) continue;
    seen.push(text);
    out.push({
      type: hit.type,
      text,
      at: Number(r.time) || Date.parse(String(r.at ?? '')) || Date.now(),
      seq: r.seq ?? null,
      sender: String(r.sender ?? ''),
      isSelf: !!r.isSelf,
    });
  }
  return out;
}

/**
 * 把 claim 转成记忆行（交给 appendJsonl 写入 memory 文件）。
 * 文本前缀标明类型，便于检索与展示；来源留 seq/sender。
 */
export function claimToMemoryRow(claim, { scope }) {
  const label = { promise: '承诺', preference: '偏好', conflict: '冲突', plan: '计划' }[claim.type] ?? '主张';
  return {
    at: new Date(Number(claim.at) || Date.now()).toISOString(),
    time: Number(claim.at) || Date.now(),
    kind: 'claim',
    claimType: claim.type,
    text: `[${label}] ${claim.text}`,
    who: claim.isSelf ? '我' : (claim.sender || '他'),
    source: 'raw/claim',
    scope,
    seq: claim.seq ?? null,
    importance: 4,
  };
}
