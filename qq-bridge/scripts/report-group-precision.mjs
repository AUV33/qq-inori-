#!/usr/bin/env node
// 群聊「人的指标」报告（零 LLM、只读）
//
// 不用配额/次数当目标，只看三件事：
//   误开口率 = 她开口的回合里，那批消息中没有人直接对她说的比例
//   被接住率 = 她上一条之后有人回她的比例（按唤醒采样）
//   漏接率   = 有人直接对她说、但那一轮她没开口的比例
//
// 数据来自 bridge 在 state/social-v2.json 里维护的 metrics 计数。
// 用法：node scripts/report-group-precision.mjs [--json]
import fs from 'node:fs';
import { bridgePath } from '../src/domain/shared/project-paths.js';

const asJson = process.argv.includes('--json');
const file = bridgePath('state', 'social-v2.json');
let state;
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.error(`读不到 ${file}: ${e.message}`);
  process.exit(1);
}

const rows = [];
for (const [key, st] of Object.entries(state.conversations || {})) {
  if (!key.startsWith('group:')) continue;
  const m = st.metrics || {};
  const wakes = Number(m.wakes) || 0;
  const wakesDirected = Number(m.wakesDirected) || 0;
  const sends = Number(m.sends) || 0;
  const sendsUndirected = Number(m.sendsUndirected) || 0;
  const pickedUp = Number(m.pickedUp) || 0;
  const missedDirected = Number(m.missedDirected) || 0;
  const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : '—');
  rows.push({
    key, wakes, wakesDirected, sends, sendsUndirected, pickedUp, missedDirected,
    误开口率: pct(sendsUndirected, sends),
    被接住率: pct(pickedUp, sends),
    漏接率: pct(missedDirected, wakesDirected),
    lastWakeReason: st.lastWakeReason || '',
    topic: st.topicStack?.[0]?.gist || '',
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    console.log(`\n=== ${r.key} ===`);
    console.log(`唤醒 ${r.wakes}（其中有人直接叫她 ${r.wakesDirected}）｜开口 ${r.sends}（没人叫她 ${r.sendsUndirected}）`);
    console.log(`误开口率 ${r.误开口率}｜被接住率 ${r.被接住率}｜漏接率 ${r.漏接率}`);
    console.log(`上次唤醒理由 ${r.lastWakeReason || '—'}｜当前话题 ${r.topic || '—'}`);
    if (!r.wakes && !r.sends) console.log('（还没有计数：metrics 在每次唤醒/发送时累加）');
  }
  if (!rows.length) console.log('没有群会话。');
}
