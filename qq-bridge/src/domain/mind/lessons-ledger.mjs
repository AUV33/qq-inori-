// lessons-ledger.mjs · 宪章 §5.4 / C2/C3：教训状态机（append-only 事件 → 折叠状态）
//
// 干什么：把"经验"从一段文本升级为带状态、置信度、证据、TTL 的记录：
//   candidate → active → verified | demoted | expired | contradicted
//   一次证伪即降级；连续 2 次证伪淘汰；90 天无印证过期；冲突标 contradicted 等人裁决。
// 为什么：旧 lessons.jsonl 只有 confidence/up/down，没有 evidence_id、没有状态迁移、没有 TTL，
//         也无法回答"这条经验谁写的、被验证几次、为什么还在/已淘汰"（宪章 §5.4 验收）。
// 输入输出：纯函数 foldLessons(events, {now, ttlDays})；appendLedger 只追加、不重写历史。
// 失败模式：坏事件进 anomalies 不崩溃；未知 id 的 verdict 不伪造条目。
// 不做什么：不生成文本、不调模型、不替她裁决冲突（contradicted 只标记，等人/她）。

import path from 'node:path';
import { appendJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

export const LESSONS_LEDGER_VERSION = 1;
export const LESSON_STATUSES = Object.freeze(['candidate', 'active', 'verified', 'demoted', 'expired', 'contradicted']);
export const DEFAULT_TTL_DAYS = Object.freeze({ candidate: 60, active: 90, verified: 180, demoted: 14 });
export const LESSON_LEDGER_FILE = 'lessons-ledger.jsonl';
export const LIMITS = Object.freeze({ rule: 240, evidence: 200 });
const ID_RE = /^ls_\d{8}_[0-9a-f]{6}$/;
const DAY_MS = 86400000;

export class LessonsLedgerError extends Error {
  constructor(message, code = 'lessons-ledger') {
    super(message);
    this.name = 'LessonsLedgerError';
    this.code = code;
  }
}

const clip = (value, max) => [...String(value ?? '').trim()].slice(0, max).join('');
const clamp01 = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : 0);
const round3 = (n) => Math.round(clamp01(n) * 1000) / 1000;

function makeId(now) {
  const d = new Date(Number(now) || Date.now());
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  return `ls_${ymd}_${rand}`;
}

export function buildCandidate({ id, rule, evidenceIds = [], scope = ['global'], source = 'capture', confidence = 0.3, ttlDays, legacyId = '', at = Date.now() } = {}) {
  const text = String(rule ?? '').trim();
  if (!text) throw new LessonsLedgerError('rule 不能为空');
  if ([...text].length > LIMITS.rule) throw new LessonsLedgerError(`rule 不能超过 ${LIMITS.rule} 字`);
  const evidence = (Array.isArray(evidenceIds) ? evidenceIds : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 20);
  if (!evidence.length) throw new LessonsLedgerError('candidate 必须带 evidence_id（无证据不固化）');
  const scopes = (Array.isArray(scope) ? scope : [scope]).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8);
  if (!scopes.length) throw new LessonsLedgerError('scope 不能为空');
  const recordId = id || makeId(at);
  if (!ID_RE.test(recordId)) throw new LessonsLedgerError('lesson id 非法（应为 ls_YYYYMMDD_hex6）');
  const ttl = Number(ttlDays);
  return {
    v: LESSONS_LEDGER_VERSION, kind: 'candidate', id: recordId,
    rule: text.slice(0, LIMITS.rule), evidenceIds: evidence, scope: scopes,
    source: String(source ?? 'capture').slice(0, 40), confidence: clamp01(confidence),
    ttlDays: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_DAYS.candidate,
    legacyId: clip(legacyId, 80),
    at: Number(at),
  };
}

export function buildVerdict(id, polarity, { evidenceId = '', reason = '', at = Date.now() } = {}) {
  if (!ID_RE.test(String(id ?? ''))) throw new LessonsLedgerError('lesson id 非法');
  if (polarity !== 'pos' && polarity !== 'neg') throw new LessonsLedgerError('polarity 只能是 pos/neg');
  return {
    v: LESSONS_LEDGER_VERSION, kind: 'verdict', id: String(id), polarity,
    evidenceId: clip(evidenceId, LIMITS.evidence), reason: clip(reason, LIMITS.evidence), at: Number(at),
  };
}

export function buildContradiction(id, { by = '', reason = '', at = Date.now() } = {}) {
  if (!ID_RE.test(String(id ?? ''))) throw new LessonsLedgerError('lesson id 非法');
  return { v: LESSONS_LEDGER_VERSION, kind: 'contradicted', id: String(id), by: clip(by, LIMITS.evidence), reason: clip(reason, LIMITS.evidence), at: Number(at) };
}

