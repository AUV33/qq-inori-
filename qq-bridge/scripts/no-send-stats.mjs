#!/usr/bin/env node
// 交付侧 24h 统计（只读，不改任何状态）：node scripts/no-send-stats.mjs [小时数]
// 回答一个问题：她"想说话但话没到群里"的比例有多大，以及 silence 阀门是谁在拦。
//   在：data/state/action-log.jsonl（结构化回合结果，含 wrote_not_sent）
//   在：state/bridge.log（[no-send] [unsent] [silent-guard] [self-wake] [wish] 打点）
// 纪律：只读快照，不写文件、不调接口、不打点。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOURS = Number(process.argv[2] || 24);
const NOW = Date.now();
const WIN = HOURS * 3600 * 1000;

function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n'); } catch { return []; }
}

// ── 1. 结构化回合账（action-log.jsonl + 轮转 .old） ───────────────────────────
const alRows = [];
for (const f of [`${PROJECT_ROOT}/data/state/action-log.jsonl`, `${PROJECT_ROOT}/data/state/action-log.jsonl.old`]) {
  for (const line of readLines(f)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ts = Date.parse(r.ts);
      if (Number.isFinite(ts) && NOW - ts <= WIN) alRows.push({ ...r, _ts: ts });
    } catch { /* 坏行跳过 */ }
  }
}

const turns = alRows.filter((r) => r.t === 'turn');
const outcome = { sent: 0, wrote_not_sent: 0, closed: 0, no_action: 0 };
const byTrigger = {};
const byKeyOutcome = {};
for (const t of turns) {
  const o = String(t.outcome || 'no_action');
  outcome[o] = (outcome[o] || 0) + 1;
  byTrigger[t.trigger || '?'] = (byTrigger[t.trigger || '?'] || 0) + 1;
  const k = byKeyOutcome[t.key] ||= { sent: 0, wrote_not_sent: 0, closed: 0, no_action: 0, turns: 0 };
  k.turns += 1;
  k[o] = (k[o] || 0) + 1;
}
const stash = alRows.filter((r) => r.t === 'busy_stash');
const skip = alRows.filter((r) => r.t === 'wake_skip');

// ── 2. 桥接日志打点（bridge.log + .1，本地时间 HH:MM:SS） ─────────────────────
function parseLogTime(hh, mm, ss) {
  const d = new Date();
  d.setHours(Number(hh), Number(mm), Number(ss), 0);
  if (d.getTime() > NOW + 60_000) d.setDate(d.getDate() - 1); // 未来时间 ⇒ 昨天的
  return d.getTime();
}
const MARKERS = [
  ['no-send', '只写文字没发（挂了补发提醒）', /\[no-send\][^)]*?（(\d+) 字）/],
  ['no-send-resent', '补发提醒被注入', /\[no-send\] .*注入补发提醒/],
  ['unsent', '挂心事沉底（没发出去的字进容器）', /\[unsent\]/],
  ['silent-guard', '沉默闸提醒她开口', /\[silent-guard\]/],
  ['self-wake', '她自己叫醒自己', /\[self-wake\]/],
  ['wish', '愿望容器打点', /\[wish\]/],
];
const markerCounts = {};
const markerByKey = {};
const markerLines = {};
for (const f of ['state/bridge.log', 'state/bridge.log.1']) {
  for (const line of readLines(path.join(ROOT, f))) {
    const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\s/);
    if (!m) continue;
    const ts = parseLogTime(m[1], m[2], m[3]);
    if (NOW - ts > WIN) continue;
    for (const [id, , re] of MARKERS) {
      if (!re.test(line)) continue;
      markerCounts[id] = (markerCounts[id] || 0) + 1;
      const km = line.match(/(group:\d+|private:\d+)/);
      if (km) (markerByKey[id] ||= {})[km[1]] = ((markerByKey[id] ||= {})[km[1]] || 0) + 1;
      (markerLines[id] ||= []).push(line.slice(0, 160));
    }
  }
}

// ── 3. 输出 ────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`# 交付侧统计（近 ${HOURS} 小时，只读）${new Date(NOW).toLocaleString('zh-CN')}`);
console.log('');
if (!turns.length && !markerCounts['no-send']) {
  console.log('这个窗口内没有回合记录，也没有 no-send 打点。');
  process.exit(0);
}
console.log(`## 一、回合结果（${turns.length} 回合）`);
console.log(`开口 ${outcome.sent}（${pct(outcome.sent, turns.length)}）· **写没发 ${outcome.wrote_not_sent}（${pct(outcome.wrote_not_sent, turns.length)}）** · 安静收尾 ${outcome.closed} · 没动 ${outcome.no_action}`);
console.log(`触发：${Object.entries(byTrigger).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(' · ') || '—'}`);
console.log(`阀门：繁忙暂存 ${stash.length} · 限流跳过 ${skip.length}`);
console.log('');
console.log('## 二、按会话');
const keys = Object.keys(byKeyOutcome).sort();
for (const k of keys) {
  const v = byKeyOutcome[k];
  console.log(`- ${k}：${v.turns} 回合｜开口 ${v.sent}｜写没发 ${v.wrote_not_sent}｜安静收尾 ${v.closed}｜没动 ${v.no_action}`);
}
console.log('');
console.log('## 三、桥接打点');
for (const [id, label] of MARKERS) {
  const n = markerCounts[id] || 0;
  const per = markerByKey[id] ? Object.entries(markerByKey[id]).map(([k, v]) => `${k} ×${v}`).join(' · ') : '';
  console.log(`- ${label}：${n}${per ? `（${per}）` : ''}`);
}
const noSend = markerCounts['no-send'] || 0;
if (noSend) {
  console.log('');
  console.log('## 四、最近的「只写文字没发」原文（判断是漏发的消息还是她自己的记录）');
  for (const l of (markerLines['no-send'] || []).slice(-6)) console.log(`- ${l}`);
}
