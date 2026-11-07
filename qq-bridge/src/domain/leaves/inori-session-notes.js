// inori-session-notes.js · 按会话的短期笔记（实时层）
//
// 目的：不等夜间反思，先把“他刚纠正了什么 / 上一件没做完的是什么 / 下一步”留给下一次唤醒。
// 纪律：只记事实与原话；不写角色卡、不写经验、不自动改行为。
//
// 存储：data/state/session-notes.json
//   { "private:123": { corrections:[], openLoops:[], facts:[], updatedAt } }

import fs from 'node:fs';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('session-notes.json'),
  maxPerKind: 20,
  correctionTtlMs: 24 * 3600 * 1000,
  openLoopTtlMs: 7 * 24 * 3600 * 1000,
  maxChars: 300,
};

const nowIso = () => new Date().toISOString();
const clip = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function load(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [key, v] of Object.entries(j?.notes ?? {})) {
      if (!v || typeof v !== 'object') continue;
      out[key] = {
        corrections: Array.isArray(v.corrections) ? v.corrections.filter(Boolean).slice(-DEFAULTS.maxPerKind) : [],
        openLoops: Array.isArray(v.openLoops) ? v.openLoops.filter(Boolean).slice(-DEFAULTS.maxPerKind) : [],
        facts: Array.isArray(v.facts) ? v.facts.filter(Boolean).slice(-DEFAULTS.maxPerKind) : [],
        updatedAt: String(v.updatedAt ?? ''),
      };
    }
    return out;
  } catch { return {}; }
}

export function save(notes, file = DEFAULTS.file) {
  const obj = {};
  for (const [key, v] of Object.entries(notes ?? {})) {
    if (!v || typeof v !== 'object') continue;
    obj[key] = {
      corrections: Array.isArray(v.corrections) ? v.corrections.filter(Boolean).slice(-DEFAULTS.maxPerKind) : [],
      openLoops: Array.isArray(v.openLoops) ? v.openLoops.filter(Boolean).slice(-DEFAULTS.maxPerKind) : [],
      facts: Array.isArray(v.facts) ? v.facts.filter(Boolean).slice(-DEFAULTS.maxPerKind) : [],
      updatedAt: String(v.updatedAt ?? nowIso()),
    };
  }
  const r = writeJsonDocument(file, { version: 1, notes: obj }, { source: 'session-notes' });
  if (!r.ok) throw new Error(r.error || '会话笔记写入失败');
  return obj;
}

function ensure(notes, key) {
  const k = String(key || '');
  if (!notes[k]) notes[k] = { corrections: [], openLoops: [], facts: [], updatedAt: nowIso() };
  return notes[k];
}

export function addCorrection(notes, key, text, { at = nowIso(), source = 'owner' } = {}) {
  const body = clip(norm(text), 160);
  if (!body) return { ok: false, reason: 'empty' };
  const n = ensure(notes, key);
  const sig = body.slice(0, 40);
  if (n.corrections.some((x) => String(x.text || '').slice(0, 40) === sig)) return { ok: true, duplicate: true };
  n.corrections.push({ at, text: body, source });
  n.corrections = n.corrections.slice(-DEFAULTS.maxPerKind);
  n.updatedAt = at;
  return { ok: true, entry: n.corrections[n.corrections.length - 1] };
}

export function addOpenLoop(notes, key, text, next = '', { at = nowIso(), source = 'tool' } = {}) {
  const body = clip(norm(text), 160);
  if (!body) return { ok: false, reason: 'empty' };
  const n = ensure(notes, key);
  const sig = body.slice(0, 40);
  const existing = n.openLoops.find((x) => String(x.text || '').slice(0, 40) === sig);
  if (existing) {
    if (next) existing.next = clip(norm(next), 160);
    existing.at = at;
    n.updatedAt = at;
    return { ok: true, entry: existing, updated: true };
  }
  n.openLoops.push({ at, text: body, next: clip(norm(next), 160), source });
  n.openLoops = n.openLoops.slice(-DEFAULTS.maxPerKind);
  n.updatedAt = at;
  return { ok: true, entry: n.openLoops[n.openLoops.length - 1] };
}

/** 成功后清掉对应的工具报错 openLoop（避免“上次没做完”一直挂着）。 */
export function clearOpenLoops(notes, key, { prefix = '', all = false } = {}) {
  const n = notes?.[String(key || '')];
  if (!n || !Array.isArray(n.openLoops) || !n.openLoops.length) return false;
  const before = n.openLoops.length;
  n.openLoops = all ? [] : n.openLoops.filter((x) => !String(x.text || '').startsWith(String(prefix || '')));
  if (n.openLoops.length !== before) { n.updatedAt = nowIso(); return true; }
  return false;
}

/** 清掉过期条目；返回是否有变化。 */
export function prune(notes, now = Date.now()) {
  let changed = false;
  for (const [key, n] of Object.entries(notes ?? {})) {
    const before = JSON.stringify(n);
    n.corrections = (n.corrections || []).filter((x) => now - Date.parse(x.at || 0) <= DEFAULTS.correctionTtlMs);
    n.openLoops = (n.openLoops || []).filter((x) => now - Date.parse(x.at || 0) <= DEFAULTS.openLoopTtlMs);
    n.facts = (n.facts || []).filter((x) => now - Date.parse(x.at || 0) <= DEFAULTS.openLoopTtlMs);
    if (!n.corrections.length && !n.openLoops.length && !n.facts.length) {
      delete notes[key];
      changed = true;
      continue;
    }
    if (JSON.stringify(n) !== before) changed = true;
  }
  return changed;
}

/** 给唤醒提示的短块：≤300 字；没有就返回空串。 */
export function renderBlock(notes, key, { now = Date.now(), maxChars = DEFAULTS.maxChars } = {}) {
  const n = notes?.[String(key || '')];
  if (!n) return '';
  const corrections = (n.corrections || []).filter((x) => now - Date.parse(x.at || 0) <= DEFAULTS.correctionTtlMs).slice(-2);
  const loops = (n.openLoops || []).filter((x) => now - Date.parse(x.at || 0) <= DEFAULTS.openLoopTtlMs).slice(-1);
  const facts = (n.facts || []).filter((x) => now - Date.parse(x.at || 0) <= DEFAULTS.correctionTtlMs).slice(-1);
  if (!corrections.length && !loops.length && !facts.length) return '';
  const lines = ['【这次要注意（你自己记的）】'];
  for (const x of corrections) lines.push(`- 他刚纠正过：${x.text}`);
  for (const x of loops) lines.push(`- 上次没做完：${x.text}${x.next ? `；下一步：${x.next}` : ''}`);
  for (const x of facts) lines.push(`- 刚记下的事实：${x.text}`);
  lines.push('（这些是刚才的现场记录；按它做，不用回一句“我记住了”。）');
  return [...lines.join('\n')].slice(0, maxChars).join('');
}

export function forKey(notes, key) {
  return notes?.[String(key || '')] || { corrections: [], openLoops: [], facts: [], updatedAt: '' };
}
