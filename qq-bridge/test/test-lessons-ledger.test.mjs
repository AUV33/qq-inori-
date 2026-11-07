// test-lessons-ledger.test.mjs · 宪章 §5.4 / C2/C3：教训必须可回答
// "谁写的、证据是什么、被验证几次、为什么还在/已淘汰"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderLessonsLedgerLine } from '../src/domain/mind/mind-blocks.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';

import {
  LESSON_STATUSES, DEFAULT_TTL_DAYS, LIMITS,
  buildCandidate, buildVerdict, buildContradiction, buildExpiry,
  foldLessons, summarize, parseLedger, createLessonsLedger, LessonsLedgerError,
  legacyCandidates, mergeLegacyCandidates, digestLessons,
} from '../src/domain/mind/lessons-ledger.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const DAY = 86400000;
const cand = (over = {}) => buildCandidate({ rule: '主动找人没被接住时，先缓一缓', evidenceIds: ['ev_20261105_aaaaaa'], at: T, ...over });

test('candidate 必须有证据；坏 rule/坏 id 在构造期拒绝', () => {
  assert.equal(cand().kind, 'candidate');
  assert.equal(cand().status, undefined, 'candidate 记录本身不带状态，状态由 fold 得出');
  assert.throws(() => buildCandidate({ rule: 'x', evidenceIds: [], at: T }), /evidence_id/);
  assert.throws(() => buildCandidate({ rule: '', evidenceIds: ['e'], at: T }), /rule 不能为空/);
  assert.throws(() => buildCandidate({ rule: 'x'.repeat(LIMITS.rule + 1), evidenceIds: ['e'], at: T }), /不能超过/);
  assert.throws(() => buildCandidate({ id: 'bad', rule: 'x', evidenceIds: ['e'], at: T }), /id 非法/);
});

test('状态机：candidate → active → verified；一次证伪降级，连续两次淘汰', () => {
  const c = cand();
  let s = foldLessons([c], { now: T });
  assert.equal(s.lessons[0].status, 'candidate');
  s = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 })], { now: T + 1 });
  assert.equal(s.lessons[0].status, 'active');
  s = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 }), buildVerdict(c.id, 'pos', { at: T + 2 })], { now: T + 2 });
  assert.equal(s.lessons[0].status, 'verified');
  assert.ok(s.lessons[0].confidence >= 0.8);

  const demoted = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 }), buildVerdict(c.id, 'neg', { at: T + 2 })], { now: T + 2 });
  assert.equal(demoted.lessons[0].status, 'demoted');
  const expired = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 }), buildVerdict(c.id, 'neg', { at: T + 2 }), buildVerdict(c.id, 'neg', { at: T + 3 })], { now: T + 3 });
  assert.equal(expired.lessons[0].status, 'expired');
  assert.match(expired.lessons[0].expiredReason, /consecutive/);
});

test('TTL：candidate 60 天 / active 90 天 / verified 180 天过期（视图，不写历史）', () => {
  const c = cand();
  assert.equal(foldLessons([c], { now: T + 61 * DAY }).lessons[0].status, 'expired');
  const active = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 })], { now: T + 91 * DAY });
  assert.equal(active.lessons[0].status, 'expired');
  const verified = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 }), buildVerdict(c.id, 'pos', { at: T + 2 })], { now: T + 181 * DAY });
  assert.equal(verified.lessons[0].status, 'expired');
  assert.equal(DEFAULT_TTL_DAYS.active, 90);
});

test('冲突：标 contradicted 等人裁决；expired 不接受后续 verdict（防复活）', () => {
  const c = cand();
  const s = foldLessons([c, buildVerdict(c.id, 'pos', { at: T + 1 }), buildContradiction(c.id, { by: 'ls_20261105_bbbbbb', reason: '反例', at: T + 2 })], { now: T + 2 });
  assert.equal(s.lessons[0].status, 'contradicted');
  assert.match(s.lessons[0].contradictedReason, /反例/);

  const expired = foldLessons([c, buildExpiry(c.id, { at: T + 1 }), buildVerdict(c.id, 'pos', { at: T + 2 })], { now: T + 2 });
  assert.equal(expired.lessons[0].status, 'expired');
  assert.ok(expired.anomalies.some((a) => a.reason === 'already-expired'));
});

