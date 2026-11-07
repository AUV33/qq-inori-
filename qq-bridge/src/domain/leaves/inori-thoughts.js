// inori-thoughts.js · 她自己的念头：从她的自主回合（独处/反思）里捕获，跨会话持续
//
// 为什么需要：她有 mood、goals、经验，但**想法是转瞬即逝的**——每轮结束就没了。
// 真人会带着"我最近在想什么"继续下一次对话。这里把自主回合的输出里像"想法"的句子
// 落盘，下次唤醒注入最近几条，形成连续的"我在想"。
//
// 存储：data/state/thoughts.jsonl，每行 {at, kind, text}
// 只保留最近 50 条（防膨胀）。

import fs from 'node:fs';
import { atomicWriteText } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';
import { rewriteJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

const FILE = stateDataPath('thoughts.jsonl');
const MAX_KEEP = 50;

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function rewrite(rows) {
  try {
    const r = rewriteJsonl(FILE, rows.slice(-MAX_KEEP), { source: 'bridge/thoughts' });
    if (!r.ok) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      atomicWriteText(FILE, rows.slice(-MAX_KEEP).map((x) => JSON.stringify(x)).join('\n') + '\n');
    }
  } catch (error) {
    try { console.error('[thoughts] 写入失败:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-thoughts.js:34'); }
  }
}

/** 记录一条念头 */
export function appendThought(kind, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 6) return null;
  const row = { at: new Date().toISOString(), kind: String(kind || 'thought'), text: t.slice(0, 200) };
  const rows = readAll();
  // 近似去重
  if (rows.slice(-10).some((r) => r.text === row.text)) return null;
  rows.push(row);
  rewrite(rows);
  return row;
}

/** 最近 n 条念头（最新在前） */
export function recentThoughts(n = 3) {
  return readAll().slice(-Math.max(1, n)).reverse();
}

/** 渲染成唤醒提示；没有就不注入 */
/** [L3] 能注入的念头：必须有中文（英文 reasoning 不是她的"念头"） */
export function pickRenderableThoughts(rows, n = 3) {
  const want = Math.max(1, Number(n) || 3);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && /[\u4e00-\u9fa5]/.test(String(r.text || '')))
    .map((r) => {
      // [L3] 去掉行首英文脚手架（"Maybe: cognition: " / "Wait — there's a note: "），
      // 只保留从第一个汉字开始的内容；剥完没实质内容就丢弃。
      const t = String(r.text || '').trim();
      const i = t.search(/[\u4e00-\u9fa5]/);
      const cleaned = i > 0 && i <= 40 ? t.slice(i) : t;
      return { ...r, text: cleaned };
    })
    .filter((r) => String(r.text || '').trim().length >= 6)
    .slice(-want);
}

export function renderThoughts(n = 3) {
  // [L3] 兜底：存量里可能有英文 reasoning 行，注入时跳过（文件保留，不删数据）
  const rows = pickRenderableThoughts(recentThoughts(Math.max(n * 3, 9)), n);
  if (!rows.length) return '';
  const lines = rows.map((r) => `- ${r.text}`);
  return `【我最近在想】\n${lines.join('\n')}\n（这些是我自己起的念头，不是谁让我想的。想聊就接着聊，不想聊就放着。）`;
}

/** 从一段自主回合输出里抽"像念头"的句子 */
export function extractThoughtLines(text, limit = 3) {
  const raw = String(text || '');
  const out = [];
  for (const line of raw.split(/\n+/)) {
    let s = line.replace(/^[-*#>\s]+/, '').replace(/^【[^】]*】/, '').trim();
    if (!s || s.length < 8 || s.length > 120) continue;
    // 排除明显的格式/标题/工具痕迹
    if (/^(工具|调用|assistant|user|system|思考|输出|结果)[:：]/.test(s)) continue;
    if (/[{}<>]/.test(s)) continue;
    // [THOUGHTS-FIX] 纯标记行不是念头（实测抽到过 "[SILENT]"）：
    // 没有中文也没有小写字母的行（[SILENT]/纯标点/纯数字）一律跳过
    if (!/[\u4e00-\u9fa5a-z]/.test(s)) continue;
    if (/^\[(SILENT|SKIP|END|DONE|NO_?REPLY)\]$/i.test(s)) continue;
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// ── 念头 → 目标：同一个念头反复出现，就值得排进「手头的事」──────────────
const GOAL_FILE = stateDataPath('thought-goals.jsonl');

function norm2(t) {
  return String(t || '').replace(/[\s\p{P}\p{S}]/gu, '');
}
function grams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 这个念头在最近记录里出现过几次（含自己） */
export function similarThoughtCount(text, threshold = 0.75) {
  const a = norm2(text);
  if (a.length < 4) return 0;
  const ga = grams(a);
  let n = 0;
  for (const r of readAll().slice(-40)) {
    const b = norm2(r.text);
    if (!b) continue;
    const gb = grams(b);
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    const sim = (2 * inter) / (ga.size + gb.size || 1);
    if (sim >= threshold) n++;
  }
  return n;
}

function readGoalIdeas() {
  try {
    return fs.readFileSync(GOAL_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 把反复想到的事记成「目标候选」 */
export function addGoalIdea(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const rows = readGoalIdeas();
  if (rows.some((r) => norm2(r.text) === norm2(t))) return null;
  const row = { at: new Date().toISOString(), text: t.slice(0, 120) };
  rows.push(row);
  try {
    const r = rewriteJsonl(GOAL_FILE, rows.slice(-30), { source: 'bridge/goal-ideas' });
    if (!r.ok) {
      fs.mkdirSync(path.dirname(GOAL_FILE), { recursive: true });
      atomicWriteText(GOAL_FILE, rows.slice(-30).map((x) => JSON.stringify(x)).join('\n') + '\n');
    }
  } catch (error) {
    try { console.error('[thoughts] goal-idea 写入失败:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-thoughts.js:156'); }
  }
  return row;
}

/** 渲染「反复想的事」提示 */
export function renderGoalIdeas(n = 2) {
  const rows = readGoalIdeas().slice(-n);
  if (!rows.length) return '';
  return `【反复想的事】\n${rows.map((r) => `- ${r.text}`).join('\n')}\n（想过不止一次了就值得排进手头的事；用 goal_add 记一条，或者决定放下。）`;
}
