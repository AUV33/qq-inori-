// inori-skills.js · 她的技能库（可复用动作序列）
//
// 原则：技能只优化、不淘汰。
//   · 一条技能 = 描述 + 可执行步骤 + 成功判据（不是代码，是动作序列）
//   · 成功 success+1、置信度上升；失败 fail+1、置信度下降、失败点写进 hints
//   · 连续失败不会删除，最多标记 degraded（仍然保留在库和检索里）
//   · 重写技能保留 history/version；超上限只标记 archived，不从数组里删除
//   · [SKILL-ITER 2026-10-31] 一条技能 = 稳定 id + versions[]：改内容生成新版本，
//     当前版本独立记 success/fail/attempts/mastery，旧版成绩留在 versions/history，
//     verifiedVersion 绑定验证过的版本；不再让旧 mastery 继承到新版。
//
// 零依赖纯函数，落盘由调用方决定。历史测试见 ai-companion-kit/tests/legacy/test_skills.mjs
import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import crypto from 'node:crypto';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = {
  file: stateDataPath('skills.json'),
  maxSkills: 200,
  retireFailCount: 5,
  historyLimit: 10,
  hintLimit: 5,
};

const empty = () => ({ version: 1, items: [] });

export function load(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(j?.items)) return empty();
    return j;
  } catch { return empty(); }
}

export function save(store, file = DEFAULTS.file) {
  try {
    // 原子写（tmp+rename）：崩溃不留半截 JSON；锁等待超时兜底裸写（不丢比防半截更重要）
    const r = writeJsonDocument(file, store, { source: 'bridge/skills' });
    if (r.ok) return true;
    fs.mkdirSync(requireDir(file), { recursive: true });
    atomicWriteJson(file, store, { pretty: true });
    return true;
  } catch { return false; }
}
function requireDir(file) {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i > 0 ? file.slice(0, i) : '.';
}

const newId = () => 's' + crypto.randomBytes(4).toString('hex');
const nowIso = () => new Date().toISOString();
const VERSION_LIMIT = 20;
const currentVersionNo = (s) => Math.max(1, Number(s?.version) || 1);

function performanceOf(s) {
  return {
    success: Math.max(0, Number(s?.success) || 0),
    fail: Math.max(0, Number(s?.fail) || 0),
    attempts: Math.max(0, Number(s?.attempts) || 0),
    mastery: Math.max(0, Math.min(1, Number(s?.mastery) || 0)),
    confidence: Math.max(0, Math.min(1, Number(s?.confidence) || 0.5)),
  };
}

function versionSnapshot(skill, { reason = '', archivedAt = '' } = {}) {
  return {
    version: currentVersionNo(skill),
    desc: String(skill?.desc ?? '').slice(0, 300),
    steps: Array.isArray(skill?.steps) ? skill.steps.slice(0, 50) : [],
    verify: String(skill?.verify ?? '').slice(0, 200),
    verifyHuman: String(skill?.verifyHuman ?? '').slice(0, 200),
    tags: Array.isArray(skill?.tags) ? skill.tags.slice(0, 8).map(String) : [],
    learningItemId: String(skill?.learningItemId ?? ''),
    nextDrill: String(skill?.nextDrill ?? '').slice(0, 160),
    performance: performanceOf(skill),
    verifiedVersion: Number(skill?.verifiedVersion) || (skill?.verified ? currentVersionNo(skill) : 0),
    verifiedAt: String(skill?.verifiedAt ?? ''),
    verifiedBy: String(skill?.verifiedBy ?? ''),
    hints: Array.isArray(skill?.hints) ? skill.hints.slice(-DEFAULTS.hintLimit) : [],
    reason: String(reason || '').slice(0, 40),
    archivedAt: String(archivedAt || ''),
  };
}