test('坏事件只进 anomalies，不伪造条目；重复 candidate / 未知 verdict 被隔离', () => {
  const c = cand();
  const s = foldLessons([
    c, c,
    { kind: 'verdict', id: 'ls_20261105_ffffff', polarity: 'pos', at: T },
    { kind: 'nonsense', id: c.id, at: T },
    { kind: 'candidate', id: 'bad', rule: 'x', evidenceIds: ['e'], at: T },
  ], { now: T });
  assert.equal(s.lessons.length, 1);
  assert.ok(s.anomalies.some((a) => a.reason === 'duplicate-candidate'));
  assert.ok(s.anomalies.some((a) => a.reason === 'unknown-id'));
  assert.ok(s.anomalies.some((a) => a.reason === 'bad-candidate'));
});

test('fold 幂等：同一串事件重复折叠结果一致；summary 可算验证率', () => {
  const a = cand();
  const b = cand({ rule: '别熬夜', evidenceIds: ['ev_20261105_bbbbbb'] });
  const events = [a, b, buildVerdict(a.id, 'pos', { at: T + 1 }), buildVerdict(a.id, 'pos', { at: T + 2 })];
  const one = foldLessons(events, { now: T + 2 });
  const two = foldLessons(events, { now: T + 2 });
  assert.deepEqual(one, two);
  assert.equal(one.summary.verified, 1);
  assert.equal(one.summary.total, 2);
  assert.ok(one.summary.verifiedRatio > 0 && one.summary.verifiedRatio <= 1);
  assert.deepEqual(Object.keys(summarize([])).sort(), ['active', 'candidate', 'contradicted', 'demoted', 'expired', 'total', 'verified', 'verifiedRatio'].sort());
});

test('存储：append 白名单、读回 fold、坏行只进 corrupt；writer 不在白名单拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-ledger-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const file = path.join(root, 'lessons-ledger.jsonl');
    const store = createLessonsLedger({ file, now: () => T });
    const c = cand();
    await store.appendEvent(c, { writer: 'capture' });
    await store.appendEvent(buildVerdict(c.id, 'pos', { at: T + 1 }), { writer: 'verify' });
    await assert.rejects(() => store.appendEvent(c, { writer: 'owner' }), /白名单/);

    fs.appendFileSync(file, 'bad-json\n', 'utf8');
    const s = await store.state();
    assert.equal(s.lessons.length, 1);
    assert.equal(s.lessons[0].status, 'active');
    assert.equal(s.corrupt.length, 1);
    const parsed = await store.readAll();
    assert.equal(parsed.rows.length, 2);
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});

test('S5b 迁移：旧 lessons/cognition/insights → 候选；空条与反思批跳过；保留 legacyId/证据', () => {
  const converted = legacyCandidates({
    lessons: [
      { id: 'l1', text: '经验一', confidence: 0.9, at: '2026-10-28T13:58:21.063Z' },
      { text: '   ' },
    ],
    cognition: [
      { id: 'c1', text: '认知一', confidence: 0.5, tags: ['关系'], at: '2026-10-26T17:50:54.662Z' },
    ],
    insights: [
      { kind: 'reflection', text: '反思批（2026-10-27）：经验 +0' },
      { id: 'i1', kind: 'insight', text: '洞见一', at: '2026-10-27T00:00:00.000Z' },
    ],
  }, { now: T });
  assert.equal(converted.candidates.length, 3);
  assert.equal(converted.skipped, 2);
  assert.deepEqual(converted.bySource, { lessons: 1, cognition: 1, insights: 1 });
  const byLegacy = Object.fromEntries(converted.candidates.map((c) => [c.legacyId, c]));
  assert.ok(byLegacy['lesson:l1']);
  assert.match(byLegacy['lesson:l1'].evidenceIds[0], /^legacy-lesson:l1$/);
  assert.equal(byLegacy['lesson:l1'].source, 'legacy-lessons');
  assert.ok(byLegacy['cognition:c1']);
  assert.deepEqual(byLegacy['cognition:c1'].scope, ['关系']);
  assert.ok(byLegacy['insight:i1']);
  assert.equal(byLegacy['insight:i1'].confidence, 0.25);
});

