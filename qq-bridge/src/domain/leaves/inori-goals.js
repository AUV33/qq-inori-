// inori-goals.js · 她手上的事（目标栈）
//
// 为什么需要它：没有目标栈，她就只有「反应」（被叫醒→回话），这是 chatbot 不是 agent。
// 有目标栈之后，她能：记下想做的事 → 下次独处时推进一件 → 做完划掉。
//
// [GOAL-TRUTH 2026-10-31] done 不再等于“关掉”：
//   - status: active / parked / done / dropped
//   - done 必须有 evidence；没有证据的 done 自动降为 parked（没放弃，只是先搁着）
//   - active 上限 5；满了允许 park，不允许用 done 腾位置
//   - nextAction / lastError 保留“上次做到哪、下一步”
//
// 落盘：data/state/goals.json

import fs from 'node:fs';
import crypto from 'node:crypto';
import { humanizeGap } from '../conversation/time-words.js';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('goals.json'),
  maxActive: 5,
  maxTextChars: 80,
};

const STATUSES = ['active', 'parked', 'done', 'dropped', 'promoted'];
const nowIso = () => new Date().toISOString();
const clampText = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');

export function load(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const goals = Array.isArray(j?.goals) ? j.goals : [];
    return goals
      .filter((g) => g && typeof g.text === 'string')
      .map((g) => ({
        id: String(g.id ?? ''),
        text: String(g.text),
        status: STATUSES.includes(g.status) ? g.status : 'active',
        createdAt: g.createdAt ?? nowIso(),
        touchedAt: g.touchedAt ?? g.createdAt ?? nowIso(),
        progress: Array.isArray(g.progress) ? g.progress.slice(-20) : [],
        evidence: String(g.evidence ?? ''),
        nextAction: String(g.nextAction ?? ''),
        lastError: String(g.lastError ?? ''),
        intentionId: String(g.intentionId ?? ''),
        attempts: Math.max(0, Number(g.attempts) || 0),
      }));
  } catch {
    return [];
  }
}

export function save(goals, file = DEFAULTS.file) {
  const result = writeJsonDocument(file, { goals }, { source: 'goals' });
  if (!result.ok) throw new Error(result.error || '目标写入失败');
  return goals;
}

const activeOf = (goals) => goals.filter((g) => g.status === 'active');

/** 新增一件事；超过上限或重复时拒绝（返回原因，不抛） */
export function add(goals, text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const body = clampText(text, o.maxTextChars);
  if (!body) return { ok: false, reason: 'empty' };
  const act = activeOf(goals);
  if (act.length >= o.maxActive) return { ok: false, reason: `active-limit(${o.maxActive})` };
  if (act.some((g) => g.text === body) || goals.some((g) => ['parked', 'promoted'].includes(g.status) && g.text === body)) {
    return { ok: false, reason: 'duplicate' };
  }
  const g = {
    id: 'g' + crypto.randomBytes(4).toString('hex'),
    text: body,
    status: 'active',
    createdAt: nowIso(),
    touchedAt: nowIso(),
    progress: [],
    evidence: '',
    nextAction: '',
    lastError: '',
    intentionId: '',
    attempts: 0,
  };
  goals.push(g);
  return { ok: true, goal: g, goals };
}

