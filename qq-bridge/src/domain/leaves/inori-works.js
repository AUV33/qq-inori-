// inori-works.js · 她的分身工作台：一件活 = 一个工作记录，挂在任务池的执行后端上
//
// 设计纪律（用户 2026-10-26 拍板）：主体性唯一——她是意识的主体，分身只是她伸出去的手。
// 所以这里只有"她的活"：进度回她、结果回她、不回 QQ；分身会话用同一份角色卡，不产生第二人格。
//
// 状态机：queued → running → done / failed / cancelled（终态不可再变；cancel 只能从未终态发起）
// 存储：data/state/works.json —— { works: [...] }，原子写（tmp+rename），只保留最近 maxKeep 条。

import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../shared/project-paths.js';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

export const WORK_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const DEFAULTS = {
  file: stateDataPath('works.json'),
  maxKeep: 60,
  maxProgress: 20,
};

const TERMINAL = new Set([WORK_STATUS.DONE, WORK_STATUS.FAILED, WORK_STATUS.CANCELLED]);

export function isTerminal(work) {
  return TERMINAL.has(String(work?.status ?? ''));
}

let seq = 0;
function newId() {
  seq += 1;
  return 'w' + Date.now().toString(36) + seq;
}

function oneLine(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 新建一件活（不落盘；落盘由调用方决定）。 */
export function newWork({ title = '', goal = '', acceptance = '', reportTo = '', at = Date.now(), taskId = '', intentionId = '' } = {}) {
  return {
    id: newId(),
    title: oneLine(title, 80),
    goal: oneLine(goal, 600),
    acceptance: oneLine(acceptance, 300),
    intentionId: String(intentionId || ''),
    status: WORK_STATUS.QUEUED,
    progress: [],
    reportTo: String(reportTo || ''),
    taskId: String(taskId || ''),
    sessionId: '',
    createdAt: at,
    updatedAt: at,
  };
}

export function findWork(works, id) {
  const target = String(id || '');
  if (!target) return null;
  return (Array.isArray(works) ? works : []).find((w) => w && w.id === target) || null;
}

export function activeWorks(works) {
  return (Array.isArray(works) ? works : []).filter((w) => w && !isTerminal(w));
}

export function runningWorks(works) {
  return activeWorks(works).filter((w) => w.status === WORK_STATUS.RUNNING);
}

export function queuedWorks(works) {
  return activeWorks(works).filter((w) => w.status === WORK_STATUS.QUEUED);
}

/** 追加一条进度（终态不再追加；最多 maxProgress 条，先进先出）。 */
export function addProgress(work, note, at = Date.now()) {
  if (!work || isTerminal(work)) return work;
  const text = oneLine(note, 300);
  if (!text) return work;
  const progress = Array.isArray(work.progress) ? work.progress.slice() : [];
  progress.push({ at, note: text });
  if (progress.length > DEFAULTS.maxProgress) progress.splice(0, progress.length - DEFAULTS.maxProgress);
  return { ...work, progress, updatedAt: at };
}

/** 改状态（终态不可变；非法状态原样返回）。 */
export function setWorkStatus(work, status, at = Date.now(), note = '') {
  if (!work) return work;
  const s = String(status || '');
  if (!Object.values(WORK_STATUS).includes(s)) return work;
  if (isTerminal(work)) return work;
  let next = { ...work, status: s, updatedAt: at };
  if (note) next = addProgress(next, note, at);
  return next;
}

/** 从工作员的回合文本里抽一句进度摘要（确定性，不做语义）。 */
export function summarizeWorkerText(text, max = 120) {
  return oneLine(text, max);
}

/**
 * 唤醒注入块：她手上的活（进行中 + 排队）。
 * 空池返回 ''（不造暗示，纪律同其他注入层）。
 */
export function renderWorksLine(works, now = Date.now()) {
  const active = activeWorks(works);
  if (!active.length) return '';
  const queued = active.filter((w) => w.status === WORK_STATUS.QUEUED);
  const lines = [`【你手上的活】${active.length} 件进行中：`];
  for (const w of active.slice(0, 5)) {
    const last = Array.isArray(w.progress) && w.progress.length ? w.progress[w.progress.length - 1].note : '';
    const ageMin = Math.max(0, Math.round((now - Number(w.updatedAt || now)) / 60000));
    const age = ageMin > 0 ? `（${ageMin} 分钟前更新）` : '';
    lines.push(`- ${w.title || w.goal || w.id}${last ? `｜${last}` : ''}${age}`);
  }
  if (active.length > 5) lines.push(`…另有 ${active.length - 5} 件`);
  if (queued.length) lines.push(`排队 ${queued.length} 件，池空了自己会接着跑，不用你盯。`);
  return lines.join('\n');
}

export function loadWorks(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j?.works) ? j.works : []);
    return list.filter((w) => w && typeof w.id === 'string' && w.id);
  } catch { return []; }
}

