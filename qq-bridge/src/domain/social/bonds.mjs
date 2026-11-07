// bonds.mjs · 宪章 §5.9 / G5：关系账本（每人一份 trust/affinity/familiarity + 禁忌）
//
// 干什么：append-only 关系事件 → 折叠成"她与每个人此刻的关系"；每条证据幂等、可撤销。
// 为什么：belief-store 有 per-person 数值，但没有禁忌、没有"误读可回退"的证据链；
//   §5.17 要求感知回灌可逆、不凭一次误读定性。bonds 把"为什么变"写成证据，而不是只留结果。
// 隐私：只以 personId 为键；不写 QQ 号/昵称/手机号（身份解析由 identity-map 负责）。
// 输入输出：纯构造/折叠 + append-only 存储；foldBonds(events) → people/anomalies。
// 失败模式：坏事件进 anomalies；同一 evidenceId 只生效一次；revoke 后重算。
// 不做什么：不替她裁决关系、不做语义推断；只记账与折叠。

import path from 'node:path';
import { appendJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

export const BONDS_VERSION = 1;
export const BOND_DIMENSIONS = Object.freeze(['trust', 'affinity', 'familiarity']);
export const BOND_BASELINE = 0.5;
export const BONDS_FILE = 'bonds.jsonl';
const ID_RE = /^p_[0-9a-f]{12}$/;

export class BondsError extends Error {
  constructor(message, code = 'bonds') {
    super(message);
    this.name = 'BondsError';
    this.code = code;
  }
}

const clamp01 = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : BOND_BASELINE);
const round3 = (n) => Math.round(clamp01(n) * 1000) / 1000;

export function buildObservation({ personId, dimension, delta, evidenceId, note = '', at = Date.now() } = {}) {
  if (!ID_RE.test(String(personId ?? ''))) throw new BondsError('personId 非法');
  if (!BOND_DIMENSIONS.includes(String(dimension))) throw new BondsError('dimension 只能是 trust/affinity/familiarity');
  const d = Number(delta);
  if (!Number.isFinite(d) || d < -0.5 || d > 0.5) throw new BondsError('delta 必须在 -0.5..0.5');
  const ev = String(evidenceId ?? '').trim();
  if (!ev) throw new BondsError('evidenceId 不能为空（无证据不改关系）');
  // delta 是有符号量，不能走 clamp01 的 round3（那会把 -0.4 变成 0）。
  const signed = Math.round(d * 1000) / 1000;
  return { v: BONDS_VERSION, kind: 'observe', personId: String(personId), dimension: String(dimension), delta: signed, evidenceId: ev.slice(0, 120), note: String(note ?? '').slice(0, 120), at: Number(at) };
}

export function buildTaboo({ personId, topic, evidenceId, at = Date.now() } = {}) {
  if (!ID_RE.test(String(personId ?? ''))) throw new BondsError('personId 非法');
  const t = String(topic ?? '').trim();
  if (!t) throw new BondsError('topic 不能为空');
  const ev = String(evidenceId ?? '').trim();
  if (!ev) throw new BondsError('taboo 必须带 evidenceId');
  return { v: BONDS_VERSION, kind: 'taboo', personId: String(personId), topic: t.slice(0, 60), evidenceId: ev.slice(0, 120), at: Number(at) };
}

export function buildRevoke({ evidenceId, reason = '', at = Date.now() } = {}) {
  const ev = String(evidenceId ?? '').trim();
  if (!ev) throw new BondsError('revoke 需要 evidenceId');
  // [AUDIT-FIX] 必须与 observe/taboo 一样截断到 120；否则长证据撤销永远匹配不上。
  return { v: BONDS_VERSION, kind: 'revoke', evidenceId: ev.slice(0, 120), reason: String(reason ?? '').slice(0, 80), at: Number(at) };
}