/** 把 flat 字段同步到当前版本快照，并从 versions 派生 lifetime。 */
function syncCurrentVersion(skill) {
  if (!Array.isArray(skill.versions)) skill.versions = [];
  const no = currentVersionNo(skill);
  const snap = versionSnapshot(skill, { reason: 'current' });
  const idx = skill.versions.findIndex((v) => Number(v?.version) === no);
  if (idx >= 0) skill.versions[idx] = { ...skill.versions[idx], ...snap, archivedAt: skill.versions[idx].archivedAt || '' };
  else skill.versions.push(snap);
  skill.versions.sort((a, b) => Number(a.version) - Number(b.version));
  if (skill.versions.length > VERSION_LIMIT) skill.versions = skill.versions.slice(-VERSION_LIMIT);
  skill.lifetime = skill.versions.reduce((acc, v) => {
    const p = v?.performance ?? {};
    acc.success += Number(p.success) || 0;
    acc.fail += Number(p.fail) || 0;
    acc.attempts += Number(p.attempts) || 0;
    return acc;
  }, { success: 0, fail: 0, attempts: 0 });
}

/** 旧版归档：把当前版快照压进 versions/history，然后升版本并把当前成绩清零。 */
function archiveCurrentVersion(skill, reason = 'revise') {
  ensureFields(skill);
  // 旧版失败史留在旧版本；当前版 fail 清零，hints 保留给“失败点”提示。
  const keepHints = Array.isArray(skill.hints) ? skill.hints.slice(-8) : [];
  const no = currentVersionNo(skill);
  const snap = versionSnapshot(skill, { reason, archivedAt: nowIso() });
  const idx = skill.versions.findIndex((v) => Number(v?.version) === no);
  if (idx >= 0) skill.versions[idx] = snap;
  else skill.versions.push(snap);
  skill.history = (Array.isArray(skill.history) ? skill.history : []).concat([{
    ...snap,
    updatedAt: skill.updatedAt,
  }]).slice(-DEFAULTS.historyLimit);
  skill.version = no + 1;
  skill.success = 0;
  skill.fail = 0;
  skill.hints = keepHints;
  skill.attempts = 0;
  skill.confidence = 0.5;
  skill.mastery = 0;
  skill.status = 'untested';
  skill.degraded = false;
  skill.degradedReason = '';
  skill.verified = false;
  skill.verifyOk = false;
  skill.verifiedVersion = 0;
  skill.verifiedAt = '';
  skill.verifiedBy = '';
  skill.verifyNote = '';
  skill.lastOk = null;
  skill.lastSuccessAt = '';
  skill.lastResultAt = '';
  skill.evidence = [];
  skill.retired = false;
  skill.updatedAt = nowIso();
  skill.versions.push(versionSnapshot(skill, { reason: 'current' }));
  syncCurrentVersion(skill);
  return snap;
}

/** 给旧数据补齐新字段（只补默认值，不改已有值）。 */
export function ensureFields(skill) {
  if (!skill || typeof skill !== 'object') return skill;
  if (!Number.isFinite(Number(skill.version))) skill.version = 1;
  if (!Number.isFinite(Number(skill.attempts))) skill.attempts = (Number(skill.success) || 0) + (Number(skill.fail) || 0);
  if (!Number.isFinite(Number(skill.confidence))) skill.confidence = 0.5;
  if (!Array.isArray(skill.hints)) skill.hints = [];
  if (!Array.isArray(skill.history)) skill.history = [];
  if (!skill.status) skill.status = skill.retired ? 'retired' : (Number(skill.success) > 0 ? 'ok' : 'untested');
  if (skill.degraded === undefined) skill.degraded = false;
  if (skill.archived === undefined) skill.archived = false;
  // [SKILL-MASTERY] 学会 ≠ 做好：mastery 只在“验证过的成功/失败”上重算；旧数据按 success/attempts 估。
  if (!Number.isFinite(Number(skill.mastery))) {
    const a = Number(skill.attempts) || 0;
    const s = Number(skill.success) || 0;
    skill.mastery = a > 0 ? Number((s / a).toFixed(3)) : 0;
  }
  if (!Array.isArray(skill.evidence)) skill.evidence = [];
  if (skill.learningItemId === undefined) skill.learningItemId = '';
  if (skill.verifyHuman === undefined) skill.verifyHuman = '';
  if (skill.nextDrill === undefined) skill.nextDrill = '';
  if (skill.verifiedBy === undefined) skill.verifiedBy = '';
  if (!Number.isFinite(Number(skill.verifiedVersion))) skill.verifiedVersion = skill.verified ? currentVersionNo(skill) : 0;
  if (skill.verifyOk === undefined) skill.verifyOk = skill.verified === true;
  if (!Array.isArray(skill.versions)) skill.versions = [];
  // 旧 history（只有文本）先转成无成绩的版本快照，避免第一版被丢掉。
  if (!skill.versions.length && Array.isArray(skill.history) && skill.history.length) {
    skill.versions = skill.history.map((h) => ({
      version: Number(h?.version) || 1,
      desc: String(h?.desc ?? '').slice(0, 300),
      steps: Array.isArray(h?.steps) ? h.steps.slice(0, 50) : [],
      verify: String(h?.verify ?? '').slice(0, 200),
      performance: { success: 0, fail: 0, attempts: 0, mastery: 0, confidence: 0.5 },
      verifiedVersion: 0, verifiedAt: '', verifiedBy: '', hints: [],
      reason: String(h?.reason ?? 'history'), archivedAt: String(h?.archivedAt ?? ''),
    }));
  }
  syncCurrentVersion(skill);
  return skill;
}