/** 改状态或记一笔进度。done 必须有 evidence；没有就降为 parked。 */
export function update(goals, id, patch = {}) {
  const g = goals.find((x) => x.id === id);
  if (!g) return { ok: false, reason: 'not-found' };
  if (patch.status && STATUSES.includes(patch.status)) {
    if (patch.status === 'done') {
      const evidence = clampText(patch.evidence ?? g.evidence ?? '', 300);
      if (!evidence) {
        g.status = 'parked';
        g.touchedAt = nowIso();
        return { ok: true, goal: g, goals, downgraded: true, reason: 'evidence-required' };
      }
      g.evidence = evidence;
      g.status = 'done';
    } else {
      g.status = patch.status;
    }
  }
  if (patch.evidence !== undefined) g.evidence = clampText(patch.evidence, 300);
  if (patch.nextAction !== undefined) g.nextAction = clampText(patch.nextAction, 200);
  if (patch.lastError !== undefined) g.lastError = clampText(patch.lastError, 200);
  if (patch.intentionId !== undefined) g.intentionId = String(patch.intentionId || '').slice(0, 80);
  if (patch.note) {
    g.progress.push({ at: nowIso(), note: clampText(patch.note, 200) });
    if (g.progress.length > 20) g.progress = g.progress.slice(-20);
    g.attempts = Math.max(0, Number(g.attempts) || 0) + 1;
  }
  g.touchedAt = nowIso();
  return { ok: true, goal: g, goals };
}

/** 挑一件最久没动过的事（推进它）；没有则 null。parked 不自动挑。 */
export function next(goals) {
  const act = activeOf(goals);
  if (!act.length) return null;
  return act.slice().sort((a, b) => String(a.touchedAt).localeCompare(String(b.touchedAt)))[0];
}

/** 超过 N 天没动的自动放弃（防止目标腐烂）；parked 不自动丢。 */
export function expire(goals, days = 14) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let changed = 0;
  for (const g of goals) {
    if (g.status === 'active' && Date.parse(g.touchedAt) < cutoff) { g.status = 'dropped'; changed += 1; }
  }
  return changed;
}

/**
 * [FREEDOM-OPTIONS] 目标池为空时的“开放邀请”。
 * 不创建目标、不指定方向；只把 goal_add 这个入口摆出来，她不想定就空着。
 */
export function renderOpenInvitation(goals) {
  const act = activeOf(goals);
  const parked = goals.filter((g) => g.status === 'parked');
  if (act.length || parked.length) return '';
  return '【手头没有目标】现在没有你自己定下的事。想给自己记一件就用 goal_add；不想记就空着，发呆也算自己的时间。';
}

/** 给模型看的一小段；没有进行中/搁着的事返回空串。 */
export function render(goals, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const act = activeOf(goals);
  const parked = goals.filter((g) => g.status === 'parked');
  if (!act.length && !parked.length) return '';
  const lines = act
    .sort((a, b) => String(a.touchedAt).localeCompare(String(b.touchedAt)))
    .slice(0, o.maxActive)
    .map((g) => {
      const lastEntry = g.progress.length ? g.progress[g.progress.length - 1] : null;
      const last = lastEntry?.note || g.lastError || '';
      // [TIME-WORDS] 上次进展是多久以前：旧版只有"上次：写了什么"，两个月前的事和昨天的事长得一样。
      const at = Date.parse(String(lastEntry?.at || ''));
      const age = Number.isFinite(at) ? humanizeGap(Date.now() - at) : '';
      // [GOAL-AGE] 没有进展记录的也要给「多久没动过」：旧任务突然冒出来时，
      // 她至少知道这是上次留下的，不是现在的命令。
      const touchedAt = Date.parse(String(g.touchedAt || g.createdAt || ''));
      const idle = !last && Number.isFinite(touchedAt) ? humanizeGap(Date.now() - touchedAt) : '';
      const next = g.nextAction ? `；下一步：${g.nextAction}` : '';
      return `- ${g.text}${last ? `（上次：${last}${age ? ` · ${age}` : ''}${next}）` : (idle ? `（${idle}没动过${next}）` : '')}`;
    });
  const parkedLines = parked.slice(0, 3).map((g) => `- ${g.text}（先搁着；想继续就接着做，不想就继续放着）`);
  return `你手上有几件之前留下的、还没做完的事（不是现在的命令；不想做了就 goal_done(status:"dropped") 放下，别让它一直挂着）：\n${lines.join('\n')}`
    + (parkedLines.length ? `\n搁着的事：\n${parkedLines.join('\n')}` : '');
}
