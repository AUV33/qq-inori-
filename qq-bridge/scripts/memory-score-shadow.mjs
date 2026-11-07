#!/usr/bin/env node
// memory-score-shadow.mjs · 用真实记忆 + 已有向量缓存，对比 v1/v2 检索排序（不启动任何服务）
//
// 口径：每个 scope 内，用“有缓存向量的条目”做留一查询；相似度=cos(query, candidate)，
// 相关性代理=相似度。统计 top1 是否不同、top1 的平均相似度、低相似 top1 的次数。
// 不联网、不读外部状态、不写任何文件；只读 data/memory。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultScopes } from './lib/memory-scopes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MEM = path.join(ROOT, 'data', 'memory');

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function bigramOverlap(a, b) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const grams = (s) => { const out = new Set(); for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2)); return out; };
  const A = grams(norm(a)), B = grams(norm(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const g of A) if (B.has(g)) n += 1;
  return n / (A.size + B.size - n);
}

function toMs(entry) {
  const t = Date.parse(String(entry.time || entry.at || entry.day || ''));
  return Number.isFinite(t) ? t : 0;
}

/** v1：相似度 0.6 + 动量 0.3 + 时近 0.1 + 字面/重要度/近 3 天（近似 memory-retrieve） */
export function scoreV1({ sim, entry, query, now }) {
  const mentions = Math.max(0, Number(entry.mentions) || 0);
  const mom = mentions ? (1 - Math.exp(-mentions / 5)) : 0;
  const at = toMs(entry);
  const ageDays = at ? (now - at) / 86400000 : 999;
  const rec = ageDays <= 1 ? 1 : ageDays <= 7 ? 0.6 : ageDays <= 30 ? 0.3 : 0.1;
  const impW = ((Number(entry.importance) || 3) - 3) * 0.02;
  const lexW = 0.2 * bigramOverlap(query, entry.text);
  const recW = ageDays <= 3 ? 0.05 : 0;
  return 0.6 * sim + 0.3 * mom + 0.1 * rec + impW + lexW + recW;
}

export function scoreV2({ sim, entry, query, now }) {
  const mentions = Math.max(0, Number(entry.mentions) || 0);
  const mom = mentions ? (1 - Math.exp(-mentions / 5)) : 0;
  const at = toMs(entry);
  return rankV2({ similarity: sim, importance: entry.importance || 3, momentum: mom, lastAt: at || 0, lexical: bigramOverlap(query, entry.text) }, now);
}

import { rankScoreV2 as rankV2 } from '../src/domain/leaves/inori-momentum.js';

// [PRIVACY] 真实群号不再写死在源码里（privacy-scan 会拦），改为从本地记忆文件动态发现。
const SCOPES = defaultScopes(ROOT);

export function shadowScope(scope, { now = Date.now(), maxQueries = 30 } = {}) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(MEM, scope.cache), 'utf8')); } catch { return { scope: scope.name, entries: 0, queries: 0, noData: true }; }
  const entries = [];
  try {
    for (const line of fs.readFileSync(path.join(MEM, scope.file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const v = cache[sha(e.text)];
        if (Array.isArray(v) && v.length) entries.push({ ...e, vec: v });
      } catch { /* skip */ }
    }
  } catch { return { scope: scope.name, entries: 0, queries: 0, noData: true }; }
  if (entries.length < 3) return { scope: scope.name, entries: entries.length, queries: 0, noData: true };

  const queries = [...entries].sort((a, b) => toMs(b) - toMs(a)).slice(0, maxQueries);
  let top1Changed = 0, v1Low = 0, v2Low = 0, sum1 = 0, sum2 = 0, n = 0;
  for (const q of queries) {
    const cands = entries.filter((e) => e !== q);
    if (!cands.length) continue;
    let best1 = null, best2 = null;
    for (const e of cands) {
      const sim = cosine(q.vec, e.vec);
      const s1 = scoreV1({ sim, entry: e, query: q.text, now });
      const s2 = scoreV2({ sim, entry: e, query: q.text, now });
      if (!best1 || s1 > best1.s) best1 = { e, s: s1, sim };
      if (!best2 || s2 > best2.s) best2 = { e, s: s2, sim };
    }
    if (!best1 || !best2) continue;
    n += 1;
    if (best1.e.text !== best2.e.text) top1Changed += 1;
    if (best1.sim < 0.3) v1Low += 1;
    if (best2.sim < 0.3) v2Low += 1;
    sum1 += best1.sim; sum2 += best2.sim;
  }
  return {
    scope: scope.name, entries: entries.length, queries: n,
    top1Changed, top1ChangedRate: n ? Number((top1Changed / n).toFixed(3)) : 0,
    v1TopMeanSim: n ? Number((sum1 / n).toFixed(3)) : 0,
    v2TopMeanSim: n ? Number((sum2 / n).toFixed(3)) : 0,
    v1LowSimTop: v1Low, v2LowSimTop: v2Low,
    noData: n === 0,
  };
}

export function runShadow(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  return SCOPES.map((s) => shadowScope(s, { now, maxQueries: opts.maxQueries }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = runShadow();
  console.log('scope | entries | queries | top1Changed | v1TopSim | v2TopSim | v1低相似top | v2低相似top');
  for (const r of rows) {
    if (r.noData) { console.log(r.scope + ' | ' + (r.entries ?? 0) + ' | no-data'); continue; }
    console.log([r.scope, r.entries, r.queries, r.top1Changed + '(' + Math.round(r.top1ChangedRate * 100) + '%)', r.v1TopMeanSim, r.v2TopMeanSim, r.v1LowSimTop, r.v2LowSimTop].join(' | '));
  }
}
