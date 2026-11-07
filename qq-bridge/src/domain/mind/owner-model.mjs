// owner-model.mjs · 宪章 §5.19/G?：owner 偏好演化（版本化、可修订、可回退）
//
// 干什么：用 append-only 事件记录“他喜欢/讨厌/不吃什么”；折叠出**当前**模型与历史；
//   owner 亲口说的永远压过推断，推断不能悄悄覆盖手写偏好；旧证据可 revoke 回退。
// 为什么：T6 的缺口是“owner 偏好变了，她的模型冻结”；只存一个布尔/字符串会卡在第一次。
// 输入输出：纯折叠 + append-only 存储；{topics, anomalies} 出。
// 失败模式：坏事件进 anomalies；无 owner 事件时推断可作当前，但标记 source=inferred。
// 不做什么：不做语义理解（extractPreference 只是保守正则）；不替她决定要不要提。

import path from 'node:path';
import { appendJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
// [PROMPT-SAFETY] 偏好值来自 owner 原话，进 prompt 前也要中性化。
import { sanitizePromptSnippet } from '../shared/prompt-safety.mjs';

export const OWNER_MODEL_VERSION = 1;
export const OWNER_MODEL_FILE = 'owner-model.jsonl';
export const OWNER_SOURCES = Object.freeze(['owner', 'inferred', 'reflection']);

const LIMIT = 8;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** 保守提取：只认第一人称的明确偏好；不做推测。 */
export function extractPreference(text) {
  const t = clean(text);
  if (!t) return null;
  const patterns = [
    [/(?:我|俺)\s*(?:最)?喜欢\s*([^，。；！？,.!?]{1,40})/, '喜欢'],
    [/(?:我|俺)\s*(?:最)?爱\s*([^，。；！？,.!?]{1,40})/, '喜欢'],
    [/(?:我|俺)\s*讨厌\s*([^，。；！？,.!?]{1,40})/, '讨厌'],
    [/(?:我|俺)\s*不吃\s*([^，。；！？,.!?]{1,40})/, '不吃'],
    [/(?:我|俺)\s*对\s*([^，。；！？,.!?]{1,20})\s*过敏/, '过敏'],
  ];
  for (const [re, kind] of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const value = clean(m[1]).replace(/[的地得]?$/,'');
    if (!value) continue;
    return { topic: kind, value: value.slice(0, 40) };
  }
  return null;
}

export function buildPreference({ topic, value, source = 'owner', evidenceId, confidence = 0.9, at = Date.now() } = {}) {
  const t = clean(topic);
  const v = clean(value);
  if (!t || !v) throw new Error('owner-model: topic/value 不能为空');
  if (!OWNER_SOURCES.includes(String(source))) throw new Error('owner-model: source 非法');
  const ev = clean(evidenceId);
  if (!ev) throw new Error('owner-model: evidenceId 不能为空（无证据不改偏好）');
  return {
    v: OWNER_MODEL_VERSION, kind: 'preference', topic: t.slice(0, 40), value: v.slice(0, 60),
    source: String(source), evidenceId: ev.slice(0, 120),
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)), at: Number(at),
  };
}

export function buildRevoke({ evidenceId, reason = '', at = Date.now() } = {}) {
  const ev = clean(evidenceId);
  if (!ev) throw new Error('owner-model: revoke 需要 evidenceId');
  return { v: OWNER_MODEL_VERSION, kind: 'revoke', evidenceId: ev.slice(0, 120), reason: clean(reason).slice(0, 80), at: Number(at) };
}

