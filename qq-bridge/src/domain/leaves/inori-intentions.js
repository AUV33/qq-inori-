// inori-intentions.js · 她自己的意图账本（P0 个体性/能动性地基）
//
// 只做“意图”的状态与渲染，不判断她该做什么：
//   open      已经想到、还没开始
//   active    正在做
//   done      做完了
//   dropped   她自己放下了（不是失败）
//   blocked   卡住，等条件/等别人
//
// 纪律：意图的 why/expected 由她写；系统只能建议，不能替她创建 her 意图。
// 本模块同时提供文件读写，但纯函数部分可单测（create/transition/active/render）。

import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

const STATUSES = new Set(['open', 'active', 'done', 'dropped', 'blocked']);
const SOURCES = new Set(['her', 'owner', 'system']);

export function createIntention({ text, source = 'her', why = '', dueAt = 0, expected = '', now = Date.now(), id, goalId = '' } = {}) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!body) throw new Error('意图不能为空');
  return {
    id: String(id || `int_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    text: body,
    source: SOURCES.has(source) ? source : 'her',
    why: String(why ?? '').trim().slice(0, 240),
    expected: String(expected ?? '').trim().slice(0, 240),
    dueAt: Number(dueAt) || 0,
    goalId: String(goalId || '').slice(0, 80),
    status: 'open',
    createdAt: now,
    updatedAt: now,
    closedAt: 0,
    evidence: [],
  };
}

export function transitionIntention(list, id, status, { now = Date.now(), evidence = '' } = {}) {
  if (!STATUSES.has(status)) throw new Error(`未知意图状态：${status}`);
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map((x) => {
    if (!x || x.id !== id) return x;
    changed = true;
    const item = { ...x, status, updatedAt: now };
    if (status === 'done' || status === 'dropped') item.closedAt = now;
    if (evidence) item.evidence = [...(Array.isArray(x.evidence) ? x.evidence : []), String(evidence).slice(0, 240)].slice(-10);
    return item;
  });
  if (!changed) throw new Error(`没有这条意图：${id}`);
  return next;
}

export function activeIntentions(list, { limit = 3 } = {}) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && (x.status === 'open' || x.status === 'active'))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, Math.max(1, Number(limit) || 3));
}

export function renderIntentionsBlock(list, { limit = 3 } = {}) {
  const rows = activeIntentions(list, { limit });
  if (!rows.length) return '';
  const lines = rows.map((x) => {
    const status = x.status === 'active' ? '在做' : '挂着';
    const why = x.why ? `（因为：${x.why}）` : '';
    return `- [${status}] ${x.text}${why}`;
  });
  return `【你自己挂着的事】\n${lines.join('\n')}\n你可以继续、换、放下；不想做也可以。`;
}

export function loadIntentions(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw?.intentions) ? raw.intentions : (Array.isArray(raw) ? raw : []);
  } catch { return []; }
}

export function saveIntentions(file, list) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ intentions: Array.isArray(list) ? list : [] }, null, 2), 'utf8');
    renameWithRetry(tmp, file);
    return true;
  } catch { return false; }
}
