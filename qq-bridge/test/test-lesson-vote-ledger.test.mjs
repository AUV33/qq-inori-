// test-lesson-vote-ledger.test.mjs · 宪章 S5c：旧 lesson_vote / lesson_write 必须同步进新教训账。
// 纯规则在这里测；memory-mcp 的接线用源码契约锁住（它是独立进程）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCandidate, buildVerdict, buildContradiction, foldLessons,
  findLessonByLegacyId, verdictEventForLegacy,
} from '../src/domain/mind/lessons-ledger.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const legacyCandidate = (over = {}) => buildCandidate({
  rule: '被抓到在偷偷画自己的画，不否认就对了',
  evidenceIds: ['legacy-lesson:lf8a3eb1b'],
  scope: ['legacy'],
  source: 'legacy-lessons',
  confidence: 0.9,
  legacyId: 'lesson:lf8a3eb1b',
  at: T,
  ...over,
});

test('legacy 映射：按 legacyId 找到候选；投票事件能被折叠成 active', () => {
  const c = legacyCandidate();
  const found = findLessonByLegacyId([c], 'lesson:lf8a3eb1b', { now: T });
  assert.equal(found.id, c.id);
  const plan = verdictEventForLegacy([c], 'lesson:lf8a3eb1b', { polarity: 'pos', evidenceId: 'lesson-vote:lf8a3eb1b', at: T + 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.lessonId, c.id);
  const folded = foldLessons([c, plan.event], { now: T + 1 });
  assert.equal(folded.lessons[0].status, 'active');
  assert.equal(folded.lessons[0].pos, 1);
});

test('拒绝不可表决的状态：unknown / expired / contradicted / bad polarity', () => {
  const c = legacyCandidate();
  assert.equal(verdictEventForLegacy([], 'lesson:nope', {}).reason, 'no-candidate');
  assert.equal(verdictEventForLegacy([c], 'lesson:lf8a3eb1b', { now: T + 61 * 86400000 }).reason, 'expired');
  const contradicted = [c, buildContradiction(c.id, { reason: '反例', at: T + 1 })];
  assert.equal(verdictEventForLegacy(contradicted, 'lesson:lf8a3eb1b', { now: T + 1 }).reason, 'contradicted');
  assert.equal(verdictEventForLegacy([c], 'lesson:lf8a3eb1b', { polarity: 'up' }).reason, 'bad-polarity');
});

test('memory-mcp：lesson_write 建候选、lesson_vote 写 verdict，且失败不挡旧通道', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', '..', 'ai-companion-kit/packages/memory-mcp/src/memory-mcp.js'), 'utf8');
  assert.match(src, /LESSONS_LEDGER_FILE/);
  assert.match(src, /lessonsLedger\(\)/);
  assert.match(src, /verdictEventForLegacy/);
  assert.match(src, /buildCandidate\(/);
  assert.match(src, /legacyId/);
  assert.match(src, /lesson-vote:/);
  assert.match(src, /新账失败不挡旧通道/);
});

test('同步事件与旧账 id 的约定：lesson:<旧id>，证据可追溯', () => {
  const c = legacyCandidate();
  assert.equal(c.legacyId, 'lesson:lf8a3eb1b');
  const verdict = buildVerdict(c.id, 'neg', { evidenceId: 'lesson-vote:lf8a3eb1b', at: T + 1 });
  const folded = foldLessons([c, verdict], { now: T + 1 });
  assert.equal(folded.lessons[0].status, 'demoted');
  assert.ok(folded.lessons[0].evidenceIds.includes('lesson-vote:lf8a3eb1b'));
});
