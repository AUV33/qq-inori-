// inori-language-episodes.js · 语言用法事件：不是词典，是“谁在什么场景怎么用”
//
// 每条记录 phrase + context + meaning/guess + speaker + register + confidence + 她后来用没用。
// 只记她愿意记的；不自动把每个新词都塞进库，也不按条数考核。
//
// 纯逻辑 + JSONL 读写；检索先用简单 token 匹配，后续可接现有 embedding。

import fs from 'node:fs';
import { atomicWriteText } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';

export function createLanguageEpisode({
  phrase = '', context = '', meaning = '', speaker = '', register = '群聊',
  confidence = 0.5, source = 'her', now = Date.now(),
} = {}) {
  const p = String(phrase ?? '').trim().slice(0, 60);
  if (!p) throw new Error('phrase 不能为空');
  return {
    at: new Date(now).toISOString(),
    phrase: p,
    context: String(context ?? '').trim().slice(0, 240),
    meaning: String(meaning ?? '').trim().slice(0, 240),
    speaker: String(speaker ?? '').trim().slice(0, 80),
    register: String(register ?? '').trim().slice(0, 30),
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    source: String(source ?? 'her'),
    used: false,
    reaction: '',
  };
}

export function appendLanguageEpisode(file, episode) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(episode) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

export function readLanguageEpisodes(file, { limit = 200 } = {}) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Number(limit) || 200));
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function markLanguageEpisodeUsed(rows, phrase, { reaction = '', outcome = 'unknown', now = Date.now() } = {}) {
  const p = String(phrase ?? '').trim();
  let hit = false;
  const next = (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || hit || String(r.phrase || '') !== p) return r;
    hit = true;
    return { ...r, used: true, reaction: String(reaction || '').slice(0, 240), outcome: String(outcome || 'unknown'), usedAt: new Date(now).toISOString() };
  });
  return { rows: next, hit };
}

export function saveLanguageEpisodes(file, rows) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteText(file, (Array.isArray(rows) ? rows : []).map((r) => JSON.stringify(r)).join('\n') + (rows?.length ? '\n' : ''));
    return true;
  } catch { return false; }
}

export function findLanguageEpisodes(rows, phrase, { limit = 2 } = {}) {
  const p = String(phrase ?? '').trim();
  if (!p) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && String(r.phrase || '').includes(p))
    .slice(-Math.max(1, Number(limit) || 2));
}

/** 按场景词重叠找用法（不是只匹配 phrase）；用于“类似场景可以这么说”。 */
export function findLanguageEpisodesByContext(rows, text, { limit = 2 } = {}) {
  const body = String(text ?? '');
  if (!body.trim()) return [];
  const bigrams = new Set();
  for (let i = 0; i < body.length - 1; i++) bigrams.add(body.slice(i, i + 2));
  return (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const ctx = String(r?.context || '');
      let overlap = 0;
      for (let i = 0; i < ctx.length - 1; i++) if (bigrams.has(ctx.slice(i, i + 2))) overlap++;
      return { r, overlap };
    })
    .filter((x) => x.overlap >= 2)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, Math.max(1, Number(limit) || 2))
    .map((x) => x.r);
}

export function renderLanguageEpisodeBlock(rows, { limit = 2 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).slice(-Math.max(1, Number(limit) || 2));
  if (!list.length) return '';
  const lines = list.map((r) => `- 「${r.phrase}」：${r.meaning || '意思还不确定'}（${r.register || '场景不明'}）`);
  return `【你用过的说法】\n${lines.join('\n')}`;
}