export function saveWorks(file = DEFAULTS.file, works = []) {
  try {
    const keep = (Array.isArray(works) ? works : []).slice(-DEFAULTS.maxKeep);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ works: keep }, null, 1), 'utf8');
    renameWithRetry(tmp, file);
    return true;
  } catch { return false; }
}


/** 记忆重要度：显式字段优先，其次按 kind 给默认（fact/group-fact=4 / event=3 / group-digest=2 / day-digest=1）。 */
export function importanceOf(entry) {
  const n = Number(entry?.importance);
  if (Number.isFinite(n) && n >= 1) return Math.min(5, Math.max(1, n));
  const k = String(entry?.kind ?? '');
  if (k === 'fact' || k === 'group-fact') return 4;
  if (k === 'event') return 3;
  if (k === 'group-digest') return 2;
  if (k === 'day-digest') return 1;
  return 3;
}

/**
 * 条件注入（世界书式）：角色卡里 [[?关键词1|关键词2]] ... [[/?]] 的块，
 * 只有上下文命中关键词才保留；没有标记块时原样返回（老卡片兼容）。
 *
 * [NEST] 支持**嵌套（套娃）**：父块不命中时整棵子树都不注入；父块命中时，
 * 子块再按各自关键词判断。旧实现用非贪婪正则配对，内层的 [[/?]] 会被当成外层结束符，
 * 嵌套一定错位——所以这里改成栈式解析。
 */
export function conditionedRoleText(text, contextText) {
  const raw = String(text ?? '');
  if (!raw.includes('[[?')) return raw;
  const ctx = String(contextText ?? '');
  const hit = (spec) => {
    const kws = String(spec || '').split(/[|,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    return kws.length === 0 || kws.some((k) => ctx.includes(k));
  };
  const root = { active: true, buf: [] };
  const stack = [root];
  const re = /\[\[\?([^\]]*)\]\]|\[\[\/\?\]\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    const top = stack[stack.length - 1];
    top.buf.push(raw.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      stack.push({ active: top.active && hit(m[1]), buf: [] });
    } else if (stack.length > 1) {
      const frame = stack.pop();
      if (frame.active) stack[stack.length - 1].buf.push(...frame.buf);
    } else {
      // 多余的 [[/?]]：当普通文本保留，不吞内容、不抛错
      root.buf.push(m[0]);
    }
  }
  // 尾巴归最内层未闭合的块：否则未闭合块一旦不命中，尾巴仍会漏到根上
  const tail = raw.slice(last);
  if (stack.length > 1) stack[stack.length - 1].buf.push(tail);
  else root.buf.push(tail);
  // 未闭合的块：按"能显示就显示"收尾，宁可多给也不整段丢
  while (stack.length > 1) {
    const frame = stack.pop();
    if (frame.active) stack[stack.length - 1].buf.push(...frame.buf);
  }
  return root.buf.join('');
}
