// eval-recall.mjs · 记忆检索离线评测：baseline vs cross-encoder rerank（通过 recall 集成路径）
// 用法：node scripts/eval-recall.mjs [--rerank]
import fs from 'node:fs';
import { recall } from '../src/domain/memory/memory-retrieve.js';

const set = JSON.parse(fs.readFileSync(new URL('./eval/recall-eval.json', import.meta.url), 'utf8'));
const useRerank = process.argv.includes('--rerank');
const RERANK_URL = process.env.RERANK_URL || 'http://127.0.0.1:8792/rerank';

function metrics(rows) {
  const n = rows.length;
  const top1 = rows.filter((r) => r.rank === 0).length;
  const top5 = rows.filter((r) => r.rank >= 0 && r.rank < 5).length;
  const mrr = rows.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / n;
  return { n, top1, top5, mrr };
}

async function run(opts) {
  const rows = [];
  for (const item of set) {
    const r = await recall(item.query, { scope: item.scope, limit: 5, ...opts });
    const idx = r.entries.findIndex((e) => String(e.text).includes(item.expect));
    rows.push({ ...item, rank: idx, mode: r.mode, got: r.entries.map((e) => e.text.slice(0, 26)) });
  }
  return rows;
}

const base = await run({});
const bm = metrics(base);
console.log('baseline top1', bm.top1 + '/' + bm.n, 'top5', bm.top5 + '/' + bm.n, 'MRR', bm.mrr.toFixed(3));
for (const r of base) console.log(r.rank >= 0 ? '  ✓' : '  ✗', `rank=${r.rank}`, r.mode, r.query, '→', r.got[0]);

if (useRerank) {
  const rr = await run({ rerankUrl: RERANK_URL, rerankTopK: 12, rerankTimeoutMs: 8000 });
  const rm = metrics(rr);
  console.log('\nrerank  top1', rm.top1 + '/' + rm.n, 'top5', rm.top5 + '/' + rm.n, 'MRR', rm.mrr.toFixed(3));
  for (const r of rr) console.log(r.rank >= 0 ? '  ✓' : '  ✗', `rank=${r.rank}`, r.mode, r.query, '→', r.got[0]);
  console.log('\nΔtop1', rm.top1 - bm.top1, 'Δtop5', rm.top5 - bm.top5, 'ΔMRR', (rm.mrr - bm.mrr).toFixed(3));
}
