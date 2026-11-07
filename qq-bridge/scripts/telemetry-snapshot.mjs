#!/usr/bin/env node
// telemetry-snapshot.mjs · 运行证据快照
//
// 干什么：把「延迟/部署（health）+ token 花费 + 版本」聚合成一条可回顾 JSONL，
//         追加到 logs/telemetry/<日期>.jsonl。配合看护/cron 周期运行即形成证据链，
//         让 README 的宣称（在线/延迟/花费）可被事后核对。
// 不依赖在跑的服务：health 探测不到就记 down，token 账本没有就记 0。
// 失败模式：单源读取失败只告警，不影响其余字段落盘。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..');
const STATE = path.join(BRIDGE, 'state');
const LOG_DIR = path.join(BRIDGE, 'logs', 'telemetry');

function readJsonlSafe(p) {
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return rows;
}

// 1) 健康 + 延迟 + 部署（复用 health-check --json，避免重复探测逻辑）
let health = null;
try {
  const out = execFileSync('node', [path.join(HERE, 'health-check.mjs'), '--json'], { encoding: 'utf8', timeout: 30000 });
  health = JSON.parse(out);
} catch (error) {
  health = { error: String(error?.message ?? error) };
}

// 2) token / 花费（state/token-usage.jsonl 原始账本，按近 N 天聚合）
const DAYS = 7;
const since = Date.now() - DAYS * 86400000;
const rows = readJsonlSafe(path.join(STATE, 'token-usage.jsonl'))
  .filter((r) => r.k === 'turn' && r.b && Number(r.t) >= since);
let tokenCost = 0;
try {
  const { ratesAt } = await import('../src/domain/persona/model-prices.js');
  const price = ratesAt('deepseek-flash', Date.now());
  const yuan = (miss, hit, out) =>
    (miss / 1e6) * price.cacheMiss + (hit / 1e6) * price.cacheHit + (out / 1e6) * price.output;
  tokenCost = rows.reduce(
    (s, r) => s + yuan(Number(r.b.cacheMiss) || 0, Number(r.b.cacheHit) || 0, Number(r.b.output) || 0),
    0,
  );
} catch { /* 价格算不出则只报 token 量 */ }
const token = {
  days: DAYS,
  steps: rows.length,
  cacheMiss: rows.reduce((s, r) => s + (Number(r.b.cacheMiss) || 0), 0),
  cacheHit: rows.reduce((s, r) => s + (Number(r.b.cacheHit) || 0), 0),
  output: rows.reduce((s, r) => s + (Number(r.b.output) || 0), 0),
  costYuan: Number(tokenCost.toFixed(2)),
};

// 3) 部署（版本）
let version = null;
try { version = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8')).version; } catch { /* 读不到则 null */ }

const rec = {
  at: new Date().toISOString(),
  version,
  health: health && !health.error
    ? {
        ok: health.ok,
        events24h: health.events24h,
        probes: health.results.map((r) => ({ id: r.id, status: r.status, ms: r.ms })),
      }
    : health,
  token,
};

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.appendFileSync(
  path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`),
  JSON.stringify(rec) + '\n',
  'utf8',
);
console.log(`telemetry 快照已写入 logs/telemetry/${new Date().toISOString().slice(0, 10)}.jsonl`);
console.log(`  健康: ${health?.ok ? 'OK' : (health?.error ? '探测失败' : 'DOWN')} ｜ 近${DAYS}天 steps=${token.steps} 花费 ¥${token.costYuan}`);