export function buildExpiry(id, { reason = 'ttl', at = Date.now() } = {}) {
  if (!ID_RE.test(String(id ?? ''))) throw new LessonsLedgerError('lesson id 非法');
  return { v: LESSONS_LEDGER_VERSION, kind: 'expired', id: String(id), reason: clip(reason, 80), at: Number(at) };
}

function confidenceFor(status, pos, neg) {
  if (status === 'verified') return round3(Math.min(0.95, 0.8 + 0.02 * Math.max(0, pos - 2)));
  if (status === 'active') return round3(Math.min(0.7, 0.5 + 0.03 * Math.max(0, pos)));
  if (status === 'demoted') return round3(Math.max(0.05, 0.3 - 0.1 * Math.max(0, neg - 1)));
  return 0.3;
}

/** 事件 → 状态：唯一折叠入口；TTL 以 now 实时判（不写盘也能得到"已过期"）。 */
export function foldLessons(events, { now = Date.now(), ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const byId = new Map();
  const anomalies = [];
  for (const row of Array.isArray(events) ? events : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id ?? '');
    if (row.kind === 'candidate') {
      if (byId.has(id)) { anomalies.push({ id, reason: 'duplicate-candidate' }); continue; }
      if (!ID_RE.test(id) || !String(row.rule ?? '').trim() || !Array.isArray(row.evidenceIds) || !row.evidenceIds.length) {
        anomalies.push({ id, reason: 'bad-candidate' }); continue;
      }
      byId.set(id, {
        id, rule: clip(row.rule, LIMITS.rule), status: 'candidate',
        confidence: clamp01(row.confidence), evidenceIds: row.evidenceIds.map(String).slice(0, 20),
        scope: (Array.isArray(row.scope) ? row.scope : ['global']).map(String).slice(0, 8),
        source: String(row.source ?? 'capture').slice(0, 40), legacyId: String(row.legacyId ?? '').slice(0, 80),
        pos: 0, neg: 0, negativeStreak: 0, positiveStreak: 0,
        createdAt: Number(row.at) || Number(now), lastConfirmedAt: null, updatedAt: Number(row.at) || Number(now),
        ttlDays: Number(row.ttlDays) > 0 ? Number(row.ttlDays) : DEFAULT_TTL_DAYS.candidate,
        contradictedReason: '', expiredReason: '',
      });
      continue;
    }
    const lesson = byId.get(id);
    if (!lesson) { anomalies.push({ id, reason: 'unknown-id' }); continue; }
    if (lesson.status === 'expired' && row.kind !== 'candidate') { anomalies.push({ id, reason: 'already-expired' }); continue; }
    if (row.kind === 'verdict') {
      if (row.polarity === 'pos') {
        lesson.pos += 1; lesson.positiveStreak += 1; lesson.negativeStreak = 0;
        lesson.lastConfirmedAt = Number(row.at) || Number(now);
        if (lesson.status === 'candidate' || lesson.status === 'demoted') lesson.status = 'active';
        if (lesson.status === 'active' && lesson.pos >= 2 && lesson.neg === 0) lesson.status = 'verified';
      } else if (row.polarity === 'neg') {
        lesson.neg += 1; lesson.negativeStreak += 1; lesson.positiveStreak = 0;
        if (lesson.status === 'candidate' || lesson.status === 'active' || lesson.status === 'verified') lesson.status = 'demoted';
        else if (lesson.status === 'demoted' && lesson.negativeStreak >= 2) { lesson.status = 'expired'; lesson.expiredReason = 'consecutive-negatives'; }
      } else { anomalies.push({ id, reason: 'bad-polarity' }); continue; }
      if (row.evidenceId) lesson.evidenceIds = [...lesson.evidenceIds, String(row.evidenceId)].slice(-20);
    } else if (row.kind === 'contradicted') {
      lesson.status = 'contradicted';
      lesson.contradictedReason = clip(row.reason || row.by || '', LIMITS.evidence);
    } else if (row.kind === 'expired') {
      lesson.status = 'expired';
      lesson.expiredReason = clip(row.reason || 'expired', 80);
    } else { anomalies.push({ id, reason: `unknown-kind:${row.kind}` }); continue; }
    lesson.updatedAt = Number(row.at) || Number(now);
    lesson.confidence = confidenceFor(lesson.status, lesson.pos, lesson.neg);
  }

  // TTL：只对可过期状态生效；过期是"视图"，不写历史。
  for (const lesson of byId.values()) {
    if (!['candidate', 'active', 'verified', 'demoted'].includes(lesson.status)) continue;
    const ttl = Number(ttlDays?.[lesson.status] ?? lesson.ttlDays ?? DEFAULT_TTL_DAYS[lesson.status] ?? 90);
    const anchor = lesson.lastConfirmedAt ?? lesson.createdAt;
    if (Number(now) - Number(anchor) > ttl * DAY_MS) {
      lesson.status = 'expired';
      lesson.expiredReason = `ttl-${ttl}d`;
    }
  }
  const lessons = [...byId.values()];
  return { lessons, anomalies, summary: summarize(lessons) };
}

