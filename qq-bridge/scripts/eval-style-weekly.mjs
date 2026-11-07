// P6 · 风格校准周报（独立脚本，读数据不碰运行中的桥接）
//
// 判据（规划 P6）：把「她自己的回复」和「本尊画像」两个数字并排列出，看偏差是否收敛。
// 输出到 stdout（人/她都能读），也可 --json 给脚本消费。
//
// 数据源：
//   她的回复  → data/state/style-profile.jsonl（桥接每群/私场景统计的 mine 段）
//   本尊画像 → 464 条语料实测：avg 8.1 / ≤6 字 58.2% / 感叹号 0.4% / 句号结尾 5.0%
//
// 用法：node scripts/eval-style-weekly.mjs [--json]

import fs from 'node:fs';
import { stateDataPath } from '../src/domain/shared/project-paths.js';

const PROFILE_FILE = stateDataPath('style-profile.jsonl');
// 本尊画像基线（464 条语料实测，见规划文档 L5）：只有这两项有实测基线，
// 其余（逗号分句/问句/emoji）风格库没采，列为观测项不判收敛。
const AUTHORED = { avgLen: 8.1, shortRatio: 0.582 };

function loadRows(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function summarize(rows) {
  // 取每个 (day,key) 的"我的回复"画像，按时间取最近 7 天
  const byKey = new Map();
  for (const r of rows) {
    const mine = r.mine;
    if (!mine || !mine.n) continue;
    const dk = `${r.day}|${r.key}`;
    const prev = byKey.get(r.key);
    // 同 key 取最新 day
    if (!prev || r.day >= prev.day) byKey.set(r.key, r);
  }
  const latest = [...byKey.values()];
  if (!latest.length) return null;
  const w = (v) => latest.reduce((a, r) => a + (r.mine?.[v] || 0), 0);
  const N = latest.length;
  const avgLen = +(w('avgLen') / N).toFixed(1);
  const shortRatio = +(w('shortRatio') / N).toFixed(3);
  const multiCommaRatio = +(w('multiCommaRatio') / N).toFixed(3);
  const questionRate = +(w('questionRate') / N).toFixed(3);
  const emojiRate = +(w('emojiRate') / N).toFixed(3);
  return { N, day: latest[latest.length - 1].day, avgLen, shortRatio, multiCommaRatio, questionRate, emojiRate };
}

const wantJson = process.argv.includes('--json');
const me = summarize(loadRows(PROFILE_FILE));

if (!me) {
  console.log('（style-profile 还没有数据，先跑几天再出周报）');
  process.exit(0);
}

const delta = (a, b, moreIsBad = true) => {
  const d = +(a - b).toFixed(2);
  return { d, drift: Math.abs(d) };
};

const report = {
  mine: me,
  authored: AUTHORED,
  deltas: {
    avgLen: delta(me.avgLen, AUTHORED.avgLen),
    shortRatio: delta(me.shortRatio, AUTHORED.shortRatio),
  },
};

if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const hasBase = (v) => v !== undefined && Number.isFinite(v);
  const rows = [
    ['指标', '我(近7天)', '本尊', '偏差'],
    ['平均字数', me.avgLen, hasBase(AUTHORED.avgLen) ? AUTHORED.avgLen : '—', hasBase(AUTHORED.avgLen) ? (me.avgLen - AUTHORED.avgLen).toFixed(1) : ''],
    ['≤6字占比', me.shortRatio, hasBase(AUTHORED.shortRatio) ? AUTHORED.shortRatio : '—', hasBase(AUTHORED.shortRatio) ? (me.shortRatio - AUTHORED.shortRatio).toFixed(3) : ''],
    ['逗号分句率', me.multiCommaRatio, '—', ''],
    ['问句率', me.questionRate, '—', ''],
    ['emoji率', me.emojiRate, '—', ''],
  ];
  console.log(`【风格校准周报 · ${me.day} · 样本 ${me.N} 场景】`);
  for (const r of rows) console.log(r.join('  '));
  const big = Object.values(report.deltas).filter((v) => Math.abs(v.d) > 0.2).length;
  console.log(big ? `⚠️ ${big} 项有基线的指标偏差 > 0.2，还没收敛（逗号分句/问句/emoji 无基线，仅观测）。` : '有基线指标偏差已收敛（≤0.2）。');
}