/** 折叠：owner 优先于 inferred；同源取最新；revoke 后回退。 */
export function foldOwnerModel(events, { now = Date.now() } = {}) {
  const rows = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
  const revoked = new Set(rows.filter((e) => e.kind === 'revoke' && e.evidenceId).map((e) => String(e.evidenceId)));
  const byTopic = new Map();
  const anomalies = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.kind === 'revoke') continue;
    if (row.kind !== 'preference') { anomalies.push({ id: row.evidenceId, reason: 'unknown-kind' }); continue; }
    if (!OWNER_SOURCES.includes(String(row.source))) { anomalies.push({ id: row.evidenceId, reason: 'bad-source' }); continue; }
    if (!clean(row.topic) || !clean(row.value) || !clean(row.evidenceId)) { anomalies.push({ id: row.evidenceId, reason: 'bad-preference' }); continue; }
    if (revoked.has(String(row.evidenceId))) continue;
    const topic = clean(row.topic);
    // [AUDIT-FIX] 幂等按 topic 分：同一句话可能同时给出“喜欢/讨厌”两个 topic，不能被全局 seen 吞掉。
    // JSON 数组键：topic/evidenceId 里带分隔符也不会串。
    const seenKey = JSON.stringify([topic, String(row.evidenceId)]);
    if (seen.has(seenKey)) { anomalies.push({ id: row.evidenceId, reason: 'duplicate-evidence' }); continue; }
    seen.add(seenKey);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(row);
  }
  const topics = [];
  for (const [topic, list] of byTopic) {
    const ownerRows = list.filter((r) => String(r.source) === 'owner');
    const pool = ownerRows.length ? ownerRows : list;
    const current = pool.slice().sort((a, b) => Number(b.at) - Number(a.at))[0];
    const history = list.slice().sort((a, b) => Number(b.at) - Number(a.at)).slice(0, LIMIT)
      .map((r) => ({ value: r.value, source: r.source, at: Number(r.at), evidenceId: r.evidenceId, current: r === current }));
    topics.push({ topic, value: current.value, source: String(current.source), confidence: Number(current.confidence) || 0, at: Number(current.at) || 0, evidenceId: current.evidenceId, history });
  }
  topics.sort((a, b) => b.at - a.at);
  return { v: OWNER_MODEL_VERSION, at: Number(now), topics, anomalies };
}

export function diffOwnerModel(before, after) {
  const oldMap = new Map((before?.topics || []).map((t) => [t.topic, t.value]));
  const changes = [];
  for (const t of after?.topics || []) {
    const prev = oldMap.get(t.topic);
    if (prev !== t.value) changes.push({ topic: t.topic, from: prev ?? null, to: t.value, source: t.source, at: t.at });
  }
  return changes;
}

export function renderOwnerModelLine(model) {
  const topics = (model?.topics || []).filter((t) => t && t.value);
  if (!topics.length) return '';
  const parts = topics.slice(0, 5)
    .map((t) => {
      const topic = sanitizePromptSnippet(t.topic, { maxChars: 20 });
      const value = sanitizePromptSnippet(t.value, { maxChars: 40 });
      return topic && value ? `${topic}：${value}` : '';
    })
    .filter(Boolean);
  if (!parts.length) return '';
  return `【他现在（有据可查）】${parts.join('；')}。如果和最近说的不一样，以他最近说的为准。`;
}

export function parseOwnerModelLedger(text) {
  const rows = []; const corrupt = [];
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && typeof row.kind === 'string') rows.push(row); else corrupt.push({ line: index + 1, reason: 'missing-kind' }); } catch { corrupt.push({ line: index + 1, reason: 'bad-json' }); }
  }
  return { rows, corrupt };
}

export function createOwnerModelStore({ file, now = () => Date.now(), append = appendJsonl, readFile } = {}) {
  if (!file) throw new Error('owner-model: file 不能为空');
  const target = path.resolve(String(file));
  const nowFn = typeof now === 'function' ? now : () => now;
  const appendFn = typeof append === 'function' ? append : appendJsonl;
  const fsRead = typeof readFile === 'function' ? readFile : (f) => import('node:fs').then(({ default: fs }) => {
    try { return fs.readFileSync(f, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
  });
  const allowed = new Set(['owner', 'inferred', 'reflection']);
  async function appendEvent(event, { writer = 'owner' } = {}) {
    if (!allowed.has(writer)) throw new Error('owner-model: writer 不在白名单');
    const result = appendFn(target, event, { source: 'owner-model', fsync: true });
    if (!result || result.ok !== true) throw new Error(`owner-model: 写入失败 ${result?.error || 'unknown'}`);
    return event;
  }
  async function readAll() { return parseOwnerModelLedger(await fsRead(target)); }
  async function state() { const { rows, corrupt } = await readAll(); return { ...foldOwnerModel(rows, { now: nowFn() }), corrupt }; }
  async function preference(input) { return appendEvent(buildPreference({ ...input, at: input?.at ?? nowFn() }), { writer: input?.source === 'inferred' ? 'inferred' : 'owner' }); }
  async function revoke(input) { return appendEvent(buildRevoke({ ...input, at: input?.at ?? nowFn() }), { writer: 'owner' }); }
  return { v: OWNER_MODEL_VERSION, file: target, appendEvent, readAll, state, preference, revoke };
}