function ensureStore(store) {
  if (!store || !Array.isArray(store.items)) return { version: 1, items: [] };
  store.items.forEach(ensureFields);
  return store;
}

/** 字符二元组（环境无分词器；与 memory-retrieve 保持同一套近似） */
function bigrams(s) {
  const t = String(s ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}
function jaccard(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const v of x) if (y.has(v)) inter += 1;
  return inter / (x.size + y.size - inter);
}
function score(query, skill) {
  const text = String(query ?? '').replace(/\s+/g, '');
  const hay = `${skill.name} ${skill.desc} ${skill.verify || ''} ${(skill.tags || []).join(' ')}`.replace(/\s+/g, '');
  if (!text || !hay) return 0;
  // 二元组看顺序，一元组容忍说法差异（短 query 只有一元组才命中）
  const q = bigrams(text);
  const h = bigrams(hay);
  let bi = 0;
  for (const x of q) if (h.has(x)) bi += 1;
  const biCov = q.size ? bi / q.size : 0;
  const chars = new Set(text);
  let uni = 0;
  for (const ch of chars) if (hay.includes(ch)) uni += 1;
  const uniCov = chars.size ? uni / chars.size : 0;
  return Number((0.55 * biCov + 0.45 * uniCov).toFixed(4));
}

/** 新增或更新一条技能（同名视为同一条；更新生成新版本，旧版进 versions/history） */
export function upsert(store, { name, desc = '', steps = [], verify = '', verifyHuman = '', tags = [], learningItemId = '', nextDrill = '' }) {
  ensureStore(store);
  const nm = String(name ?? '').trim().slice(0, 60);
  if (!nm) throw new Error('技能必须有名字');
  if (!Array.isArray(steps) || !steps.length) throw new Error('技能至少要有一步');
  const existing = store.items.find((s) => s.name === nm && !s.archived);
  const now = Date.now();
  if (existing) {
    ensureFields(existing);
    // 只改传了的东西：传空字符串不该把原来的描述/判据/标签清掉
    const nextDesc = String(desc).trim() ? String(desc).slice(0, 300) : existing.desc;
    const nextSteps = steps.slice(0, 50);
    const nextVerify = String(verify).trim() ? String(verify).slice(0, 200) : existing.verify;
    const nextVerifyHuman = String(verifyHuman).trim() ? String(verifyHuman).slice(0, 200) : existing.verifyHuman;
    const nextTags = Array.isArray(tags) && tags.length ? tags.slice(0, 8).map(String) : existing.tags;
    const changed = nextDesc !== existing.desc
      || JSON.stringify(nextSteps) !== JSON.stringify(existing.steps || [])
      || nextVerify !== existing.verify
      || nextVerifyHuman !== existing.verifyHuman
      || JSON.stringify(nextTags) !== JSON.stringify(existing.tags || [])
      || Boolean(learningItemId && String(learningItemId) !== existing.learningItemId)
      || Boolean(String(nextDrill).trim() && String(nextDrill).trim() !== existing.nextDrill);
    if (!changed) {
      return { store, skill: existing, created: false, changed: false };
    }
    const fromVersion = currentVersionNo(existing);
    archiveCurrentVersion(existing, 'rewrite');
    existing.desc = nextDesc;
    existing.steps = nextSteps;
    existing.verify = nextVerify;
    existing.verifyHuman = nextVerifyHuman;
    existing.tags = nextTags;
    if (learningItemId) existing.learningItemId = String(learningItemId);
    if (String(nextDrill).trim()) existing.nextDrill = String(nextDrill).slice(0, 160);
    existing.updatedAt = nowIso();
    syncCurrentVersion(existing);
    return { store, skill: existing, created: false, changed: true, fromVersion, toVersion: currentVersionNo(existing) };
  }
  const skill = {
    id: newId(), name: nm, desc: String(desc).slice(0, 300),
    steps: steps.slice(0, 50), verify: String(verify).slice(0, 200), verifyHuman: String(verifyHuman || '').slice(0, 200),
    tags: Array.isArray(tags) ? tags.slice(0, 8).map(String) : [],
    success: 0, fail: 0, attempts: 0, confidence: 0.5, status: 'untested',
    hints: [], history: [], version: 1, versions: [], lifetime: { success: 0, fail: 0, attempts: 0 },
    degraded: false, archived: false, retired: false, createdAt: now, updatedAt: now, lastUsedAt: 0,
    mastery: 0, evidence: [], learningItemId: String(learningItemId || ''),
    nextDrill: String(nextDrill || '').slice(0, 160), verifiedBy: '', verifiedVersion: 0,
    verified: false, verifyOk: false, verifyAt: '', verifyNote: '',
  };
  ensureFields(skill);
  store.items.push(skill);
  // [SKILL-NO-DELETE] 超上限只标记 archived，不从数组删除（技能本体与失败史都保留）
  if (store.items.length > DEFAULTS.maxSkills) {
    const alive = store.items.filter((s) => !s.archived);
    const overflow = alive
      .sort((a, b) => Number(a.retired) - Number(b.retired)
        || Number(b.degraded) - Number(a.degraded)
        || Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0))
      .slice(0, Math.max(0, alive.length - DEFAULTS.maxSkills));
    for (const s of overflow) {
      s.archived = true;
      s.archivedAt = nowIso();
    }
  }
  return { store, skill, created: true };
}

