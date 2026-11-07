// inori-practice.js · 一次练习的记录（before/after + 一处问题 + 一处改动）
//
// 纪律：
//   · 一次练习只练一个动作、一个判据、只改一处。
//   · result 只有 met / not_met / unknown；unknown 不算成功。
//   · 练习记录只写事实，不写“我进步了”这种评价。
//
// 存储：data/state/practice-sessions.jsonl

import fs from 'node:fs';
import crypto from 'node:crypto';
import { appendJsonl, rewriteJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('practice-sessions.jsonl'),
  maxRows: 800,
  maxRecent: 5,
};

const RESULTS = ['met', 'not_met', 'unknown'];
const nowIso = () => new Date().toISOString();
const clip = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');
const oneLine = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' '), n);

function normalize(x) {
  if (!x || typeof x !== 'object') return null;
  if (!x.id || !x.itemId) return null;
  return {
    id: String(x.id),
    itemId: String(x.itemId),
    intention: clip(x.intention, 120),
    criterion: clip(x.criterion, 160),
    before: String(x.before ?? '').slice(0, 300),
    attempt: clip(x.attempt, 200),
    result: RESULTS.includes(x.result) ? x.result : 'unknown',
    oneFlaw: clip(x.oneFlaw, 120),
    oneChange: clip(x.oneChange, 120),
    after: String(x.after ?? '').slice(0, 300),
    evidence: clip(x.evidence, 300),
    at: String(x.at ?? nowIso()),
    finishedAt: String(x.finishedAt ?? ''),
  };
}

export function load(file = DEFAULTS.file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return normalize(JSON.parse(l)); } catch { return null; } })
      .filter(Boolean)
      .slice(-DEFAULTS.maxRows);
  } catch { return []; }
}

export function save(rows, file = DEFAULTS.file) {
  return saveRows(rows, file);
}

function saveRows(rows, file = DEFAULTS.file) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean).slice(-DEFAULTS.maxRows);
  const r = rewriteJsonl(file, list, { source: 'practice' });
  if (!r.ok) throw new Error(r.error || '练习记录写入失败');
  return list;
}

/** 补记一次已有练习（按 id）。 */
export function update(sessionId, patch = {}, file = DEFAULTS.file) {
  const rows = load(file);
  const cur = rows.find((x) => x.id === String(sessionId));
  if (!cur) return { ok: false, reason: 'not-found' };
  const merged = normalize({ ...cur, ...patch, id: cur.id, itemId: cur.itemId });
  const list = rows.map((x) => (x.id === cur.id ? merged : x));
  try { saveRows(list, file); } catch { return { ok: false, reason: 'write-failed' }; }
  return { ok: true, session: merged };
}

export function start({ itemId, intention = '', criterion = '', before = '', at = nowIso() } = {}, file = DEFAULTS.file) {
  const id = 'ps' + crypto.randomBytes(4).toString('hex');
  if (!itemId) return { ok: false, reason: 'item-required' };
  const session = normalize({
    id, itemId, intention, criterion, before,
    attempt: '', result: 'unknown', oneFlaw: '', oneChange: '', after: '', evidence: '',
    at, finishedAt: '',
  });
  const r = appendJsonl(file, session, { source: 'practice' });
  if (!r.ok) return { ok: false, reason: 'write-failed' };
  return { ok: true, session };
}

/** 收尾/补记一次练习。not_met 时必须写 oneFlaw + oneChange（一次只改一处）。 */
export function finish(session, { result = 'unknown', attempt = '', oneFlaw = '', oneChange = '', after = '', evidence = '' } = {}) {
  if (!session || !session.id) return { ok: false, reason: 'session-required' };
  const res = RESULTS.includes(result) ? result : 'unknown';
  if (res === 'not_met' && (!String(oneFlaw).trim() || !String(oneChange).trim())) {
    return { ok: false, reason: 'flaw-and-change-required' };
  }
  return {
    ok: true,
    session: normalize({
      ...session,
      attempt: attempt || session.attempt,
      result: res,
      oneFlaw: oneFlaw || session.oneFlaw,
      oneChange: oneChange || session.oneChange,
      after: after || session.after,
      evidence: evidence || session.evidence,
      finishedAt: nowIso(),
    }),
  };
}

export function append(session, file = DEFAULTS.file) {
  const s = normalize(session);
  if (!s) return { ok: false, reason: 'bad-session' };
  const r = appendJsonl(file, s, { source: 'practice' });
  return r.ok ? { ok: true, session: s } : { ok: false, reason: 'write-failed' };
}

export function recent(itemId, file = DEFAULTS.file, limit = DEFAULTS.maxRecent) {
  return load(file).filter((x) => x.itemId === String(itemId)).slice(-Math.max(1, Number(limit) || 5));
}

export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const by = { met: 0, not_met: 0, unknown: 0 };
  for (const x of list) by[x.result] = (by[x.result] || 0) + 1;
  const items = new Set(list.map((x) => x.itemId));
  return { total: list.length, by, items: items.size };
}