export function summarize(lessons) {
  const list = Array.isArray(lessons) ? lessons : [];
  const counts = Object.fromEntries(LESSON_STATUSES.map((s) => [s, 0]));
  for (const l of list) counts[l.status] = (counts[l.status] || 0) + 1;
  const population = list.length - counts.expired;
  return {
    total: list.length, ...counts,
    verifiedRatio: population > 0 ? round3(counts.verified / population) : 0,
  };
}

const normalizeRuleKey = (rule) => String(rule ?? '').toLowerCase().replace(/\s+/g, '').replace(/[。；;，,：:！!？?]/g, '');

function parseTimeMs(value) {
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : null;
}

/** 旧 lessons.jsonl → 候选（只读转换，不改旧账）。 */
export function candidatesFromLegacyLessons(rows, { now = Date.now() } = {}) {
  const out = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? '').trim();
    if (!text) { skipped += 1; continue; }
    try {
      out.push(buildCandidate({
        rule: clip(text, LIMITS.rule),
        evidenceIds: [`legacy-lesson:${String(row.id ?? row.at ?? out.length)}`],
        scope: ['legacy'],
        source: 'legacy-lessons',
        confidence: Number(row.confidence) || 0.3,
        legacyId: row.id ? `lesson:${row.id}` : '',
        at: parseTimeMs(row.at) ?? now,
      }));
    } catch { skipped += 1; }
  }
  return { candidates: out, skipped };
}

/** 旧 cognition.jsonl → 候选（"关于自己的认知"，保留原 id 作为 legacyId）。 */
export function candidatesFromCognition(rows, { now = Date.now() } = {}) {
  const out = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = String(row?.text ?? '').trim() || [row?.concept, row?.gist].filter(Boolean).join('：').trim();
    if (!text) { skipped += 1; continue; }
    try {
      out.push(buildCandidate({
        rule: clip(text, LIMITS.rule),
        evidenceIds: [`legacy-cognition:${String(row.id ?? row.at ?? out.length)}`],
        scope: Array.isArray(row.tags) && row.tags.length ? row.tags.map(String).slice(0, 8) : ['legacy'],
        source: 'legacy-cognition',
        confidence: Number(row.confidence) || 0.3,
        legacyId: row.id ? `cognition:${row.id}` : '',
        at: parseTimeMs(row.at) || parseTimeMs(row.validAt) || now,
      }));
    } catch { skipped += 1; }
  }
  return { candidates: out, skipped };
}

/** 旧 insights.jsonl → 低置信候选；反思批汇总行不是教训，跳过。 */
export function candidatesFromInsights(rows, { now = Date.now() } = {}) {
  const out = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const kind = String(row?.kind ?? '');
    const text = String(row?.text ?? '').trim();
    if (!text || kind === 'reflection' || text.startsWith('反思批')) { skipped += 1; continue; }
    try {
      out.push(buildCandidate({
        rule: clip(text, LIMITS.rule),
        evidenceIds: [`legacy-insight:${String(row.id ?? row.at ?? out.length)}`],
        scope: ['legacy'],
        source: 'legacy-insights',
        confidence: 0.25,
        legacyId: row.id ? `insight:${row.id}` : '',
        at: parseTimeMs(row.at) ?? now,
      }));
    } catch { skipped += 1; }
  }
  return { candidates: out, skipped };
}

/** 三源合并转换（纯函数；不读盘）。 */
export function legacyCandidates({ lessons = [], cognition = [], insights = [] } = {}, { now = Date.now() } = {}) {
  const a = candidatesFromLegacyLessons(lessons, { now });
  const b = candidatesFromCognition(cognition, { now });
  const c = candidatesFromInsights(insights, { now });
  return {
    candidates: [...a.candidates, ...b.candidates, ...c.candidates],
    bySource: { lessons: a.candidates.length, cognition: b.candidates.length, insights: c.candidates.length },
    skipped: a.skipped + b.skipped + c.skipped,
  };
}

