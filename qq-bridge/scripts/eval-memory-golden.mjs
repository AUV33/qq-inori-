#!/usr/bin/env node
// eval-memory-golden.mjs · 用人工标注的召回金标准算 NDCG@k（离线，不启动服务）
//
// 标注文件：data/eval/memory-golden.json（UTF-8）
// [
//   { "query": "他生日是哪天", "scope": "private", "expect": ["10月26日", "生日"] }
// ]
// 约束：query 文本必须已存在于嵌入缓存（曾作为记忆/查询被嵌入过），否则该行跳过。
// 输出：v1 / v2 各自的 meanNdcg 与逐条明细。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cosine } from './memory-score-shadow.mjs';
import { scoreV1, scoreV2 } from './memory-score-shadow.mjs';
import { evaluateGolden } from './lib/recall-eval.mjs';
import { defaultScopes } from './lib/memory-scopes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MEM = path.join(ROOT, 'data', 'memory');
const GOLDEN = process.env.MEMORY_GOLDEN_FILE || path.join(ROOT, 'data', 'eval', 'memory-golden.json');
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// [PRIVACY] 真实群号不再写死在源码里（privacy-scan 会拦），改为从本地记忆文件动态发现。
const SCOPES = defaultScopes(ROOT);

function loadScope(scope) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(MEM, scope.cache), 'utf8')); } catch { return { entries: [], cache: {} }; }
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
  } catch { /* no file */ }
  return { entries, cache };
}

export function runGolden(file = GOLDEN, { k = 5 } = {}) {
  let golden;
  try { golden = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'no-golden-file' }; }
  const queries = Array.isArray(golden) ? golden : (golden.queries ?? []);
  const loaded = new Map(SCOPES.map((s) => [s.name, loadScope(s)]));
  const now = Date.now();
  const qs = [];
  for (const q of queries) {
    const scopeName = q.scope || 'private';
    const scope = loaded.get(scopeName) || loaded.get('private');
    if (!scope) continue;
    const qv = scope.cache[sha(q.query)];
    if (!Array.isArray(qv)) continue;
    qs.push({ ...q, _scope: scope, _qv: qv });
  }
  if (!qs.length) return { ok: true, reason: 'no-query-vectors', k, count: 0 };

  const rankBy = (scoreFn) => (q) => {
    const rows = q._scope.entries.filter((e) => e.text !== q.query).map((e) => ({ text: String(e.text), score: scoreFn({ sim: cosine(q._qv, e.vec), entry: e, query: q.query, now }) }));
    rows.sort((a, b) => b.score - a.score);
    return rows.map((r) => r.text);
  };
  const v1 = evaluateGolden({ queries: qs, retrieve: rankBy(scoreV1), k });
  const v2 = evaluateGolden({ queries: qs, retrieve: rankBy(scoreV2), k });
  return {
    ok: true, k, count: qs.length,
    v1: { meanNdcg: v1.meanNdcg, rows: v1.rows },
    v2: { meanNdcg: v2.meanNdcg, rows: v2.rows },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(GOLDEN)) {
    console.log('还没有金标准文件：' + GOLDEN);
    console.log('格式（JSON 数组）：');
    console.log(JSON.stringify([{ query: '他生日是哪天', scope: 'private', expect: ['10月26日', '生日'] }], null, 2));
    process.exit(0);
  }
  const r = runGolden(GOLDEN);
  if (!r.ok) { console.error('读取失败：' + r.reason); process.exit(1); }
  if (r.reason) { console.log('跳过：' + r.reason + '（query 必须已存在嵌入缓存）'); process.exit(0); }
  console.log('queries=' + r.count + ' k=' + r.k);
  console.log('v1 meanNdcg=' + r.v1.meanNdcg + '  v2 meanNdcg=' + r.v2.meanNdcg);
  for (let i = 0; i < r.v1.rows.length; i += 1) {
    const a = r.v1.rows[i], b = r.v2.rows[i];
    console.log('- ' + a.query + ' | v1 ' + a.ndcg + ' | v2 ' + b.ndcg + ' | hits ' + a.hits);
  }
}