test('S5b 去重：legacyId 与归一化 rule 任一命中都跳过；第二次迁移 fresh=0', () => {
  const converted = legacyCandidates({
    lessons: [{ id: 'l1', text: '别熬夜', at: '2026-10-28T00:00:00.000Z' }],
    cognition: [{ id: 'c1', text: '别 熬夜。', at: '2026-10-26T00:00:00.000Z' }],
  }, { now: T });
  const first = mergeLegacyCandidates([], converted.candidates);
  assert.equal(first.fresh.length, 1, '两条归一化后同文，只留一条');
  const second = mergeLegacyCandidates([converted.candidates[0]], converted.candidates);
  assert.equal(second.fresh.length, 0, '再次迁移不得重复追加');
  assert.equal(second.duplicates.length, 2);
});

test('S5b digest：TTL 过期单列（expiring），不修改历史事件', () => {
  const c = cand();
  const digest = digestLessons([c], { now: T + 61 * DAY });
  assert.equal(digest.lessons[0].status, 'expired');
  assert.equal(digest.expiring.length, 1);
  assert.match(digest.expiring[0].expiredReason, /ttl-/);
  const fresh = digestLessons([c], { now: T + 1 });
  assert.equal(fresh.expiring.length, 0);
});

test('S5b 脚本：默认 dry-run、--apply 才写、只读旧账', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const script = fs.readFileSync(path.join(HERE, '..', 'scripts/lessons-migrate.mjs'), 'utf8');
  assert.match(script, /--apply/);
  assert.match(script, /mergeLegacyCandidates/);
  assert.match(script, /lessonsLedger/);
  assert.match(script, /writer: 'digest'/);
});

test('消费端：state-hub 读得到教训账；渲染只显示验证/生效，空账不出现', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-view-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const store = createLessonsLedger({ file: path.join(root, 'lessons-ledger.jsonl'), now: () => T });
    const a = cand();
    const b = cand({ rule: '别熬夜查资料', evidenceIds: ['ev_20261105_bbbbbb'] });
    await store.appendEvent(a, { writer: 'capture' });
    await store.appendEvent(a && buildVerdict(a.id, 'pos', { at: T + 1 }), { writer: 'verify' });
    await store.appendEvent(buildVerdict(a.id, 'pos', { at: T + 2 }), { writer: 'verify' });
    await store.appendEvent(b, { writer: 'capture' });

    const hub = createStateHub({ root, now: () => T + 2, log: () => {} });
    hub.load();
    const view = hub.getLessonsLedger();
    assert.equal(view.summary.total, 2);
    assert.equal(view.summary.verified, 1);
    assert.equal(view.summary.candidate, 1);
    assert.equal(view.lessons[0].status, 'verified');
    assert.equal(hub.status().lessonsLedger.total, 2);

    const text = renderLessonsLedgerLine(view);
    assert.match(text, /你的经验账：验证 1/);
    assert.match(text, /✅ 主动找人/);
    assert.equal(renderLessonsLedgerLine(null), '');
    assert.equal(renderLessonsLedgerLine({ lessons: [], summary: {} }), '');
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});

test('接线：内核反思→教训账→state-hub→唤醒 prompt 四段都在', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');
  const app = read('src/app.mjs');
  assert.match(app, /createLessonsLedger/);
  assert.match(app, /lesson\.formed/);
  assert.match(app, /getMindLessons/);
  const service = read('src/domain/conversation/wake-prompt-service.mjs');
  assert.match(service, /renderLessonsLedgerLine/);
  assert.match(service, /getMindLessons/);
  const prompt = read('src/domain/persona/wake-prompt.mjs');
  assert.match(prompt, /mindLessonsLine/);
  const hub = read('src/domain/mind/state-hub.mjs');
  assert.match(hub, /getLessonsLedger/);
});

test('契约：状态集合与默认 TTL 是稳定契约', () => {
  assert.deepEqual([...LESSON_STATUSES], ['candidate', 'active', 'verified', 'demoted', 'expired', 'contradicted']);
  assert.deepEqual({ ...DEFAULT_TTL_DAYS }, { candidate: 60, active: 90, verified: 180, demoted: 14 });
  assert.equal(typeof LessonsLedgerError, 'function');
  assert.deepEqual(parseLedger('{"kind":"candidate","id":"x"}\nbad\n').corrupt, [{ line: 2, reason: 'bad-json' }]);
});