/** 与已有账本事件去重（legacyId 优先，其次 rule 归一化文本）；返回真正需要追加的候选。 */
export function mergeLegacyCandidates(existingEvents, candidates) {
  const seenLegacy = new Set();
  const seenRules = new Set();
  for (const row of Array.isArray(existingEvents) ? existingEvents : []) {
    if (!row || row.kind !== 'candidate') continue;
    if (row.legacyId) seenLegacy.add(String(row.legacyId));
    seenRules.add(normalizeRuleKey(row.rule));
  }
  const fresh = [];
  const duplicates = [];
  for (const cand of Array.isArray(candidates) ? candidates : []) {
    const key = normalizeRuleKey(cand.rule);
    if ((cand.legacyId && seenLegacy.has(String(cand.legacyId))) || seenRules.has(key)) {
      duplicates.push(cand);
      continue;
    }
    if (cand.legacyId) seenLegacy.add(String(cand.legacyId));
    seenRules.add(key);
    fresh.push(cand);
  }
  return { fresh, duplicates };
}

/** 按 legacy 来源 id 找当前折叠后的教训（供旧工具通道同步新账）。 */
export function findLessonByLegacyId(events, legacyId, { now = Date.now(), ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const wanted = String(legacyId ?? '');
  if (!wanted) return null;
  const folded = foldLessons(events, { now, ttlDays });
  return folded.lessons.find((l) => l.legacyId === wanted) || null;
}

/**
 * 旧通道（lesson_vote）→ 新账 verdict 事件：只允许对"仍可表决"的候选/生效/降级教训投票。
 * expired/contradicted 不再接受投票（返回原因，由调用方言明）。
 */
export function verdictEventForLegacy(events, legacyId, { polarity = 'pos', evidenceId = '', reason = '', at = Date.now(), now = at } = {}) {
  const lesson = findLessonByLegacyId(events, legacyId, { now });
  if (!lesson) return { ok: false, reason: 'no-candidate' };
  if (lesson.status === 'expired') return { ok: false, reason: 'expired', lessonId: lesson.id };
  if (lesson.status === 'contradicted') return { ok: false, reason: 'contradicted', lessonId: lesson.id };
  if (polarity !== 'pos' && polarity !== 'neg') return { ok: false, reason: 'bad-polarity', lessonId: lesson.id };
  return { ok: true, lessonId: lesson.id, event: buildVerdict(lesson.id, polarity, { evidenceId, reason, at }) };
}

/** digest：折叠 + 列出"按 TTL 该过期"的条目（供周报/显式过期事件）。 */
export function digestLessons(events, { now = Date.now(), ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const folded = foldLessons(events, { now, ttlDays });
  return {
    ...folded,
    expiring: folded.lessons.filter((l) => l.status === 'expired' && String(l.expiredReason || '').startsWith('ttl-')),
  };
}

export function parseLedger(text) {
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

/** 只追加；writer 白名单：capture / verify / digest / kernel-shadow。 */
export function createLessonsLedger({ file, now = () => Date.now(), append = appendJsonl, readFile } = {}) {
  if (!file) throw new LessonsLedgerError('lessons ledger file 不能为空');
  const target = path.resolve(String(file));
  const nowFn = typeof now === 'function' ? now : () => now;
  const appendFn = typeof append === 'function' ? append : appendJsonl;
  const fsRead = typeof readFile === 'function' ? readFile : (f) => {
    // eslint-disable-next-line global-require
    return import('node:fs').then(({ default: fs }) => {
      try { return fs.readFileSync(f, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
    });
  };
  const allowed = new Set(['capture', 'verify', 'digest', 'kernel-shadow']);

  async function appendEvent(event, { writer = 'capture' } = {}) {
    if (!allowed.has(writer)) throw new LessonsLedgerError('writer 不在白名单', 'writer-forbidden');
    const result = appendFn(target, event, { source: 'lessons-ledger', fsync: true });
    if (!result || result.ok !== true) throw new LessonsLedgerError(`账本写入失败：${result?.error || 'unknown'}`, 'write-failed');
    return event;
  }

  async function readAll() {
    const text = await fsRead(target);
    return parseLedger(text);
  }

  async function state({ ttl } = {}) {
    const { rows, corrupt } = await readAll();
    return { ...foldLessons(rows, { now: nowFn(), ttlDays: ttl || DEFAULT_TTL_DAYS }), corrupt };
  }

  return { v: LESSONS_LEDGER_VERSION, file: target, appendEvent, readAll, state };
}
