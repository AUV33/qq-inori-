// inori-skill-drafts.js · 练习通过后生成的技能草稿（她改/收/拒）
//
// 为什么单独一层：练习的结论不能直接写进技能库——草稿要经她确认，才成为“以后照做”的技能。
// 存储：data/state/skill-drafts.json

import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = { file: stateDataPath('skill-drafts.json'), max: 100 };
const nowIso = () => new Date().toISOString();
const clip = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');

function normalize(x) {
  if (!x || typeof x !== 'object' || !x.name) return null;
  return {
    id: String(x.id ?? ''),
    name: clip(x.name, 60),
    desc: clip(x.desc, 300),
    steps: Array.isArray(x.steps) ? x.steps.map((s) => clip(s, 200)).filter(Boolean).slice(0, 20) : [],
    verify: clip(x.verify, 200),
    tags: Array.isArray(x.tags) ? x.tags.map(String).slice(0, 8) : [],
    learningItemId: String(x.learningItemId ?? ''),
    evidence: clip(x.evidence, 300),
    status: ['draft', 'accepted', 'rejected'].includes(x.status) ? x.status : 'draft',
    at: String(x.at ?? nowIso()),
  };
}

export function load(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(j?.drafts) ? j.drafts : []).map(normalize).filter(Boolean).slice(-DEFAULTS.max);
  } catch { return []; }
}

export function save(drafts, file = DEFAULTS.file) {
  const list = (Array.isArray(drafts) ? drafts : []).map(normalize).filter(Boolean).slice(-DEFAULTS.max);
  const r = writeJsonDocument(file, { version: 1, drafts: list }, { source: 'skill-drafts' });
  if (!r.ok) throw new Error(r.error || '技能草稿写入失败');
  return list;
}

export function create(drafts, { name, desc = '', steps = [], verify = '', tags = [], learningItemId = '', evidence = '' } = {}) {
  const body = clip(name, 60);
  if (!body) return { ok: false, reason: 'empty-name' };
  const list = Array.isArray(drafts) ? drafts : [];
  if (list.some((d) => d.status === 'draft' && d.name === body)) return { ok: false, reason: 'duplicate' };
  const draft = normalize({
    id: 'sd' + crypto.randomBytes(4).toString('hex'),
    name: body, desc, steps, verify, tags, learningItemId, evidence, status: 'draft', at: nowIso(),
  });
  list.push(draft);
  return { ok: true, draft };
}

export function setStatus(drafts, id, status) {
  const d = (Array.isArray(drafts) ? drafts : []).find((x) => x.id === String(id));
  if (!d) return { ok: false, reason: 'not-found' };
  if (!['accepted', 'rejected'].includes(status)) return { ok: false, reason: 'bad-status' };
  d.status = status;
  d.decidedAt = nowIso();
  return { ok: true, draft: d };
}

export function pending(drafts) {
  return (Array.isArray(drafts) ? drafts : []).filter((d) => d.status === 'draft');
}

export function render(drafts, { max = 3, maxChars = 400 } = {}) {
  const list = pending(drafts).slice(-max);
  if (!list.length) return '';
  const lines = ['【练习通过后攒下的技能草稿（你自己改/收/拒）】'];
  for (const d of list) {
    lines.push(`- ${d.name}${d.verify ? `｜判据：${d.verify}` : ''}｜步骤：${d.steps.slice(0, 5).join(' → ')}  [${d.id}]`);
  }
  lines.push('（觉得对就收下；觉得只是这一次的巧合，就拒掉。不收也不会消失，先放着。）');
  return [...lines.join('\n')].slice(0, maxChars).join('');
}