/**
 * 修改已有技能：生成新版本（不覆盖旧版）。
 * patch: { desc?, steps?, verify?, nextDrill?, reason? }
 */
export function revise(store, id, patch = {}) {
  const skill = (store?.items || []).find((x) => x.id === String(id));
  if (!skill) return { ok: false, reason: 'not-found' };
  ensureFields(skill);
  const nextDesc = patch.desc !== undefined ? String(patch.desc).slice(0, 300) : skill.desc;
  const nextSteps = Array.isArray(patch.steps) && patch.steps.length
    ? patch.steps.map((x) => String(x).slice(0, 200)).slice(0, 50)
    : skill.steps;
  const nextVerify = patch.verify !== undefined ? String(patch.verify).slice(0, 200) : skill.verify;
  const nextDrill = patch.nextDrill !== undefined ? String(patch.nextDrill).slice(0, 160) : skill.nextDrill;
  const changed = nextDesc !== skill.desc
    || JSON.stringify(nextSteps) !== JSON.stringify(skill.steps || [])
    || nextVerify !== skill.verify
    || nextDrill !== skill.nextDrill;
  if (!changed) return { ok: true, changed: false, skill, version: currentVersionNo(skill) };
  const fromVersion = currentVersionNo(skill);
  archiveCurrentVersion(skill, String(patch.reason || 'edit').slice(0, 40));
  skill.desc = nextDesc;
  skill.steps = nextSteps;
  skill.verify = nextVerify;
  skill.nextDrill = nextDrill;
  skill.updatedAt = nowIso();
  syncCurrentVersion(skill);
  return { ok: true, changed: true, skill, fromVersion, toVersion: currentVersionNo(skill) };
}

/**
 * 回滚到旧版本的内容：不删除新版本，而是复制旧版内容生成一个“新的当前版”。
 * 旧成绩不恢复（新版本从零开始），旧版本仍留在 versions/history。
 */
