// 只读诊断：统计 attention gate 分布（原 scripts/_gate-dist.mjs，2026-10-27 迁入 diagnostics/）
import fs from 'node:fs';
import { bridgePath } from '../../src/domain/shared/project-paths.js';

const lines = fs.readFileSync(bridgePath('state', 'attention-gate.log'), 'utf8').split('\n').filter(Boolean);
const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const stage1 = recs.filter((r) => r.stage === 1 && Number.isFinite(r.cosBest));
const cos = stage1.map((r) => r.cosBest).sort((a, b) => a - b);
const q = (p) => (cos.length ? cos[Math.min(cos.length - 1, Math.floor(p * cos.length))] : 0);
const pass = stage1.filter((r) => r.pass).length;
console.log('stage1条数:', stage1.length, '| 粗筛pass:', pass, '| 被卡:', stage1.length - pass);
console.log('cosBest分布 min/p25/p50/p75/p90/max:',
  [cos[0], q(0.25), q(0.5), q(0.75), q(0.9), cos[cos.length - 1] ?? 0].map((x) => x.toFixed(3)).join(' '));
for (const th of [0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4]) {
  const p = cos.filter((x) => x >= th).length;
  console.log(`  阈值${th.toFixed(2)}: ${(100 * p / (stage1.length || 1)).toFixed(1)}% 批次过粗筛`);
}
// 最近 50 条被卡批次的 cos（离阈值最近的多大）
const recent = stage1.slice(-50).map((r) => r.cosBest).sort((a, b) => a - b);
console.log('最近50拍 cos p50/p90:', recent[Math.floor(recent.length * 0.5)].toFixed(3), recent[Math.floor(recent.length * 0.9)].toFixed(3));
