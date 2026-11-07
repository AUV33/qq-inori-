// inori-rumination.js · 情绪反刍：强事件留下的"绕不开"，随时间衰减，确定性注入
//
// 为什么需要：人的反应弧不是一次性的——被纠正/搞砸了一件事，几小时后还会想起来。
// 她的反应目前只有"当下"（回复），没有"余温"。这个模块把余温变成可注入的事实：
//
//   来源（全确定性，不靠模型自觉）：
//     ① 她回复里的自我批评模式（"其实是我想多了 / 本来应该 / 搞砸了"）
//     ② 被纠正（他/群友指出她错了——她回复里出现"被你提醒 / 你说得对 / 我搞错"）
//     ③ 任务卡住（activityTracker stuck 段收尾：那件事没做成，会惦记）
//
//   衰减（纯时间函数，可重放）：
//     ≤2h  0.8（新鲜，最容易冒出来）
//     2-8h 0.5（还在想）
//     8-24h 0.25（偶尔想起来）
//     >48h 停止注入（记录保留，不清理——经验/记忆只增不删的项目原则）
//
//   消化（闭环）：她把反刍的那件事说出口（近 10 条她的话里含反刍核心词）→ consumed，不再注入
//
// 约束：有界（每天最多记 4 条，只注入最近 24h 的前 2 条）/ 可关（enabled=false 零影响）/
// 只陈述事实（"你惦记着 X"），不替她决定"该说什么"。
// 落盘：data/state/ruminations.jsonl

import fs from 'node:fs';
import path from 'node:path';
import { rewriteJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

const DEFAULT_FILE = stateDataPath('ruminations.jsonl');

// ── 来源检测（只看她自己说的短句，命中即记）────────────────────────
const SELF_CRITIC = /其实是我?想多了|我本来应该|搞得这么乱|搞砸了|我搞错|不该这么(说|回)|我刚才(那句|那个)(有点|太)|反应慢了|没接住|太直接了|说漏了/;
const CORRECTED = /你说得对|被你(提醒|指)了?|我搞错(了|了个)?|是我记错|原来是我(没|搞)/;
const FAILED_TASK = /卡住了|做不完|干了一半|没弄成|掉线了得等|得等他(重新|再)/;

export function detectRumination(text) {
  const t = String(text ?? '');
  if (!t || t.length > 120) return null; // 长段不做来源（反刍是"一句话扎了一下"，不是总结）
  if (SELF_CRITIC.test(t)) return { intensity: 0.8, source: 'self-criticism', core: t.slice(0, 40) };
  if (CORRECTED.test(t)) return { intensity: 0.7, source: 'corrected', core: t.slice(0, 40) };
  if (FAILED_TASK.test(t)) return { intensity: 0.6, source: 'task-failed', core: t.slice(0, 40) };
  return null;
}

// ── 衰减（纯函数）──────────────────────────────────────────────────
export function decayOf(row, now = Date.now()) {
  const ageH = Math.max(0, (now - Number(row.at || now)) / 3600000);
  if (ageH > 48) return 0;            // 48h 后不再注入（记录保留）
  if (ageH <= 2) return row.intensity ?? 0.8;
  if (ageH <= 8) return (row.intensity ?? 0.8) * 0.6;
  if (ageH <= 24) return (row.intensity ?? 0.8) * 0.35;
  return 0;
}

// ── 落盘 ───────────────────────────────────────────────────────────
function readAll(file = DEFAULT_FILE) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 记一条反刍（每天 4 条上限，防刷屏） */
export function addRumination(row, file = DEFAULT_FILE, now = Date.now()) {
  try {
    const rows = readAll(file);
    const today = rows.filter((r) => now - Number(r.at || 0) < 24 * 3600000).length;
    if (today >= 4) return null;
    const keep = (all) => {
      // 安全阀：只保留最近 100 条（≈25 天，注入只用最近 24h，更早的记录无功能价值；防文件无限膨胀）
      const r = rewriteJsonl(file, all.slice(-100), { source: 'bridge/rumination' });
      if (!r.ok) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, all.slice(-100).map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8'); }
    };
    // 去重：同 core 的 24h 内已有 → 只刷新时间
    const dup = rows.find((r) => r.core === row.core && now - Number(r.at || 0) < 24 * 3600000);
    if (dup) { dup.at = now; dup.consumed = false; keep(rows); return dup; }
    const r = { core: row.core, text: row.core, intensity: row.intensity ?? 0.8, source: row.source, key: row.key || '', at: now, consumed: false };
    rows.push(r);
    keep(rows);
    return r;
  } catch { return null;
  }
}

/**
 * 注入渲染：最近 24h、未消化、强度>0 的前 2 条。
 * recentSelfTexts：她最近说过的话（用于判定"已消化"）。
 */
export function renderRuminations(file = DEFAULT_FILE, recentSelfTexts = [], now = Date.now()) {
  let rows = [];
  try { rows = readAll(file); } catch { return ''; }
  const fresh = rows.filter((r) => now - Number(r.at || 0) < 24 * 3600000);
  // 消化判定：她近话里含反刍核心词（取 core 前 6 字的去标点核心）
  const selfAll = (recentSelfTexts || []).join(' ');
  for (const r of fresh) {
    if (!r.consumed) {
      const probe = String(r.core).replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '').slice(0, 6);
      if (probe.length >= 3 && selfAll.includes(probe)) r.consumed = true; // 她说了 → 消化
    }
  }
  const active = fresh
    .filter((r) => !r.consumed && decayOf(r, now) > 0.2)
    .sort((a, b) => Number(b.at) - Number(a.at))
    .slice(0, 2);
  if (!active.length) return '';
  const lines = active.map((r) => {
    const ageH = Math.max(1, Math.round((now - Number(r.at)) / 3600000));
    const mood = decayOf(r, now) >= 0.5 ? '最近一直在想' : '偶尔会想起来';
    return `- ${mood}：「${String(r.core).slice(0, 40)}」（${ageH} 小时前的事，${r.source === 'corrected' ? '被纠正后' : r.source === 'task-failed' ? '那件事没做成' : '自己觉得别扭'}）。想接就自然接，不想提就放一边，别硬说。`;
  });
  return `【你一直在惦记的】\n${lines.join('\n')}`;
}