export function rollback(store, id, version) {
  const skill = (store?.items || []).find((x) => x.id === String(id));
  if (!skill) return { ok: false, reason: 'not-found' };
  ensureFields(skill);
  const targetVersion = Number(version);
  const target = (skill.versions || []).find((v) => Number(v?.version) === targetVersion);
  if (!target) return { ok: false, reason: 'version-not-found' };
  if (targetVersion === currentVersionNo(skill)) {
    return { ok: true, changed: false, skill, version: currentVersionNo(skill), restoredFrom: targetVersion };
  }
  const fromVersion = currentVersionNo(skill);
  archiveCurrentVersion(skill, `rollback:v${targetVersion}`);
  skill.desc = String(target.desc ?? skill.desc).slice(0, 300);
  skill.steps = Array.isArray(target.steps) && target.steps.length ? target.steps.slice(0, 50) : skill.steps;
  skill.verify = String(target.verify ?? skill.verify).slice(0, 200);
  if (Array.isArray(target.tags)) skill.tags = target.tags.slice(0, 8).map(String);
  if (target.learningItemId !== undefined) skill.learningItemId = String(target.learningItemId || '');
  if (target.nextDrill !== undefined) skill.nextDrill = String(target.nextDrill || '').slice(0, 160);
  skill.updatedAt = nowIso();
  syncCurrentVersion(skill);
  return {
    ok: true, changed: true, skill, fromVersion, toVersion: currentVersionNo(skill),
    restoredFrom: targetVersion,
  };
}

/**
 * 合并重复技能：target 保留内容，source 归档；只合并可共享的元数据，
 * 不自动拼接 steps（避免把两套不同做法混成一条）。
 */
export function merge(store, sourceId, targetId) {
  ensureStore(store);
  const source = store.items.find((s) => s.id === String(sourceId));
  const target = store.items.find((s) => s.id === String(targetId));
  if (!source || !target) return { ok: false, reason: 'not-found' };
  if (source.id === target.id) return { ok: false, reason: 'same-skill' };
  if (source.archived) return { ok: false, reason: 'source-archived' };
  if (target.archived) return { ok: false, reason: 'target-archived' };
  ensureFields(source);
  ensureFields(target);
  const uniq = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  target.tags = uniq(target.tags, source.tags).slice(0, 8);
  target.hints = uniq(target.hints, source.hints).slice(-DEFAULTS.hintLimit);
  target.evidence = uniq(target.evidence, source.evidence).slice(-20);
  target.mergedFrom = (Array.isArray(target.mergedFrom) ? target.mergedFrom : []).concat([{
    id: source.id,
    name: source.name,
    version: currentVersionNo(source),
    performance: performanceOf(source),
    mergedAt: nowIso(),
  }]).slice(-20);
  target.updatedAt = nowIso();
  source.archived = true;
  source.archivedAt = nowIso();
  source.mergedInto = target.id;
  syncCurrentVersion(source);
  syncCurrentVersion(target);
  return { ok: true, source, target };
}

/** 只读版本历史（给 skill_history 工具用）。 */
export function history(store, id) {
  const skill = (store?.items || []).find((x) => x.id === String(id));
  if (!skill) return null;
  ensureFields(skill);
  return {
    id: skill.id,
    name: skill.name,
    currentVersion: currentVersionNo(skill),
    lifetime: skill.lifetime,
    versions: (skill.versions || []).map((v) => ({ ...v })),
  };
}

