#!/usr/bin/env node
// token-report.mjs · token 账本报表（按会话/按天/成本），回答"钱花在哪"
//
// 数据源：state/token-usage.jsonl（桥接每步记录 b.cacheHit / cacheMiss / output）
// 价格：src/model-prices.js（deepseek-flash 平价：hit 0.02 / miss 1 / out 4 元每百万 token）
//
// 用法：node scripts/token-report.mjs [--days=7] [--top=8]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ratesAt } from '../src/domain/persona/model-prices.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'state', 'token-usage.jsonl');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const DAYS = Math.max(1, arg('days', 7));
const TOP = Math.max(1, arg('top', 8));

function loadRows() {
  const rows = [];
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return rows; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.k === 'turn' && r.b) rows.push(r);
    } catch { /* 坏行跳过 */ }
  }
  return rows;
}

const rows = loadRows();
if (!rows.length) { console.log(`没有账本数据：${FILE}`); process.exit(0); }

const since = Date.now() - DAYS * 86400_000;
const recent = rows.filter((r) => Number(r.t) >= since);
const price = ratesAt('deepseek-flash', Date.now());

const yuan = (miss, hit, out) =>
  (miss / 1e6) * price.cacheMiss + (hit / 1e6) * price.cacheHit + (out / 1e6) * price.output;

function agg(list, keyFn) {
  const m = new Map();
  for (const r of list) {
    const k = String(keyFn(r));
    const a = m.get(k) ?? { n: 0, miss: 0, hit: 0, out: 0 };
    a.n += 1;
    a.miss += Number(r.b.cacheMiss) || 0;
    a.hit += Number(r.b.cacheHit) || 0;
    a.out += Number(r.b.output) || 0;
    m.set(k, a);
  }
  return [...m.entries()].map(([k, a]) => ({ k, ...a, cost: yuan(a.miss, a.hit, a.out) }))
    .sort((x, y) => y.cost - x.cost);
}

const byKey = agg(recent, (r) => r.key ?? r.sid);
const totalCost = byKey.reduce((s, x) => s + x.cost, 0);
const totalSteps = recent.length;
const avgCtx = totalSteps ? recent.reduce((s, r) => s + (Number(r.b.cacheHit) || 0) + (Number(r.b.cacheMiss) || 0), 0) / totalSteps : 0;

console.log(`=== token 报表（近 ${DAYS} 天）===`);
console.log(`steps ${totalSteps} ｜ 成本 ¥${totalCost.toFixed(2)}（日均 ¥${(totalCost / DAYS).toFixed(2)}）｜ 平均每步 ${(avgCtx / 1000).toFixed(0)}k tokens\n`);
console.log('会话'.padEnd(28) + 'steps'.padStart(6) + 'miss'.padStart(8) + 'hit'.padStart(8) + 'out'.padStart(7) + '成本'.padStart(9));
for (const x of byKey.slice(0, TOP)) {
  console.log(
    x.k.padEnd(28)
    + String(x.n).padStart(6)
    + (x.miss / 1e6).toFixed(1).padStart(8)
    + (x.hit / 1e6).toFixed(0).padStart(8)
    + (x.out / 1e6).toFixed(2).padStart(7)
    + ('¥' + x.cost.toFixed(2)).padStart(9),
  );
}
console.log('\n按天：');
for (const x of agg(recent, (r) => new Date(Number(r.t)).toISOString().slice(0, 10))) {
  console.log(`  ${x.k}  steps=${String(x.n).padStart(5)}  ¥${x.cost.toFixed(2)}`);
}