/** 折叠：先收集 revoke，再按 evidenceId 幂等应用；结果按 personId 聚合。 */
export function foldBonds(events, { now = Date.now() } = {}) {
  const rows = Array.isArray(events) ? events : [];
  const revoked = new Set();
  for (const row of rows) {
    // 历史事件可能带超长 evidenceId；按落盘口径截断，撤销才能匹配。
    if (row && row.kind === 'revoke' && row.evidenceId) revoked.add(String(row.evidenceId).slice(0, 120));
  }
  const people = new Map();
  const applied = new Set();
  const anomalies = [];

  const ensure = (personId, at) => {
    if (!people.has(personId)) {
      people.set(personId, {
        personId,
        trust: BOND_BASELINE, affinity: BOND_BASELINE, familiarity: BOND_BASELINE,
        taboo: [], evidenceIds: [], createdAt: Number(at) || Number(now), updatedAt: Number(at) || Number(now),
      });
    }
    return people.get(personId);
  };

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind === 'revoke') continue;
    if (!ID_RE.test(String(row.personId ?? ''))) { anomalies.push({ id: row.personId, reason: 'bad-person' }); continue; }
    if (row.kind === 'observe') {
      if (!BOND_DIMENSIONS.includes(String(row.dimension))) { anomalies.push({ id: row.personId, reason: 'bad-dimension' }); continue; }
      const ev = String(row.evidenceId ?? '').slice(0, 120);
      if (!ev) { anomalies.push({ id: row.personId, reason: 'missing-evidence' }); continue; }
      if (revoked.has(ev)) continue;
      // [AUDIT-FIX] 幂等键按人+维度：同一条证据可以同时影响信任与亲疏；同一维度重复才忽略。
      // 用 JSON 数组做键，避免 evidenceId 里带分隔符造成跨维度碰撞。
      const appKey = JSON.stringify([row.personId, row.dimension, ev]);
      if (applied.has(appKey)) { anomalies.push({ id: row.personId, reason: 'duplicate-evidence' }); continue; }
      const delta = Number(row.delta);
      // 先校验再占位：坏 delta 不能把合法证据的 evidenceId 烧掉。
      if (!Number.isFinite(delta)) { anomalies.push({ id: row.personId, reason: 'bad-delta' }); continue; }
      applied.add(appKey);
      const person = ensure(row.personId, row.at);
      person[row.dimension] = round3(clamp01(person[row.dimension] + delta));
      person.evidenceIds = [...person.evidenceIds, ev].slice(-50);
      person.updatedAt = Number(row.at) || person.updatedAt;
      continue;
    }
    if (row.kind === 'taboo') {
      const ev = String(row.evidenceId ?? '').slice(0, 120);
      if (revoked.has(ev)) continue;
      const topic = String(row.topic ?? '').trim();
      if (!topic) { anomalies.push({ id: row.personId, reason: 'bad-taboo' }); continue; }
      const person = ensure(row.personId, row.at);
      if (!person.taboo.some((t) => t.topic === topic)) {
        person.taboo = [...person.taboo, { topic, evidenceId: ev, at: Number(row.at) || Number(now) }].slice(-20);
        person.updatedAt = Number(row.at) || person.updatedAt;
      }
      continue;
    }
    anomalies.push({ id: row.personId, reason: `unknown-kind:${row.kind}` });
  }
  return { v: BONDS_VERSION, people: [...people.values()], anomalies };
}

export function bondFor(folded, personId) {
  return (folded?.people || []).find((p) => p.personId === String(personId)) || null;
}

export function parseBondsLedger(text) {
  const rows = [];
  const corrupt = [];
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.kind === 'string') rows.push(row);
      else corrupt.push({ line: index + 1, reason: 'missing-kind' });
    } catch { corrupt.push({ line: index + 1, reason: 'bad-json' }); }
  }
  return { rows, corrupt };
}

export function bondsSummary(folded) {
  const people = folded?.people || [];
  return {
    people: people.length,
    taboos: people.reduce((n, p) => n + (p.taboo?.length || 0), 0),
    evidence: people.reduce((n, p) => n + (p.evidenceIds?.length || 0), 0),
    anomalies: folded?.anomalies?.length || 0,
  };
}

export function createBondsStore({ file, now = () => Date.now(), append = appendJsonl, readFile } = {}) {
  if (!file) throw new BondsError('bonds file 不能为空');
  const target = path.resolve(String(file));
  const nowFn = typeof now === 'function' ? now : () => now;
  const appendFn = typeof append === 'function' ? append : appendJsonl;
  const fsRead = typeof readFile === 'function' ? readFile : (f) => import('node:fs').then(({ default: fs }) => {
    try { return fs.readFileSync(f, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
  });
  const allowed = new Set(['bridge', 'reflection', 'owner']);

  async function appendEvent(event, { writer = 'bridge' } = {}) {
    if (!allowed.has(writer)) throw new BondsError('writer 不在白名单', 'writer-forbidden');
    const result = appendFn(target, event, { source: 'bonds', fsync: true });
    if (!result || result.ok !== true) throw new BondsError(`关系账写入失败：${result?.error || 'unknown'}`, 'write-failed');
    return event;
  }
  async function readAll() { return parseBondsLedger(await fsRead(target)); }
  async function state() {
    const { rows, corrupt } = await readAll();
    return { ...foldBonds(rows, { now: nowFn() }), corrupt };
  }
  async function observe(input) { return appendEvent(buildObservation({ ...input, at: input?.at ?? nowFn() }), { writer: 'bridge' }); }
  async function taboo(input) { return appendEvent(buildTaboo({ ...input, at: input?.at ?? nowFn() }), { writer: 'reflection' }); }
  async function revoke(input) { return appendEvent(buildRevoke({ ...input, at: input?.at ?? nowFn() }), { writer: 'bridge' }); }
  return { v: BONDS_VERSION, file: target, appendEvent, readAll, state, observe, taboo, revoke };
}