/** 按描述检索技能（只返回未归档/未停用的；降级技能仍在，只降权） */
export function find(store, query, limit = 3) {
  ensureStore(store);
  const q = String(query ?? '').trim();
  const alive = store.items.filter((s) => !s.retired && !s.archived);
  if (!q) return alive.slice(-limit).map((s) => ({ skill: s, score: 0 }));
  // [SKILL-FB] 成败 + 置信度回写进检索打分；降级技能保留但降权。
  return alive
    .map((s) => ({
      skill: s,
      score: score(q, s)
        + (s.success ? Math.min(0.2, s.success * 0.05) : 0)
        - (s.fail ? Math.min(0.2, s.fail * 0.05) : 0)
        + (Number(s.confidence ?? 0.5) - 0.5) * 0.2
        - (s.degraded ? 0.15 : 0),
    }))
    .filter((x) => x.score > 0.28)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** [KNOWING-DOING] 记一次「被注入」：知道 ≠ 做到，注入次数与成败分开记。 */
export function noteInjected(store, id) {
  const s = store.items.find((x) => x.id === id);
  if (!s) return null;
  ensureFields(s);
  s.injected = (Number(s.injected) || 0) + 1;
  s.lastInjectedAt = Date.now();
  return s;
}

/**
 * 统一结果入口（A）：聊天/任务/手机/手动都走这里。
 * ok=true 成功；ok=false 失败（写 hint、降置信度、degraded 仍保留）；ok=null 不确定（只记尝试）。
 * 绝不删除技能；失败 ≥5 且从未成功只标记 degraded。
 */
export function applyOutcome(store, id, { ok = null, hint = '', source = '', verifiedBy = '', evidence = '' } = {}) {
  const s = (store?.items || []).find((x) => x.id === id);
  if (!s) return null;
  ensureFields(s);
  const ver = currentVersionNo(s);
  // [SKILL-TRUTH] 自动路径（turn/activity）没有 verify 就不算成功，只记 attempt。
  // 手动 recordResult / 测试仍保留旧语义；需要严格判定的调用方传 verifiedBy='verify'。
  if (ok === true && !verifiedBy && ['turn', 'activity'].includes(String(source))) ok = null;
  s.attempts = (Number(s.attempts) || 0) + 1;
  s.lastUsedAt = Date.now();
  s.lastResultAt = nowIso();
  if (source) s.lastSource = String(source).slice(0, 40);
  if (ok === true) {
    s.success = (Number(s.success) || 0) + 1;
    s.confidence = Math.min(0.95, +((Number(s.confidence) || 0.5) + 0.05).toFixed(2));
    s.status = 'ok';
    s.degraded = false;
    s.degradedReason = '';
    s.lastOk = true;
    s.lastSuccessAt = nowIso();
    if (verifiedBy) {
      s.verifiedBy = String(verifiedBy).slice(0, 40);
      s.verified = true;
      s.verifiedVersion = ver;
      s.verifiedAt = nowIso();
    }
    if (evidence) s.evidence = (Array.isArray(s.evidence) ? s.evidence : []).concat([String(evidence).slice(0, 300)]).slice(-20);
  } else if (ok === false) {
    s.fail = (Number(s.fail) || 0) + 1;
    s.confidence = Math.max(0.2, +((Number(s.confidence) || 0.5) - 0.1).toFixed(2));
    s.status = 'needs_optimization';
    s.lastOk = false;
    const h = String(hint || '').trim().slice(0, 160);
    if (h && !s.hints.includes(h)) {
      s.hints.push(h);
      if (s.hints.length > DEFAULTS.hintLimit) s.hints = s.hints.slice(-DEFAULTS.hintLimit);
    }
    if (Number(s.fail) >= DEFAULTS.retireFailCount && Number(s.success || 0) === 0) {
      s.degraded = true;
      s.status = 'degraded';
      s.degradedReason = `连续失败 ${s.fail} 次且从未成功；保留失败史，先别照这套做`;
    }
  } else {
    s.status = s.status || 'untested';
    s.lastOk = null;
  }
  // [SKILL-MASTERY] 掌握度不靠“成功率”硬算（旧数据的成功是回合完成，会虚高）。
  // 只有验证过的成功才 +0.1，真失败 -0.05；普通 attempt 不改变掌握度。
  const oldMastery = Number(s.mastery) || 0;
  if (ok === true && verifiedBy) s.mastery = Number(Math.min(1, oldMastery + 0.1).toFixed(3));
  else if (ok === false) s.mastery = Number(Math.max(0, oldMastery - 0.05).toFixed(3));
  s.updatedAt = nowIso();
  syncCurrentVersion(s);
  return s;
}

/** 兼容旧调用（MCP skill_record / 测试）：语义已改为“只优化、不淘汰”。 */
export function recordResult(store, id, ok) {
  return applyOutcome(store, id, { ok: ok === true ? true : (ok === false ? false : null), source: 'record' });
}

/** [SKILL-DROP] 显式删除用（归档由调用方写）：只由 skill_delete 调用，自动路径绝不删 */
export function drop(store, id) {
  const i = (store?.items || []).findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [item] = store.items.splice(i, 1);
  return item;
}

/** 给 prompt 用的一小段文字（降级技能也列出，带失败点提示） */
export function render(store, opts = {}) {
  ensureStore(store);
  const limit = Number(opts.limit) || 5;
  const alive = store.items.filter((s) => !s.retired && !s.archived);
  if (!alive.length) return '';
  const picked = alive
    .slice()
    .sort((a, b) => ((b.success - b.fail) + (Number(b.confidence ?? 0.5) - 0.5) * 2)
      - ((a.success - a.fail) + (Number(a.confidence ?? 0.5) - 0.5) * 2))
    .slice(0, limit);
  return [
    '你学过这些做法（可以照做，也可以改）：',
    ...picked.map((s) => {
      const hint = (s.hints || []).slice(-1)[0];
      const state = s.degraded ? `｜已降级${hint ? `（上次失败：${hint}）` : ''}` : '';
      return `- ${s.name}：${s.desc || '（没写说明）'}（成功 ${s.success} / 失败 ${s.fail}）${state}`;
    }),
  ].join('\n');
}

export function stats(store) {
  ensureStore(store);
  const total = store.items.length;
  const retired = store.items.filter((s) => s.retired).length;
  const archived = store.items.filter((s) => s.archived).length;
  const degraded = store.items.filter((s) => s.degraded).length;
  const proven = store.items.filter((s) => s.success > 0 && !s.retired && !s.archived).length;
  const verified = store.items.filter((s) => s.verifyOk === true).length;
  return { total, retired, archived, degraded, proven, verified };
}

/** 给 learning-report / 控制台看的只读统计；只报事实，不做评分。 */
export function analytics(store) {
  ensureStore(store);
  const items = Array.isArray(store?.items) ? store.items : [];
  const sums = items.reduce((acc, s) => {
    acc.versions += Array.isArray(s.versions) ? s.versions.length : 0;
    acc.injected += Number(s.injected) || 0;
    acc.attempts += Number(s.attempts) || 0;
    acc.success += Number(s.success) || 0;
    acc.fail += Number(s.fail) || 0;
    acc.merged += Array.isArray(s.mergedFrom) ? s.mergedFrom.length : 0;
    if (s.lifetime) {
      acc.lifetime.success += Number(s.lifetime.success) || 0;
      acc.lifetime.fail += Number(s.lifetime.fail) || 0;
      acc.lifetime.attempts += Number(s.lifetime.attempts) || 0;
    }
    return acc;
  }, { versions: 0, injected: 0, attempts: 0, success: 0, fail: 0, merged: 0, lifetime: { success: 0, fail: 0, attempts: 0 } });
  const active = items.filter((s) => !s.retired && !s.archived);
  const verifiedCurrent = items.filter((s) => Number(s.verifiedVersion) === currentVersionNo(s) && Number(s.verifiedVersion) > 0).length;
  return {
    total: items.length,
    active: active.length,
    archived: items.filter((s) => s.archived).length,
    retired: items.filter((s) => s.retired).length,
    degraded: items.filter((s) => s.degraded).length,
    multiVersion: items.filter((s) => Array.isArray(s.versions) && s.versions.length > 1).length,
    versions: sums.versions,
    verifiedCurrent,
    verificationRate: items.length ? Number((verifiedCurrent / items.length).toFixed(3)) : null,
    injected: sums.injected,
    attempts: sums.attempts,
    success: sums.success,
    fail: sums.fail,
    merged: sums.merged,
    lifetime: sums.lifetime,
  };
}

/** D：找高度相似的可能重复技能（只给建议，不自动合并） */
export function suggestMerges(store, threshold = 0.8) {
  ensureStore(store);
  const items = store.items.filter((s) => !s.archived);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const sim = jaccard(`${a.name} ${a.desc || ''}`, `${b.name} ${b.desc || ''}`);
      if (sim >= threshold) out.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, similarity: +sim.toFixed(3) });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, 20);
}
