// inori-learning-items.js · 她想学/想练的事（学习项）
//
// 设计边界：
//   · 学习项由她决定（owner 的请求也只能当素材，不自动建）；harness 只存、只递事实。
//   · 同时最多 1 件 practicing；其余 exploring/paused，不催。
//   · 没有 criterion 的学习项不能进入 practicing——先写清“什么叫比上次好”。
//
// 存储：data/state/learning-items.json —— { version, items: [...] }，原子写。

import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('learning-items.json'),
  maxItems: 100,
  maxActive: 5,
  maxPracticing: 1,
};

const STATUSES = ['exploring', 'practicing', 'paused', 'done', 'dropped'];
const nowIso = () => new Date().toISOString();
const clip = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');

function normalize(x) {
  if (!x || typeof x !== 'object') return null;
  const title = clip(x.title, 80);
  if (!title) return null;
  return {
    id: String(x.id ?? ''),
    title,
    why: clip(x.why, 160),
    source: ['her', 'owner', 'failure', 'curiosity'].includes(x.source) ? x.source : 'her',
    status: STATUSES.includes(x.status) ? x.status : 'exploring',
    criterion: clip(x.criterion, 160),
    nextDrill: clip(x.nextDrill, 160),
    attempts: Math.max(0, Number(x.attempts) || 0),
    evidence: Array.isArray(x.evidence) ? x.evidence.map(String).slice(-20) : [],
    tags: Array.isArray(x.tags) ? x.tags.map(String).slice(0, 8) : [],
    createdAt: String(x.createdAt ?? nowIso()),
    updatedAt: String(x.updatedAt ?? x.createdAt ?? nowIso()),
    lastPracticedAt: String(x.lastPracticedAt ?? ''),
  };
}

export function load(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(j?.items) ? j.items : [];
    return items.map(normalize).filter(Boolean).slice(-DEFAULTS.maxItems);
  } catch { return []; }
}

export function save(items, file = DEFAULTS.file) {
  const list = (Array.isArray(items) ? items : []).map(normalize).filter(Boolean).slice(-DEFAULTS.maxItems);
  const r = writeJsonDocument(file, { version: 1, items: list }, { source: 'learning-items' });
  if (!r.ok) throw new Error(r.error || '学习项写入失败');
  return list;
}

const activeOf = (items) => (Array.isArray(items) ? items : []).filter((x) => ['exploring', 'practicing', 'paused'].includes(x.status));

export function create(items, { title, why = '', source = 'her', criterion = '', nextDrill = '', tags = [] } = {}) {
  const body = clip(title, 80);
  if (!body) return { ok: false, reason: 'empty' };
  const list = Array.isArray(items) ? items : [];
  if (activeOf(list).length >= DEFAULTS.maxActive) return { ok: false, reason: `active-limit(${DEFAULTS.maxActive})` };
  if (list.some((x) => x.title === body && ['exploring', 'practicing', 'paused'].includes(x.status))) {
    return { ok: false, reason: 'duplicate' };
  }
  const item = normalize({
    id: 'li' + crypto.randomBytes(4).toString('hex'),
    title: body, why, source, status: 'exploring', criterion, nextDrill, tags,
    createdAt: nowIso(), updatedAt: nowIso(),
  });
  list.push(item);
  return { ok: true, item };
}

export function update(items, id, patch = {}) {
  const list = Array.isArray(items) ? items : [];
  const item = list.find((x) => x.id === String(id));
  if (!item) return { ok: false, reason: 'not-found' };
  if (patch.title !== undefined) item.title = clip(patch.title, 80) || item.title;
  if (patch.why !== undefined) item.why = clip(patch.why, 160);
  if (patch.criterion !== undefined) item.criterion = clip(patch.criterion, 160);
  if (patch.nextDrill !== undefined) item.nextDrill = clip(patch.nextDrill, 160);
  if (patch.evidence !== undefined) item.evidence = (Array.isArray(patch.evidence) ? patch.evidence : [patch.evidence]).map(String).filter(Boolean).slice(-20);
  if (patch.status === 'done') {
    const ev = patch.evidence !== undefined
      ? String(patch.evidence || '').trim()
      : (item.evidence || []).slice(-1)[0] || '';
    if (!ev) return { ok: false, reason: 'evidence-required' };
  }
  if (patch.status !== undefined && STATUSES.includes(patch.status)) item.status = patch.status;
  if (patch.status === 'practicing') {
    if (!item.criterion) return { ok: false, reason: 'criterion-required' };
    // 同时只允许 1 件 practicing：其余 practicing 自动转 paused（不删除、不催）
    for (const other of list) {
      if (other !== item && other.status === 'practicing') other.status = 'paused';
    }
  }
  if (patch.touchPractice) item.lastPracticedAt = nowIso();
  if (patch.attempts !== undefined) item.attempts = Math.max(0, Number(patch.attempts) || 0);
  item.updatedAt = nowIso();
  return { ok: true, item };
}

export function practicing(items) {
  return (Array.isArray(items) ? items : []).filter((x) => x.status === 'practicing');
}

export function active(items) {
  return activeOf(items);
}

/**
 * 学习项是否该进这次 prompt。
 * [FREEDOM-OPTIONS 2026-10-31] ownlife 不再自动把「你正在练的一件事」摆到她面前：
 * 学习项是她的记忆，不是自由时间的默认任务。私聊唤醒仍可见；她主动 practice_list 随时能查。
 */
export function shouldInjectIntoPrompt(key = '', reason = '') {
  return String(key).startsWith('private:') && reason !== 'handoff' && reason !== 'ownlife';
}

/** 唤醒注入：只给正在练的一件 + 下一步；没有就返回空串（不造暗示）。 */
export function render(items, { maxChars = 300, lastByItem = {} } = {}) {
  const p = practicing(items);
  if (!p.length) return '';
  const item = p[0];
  const last = lastByItem?.[item.id];
  const lines = [
    '【你正在练的一件事】',
    `- ${item.title}${item.criterion ? `｜判据：${item.criterion}` : ''}`,
  ];
  if (last) {
    const bits = [String(last.result || '')];
    if (last.oneFlaw) bits.push(`问题：${String(last.oneFlaw).slice(0, 40)}`);
    if (last.oneChange) bits.push(`改了：${String(last.oneChange).slice(0, 40)}`);
    lines.push(`- 上次：${bits.filter(Boolean).join('｜')}`);
  }
  if (item.nextDrill) lines.push(`- 下一步：${item.nextDrill}`);
  if (item.why) lines.push(`- 你想练的原因：${item.why}`);
  lines.push('（想练就 practice_start；练完用 practice_result 收尾；想回看就 practice_list。不想练就把 status 改成 paused；不用完成什么配额。）');
  return [...lines.join('\n')].slice(0, maxChars).join('');
}

export function summarize(items) {
  const list = Array.isArray(items) ? items : [];
  const by = {};
  for (const x of list) by[x.status] = (by[x.status] || 0) + 1;
  return { total: list.length, by, practicing: practicing(list).length };
}
