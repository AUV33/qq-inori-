// test-group-health.test.mjs · 宪章 §5.14/§5.15：群气氛、互动预算、退场，接到动作层。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGroupState, evaluateInteractionBudget, shouldWithdraw, renderGroupHealthLine,
} from '../src/domain/conversation/group-health.mjs';
import { chooseMove } from '../src/domain/conversation/move-selector.mjs';
import { planResponse } from '../src/domain/mind/expression-policy.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const msg = (over = {}) => ({ sender: 'u1', userId: '1', text: '闲聊', time: T - 60000, ...over });
const percept = (over = {}) => ({ addressee: 'broadcast', speechAct: 'statement', ambiguity: 0.2, ...over });

test('群状态：空群 unknown；活跃 warm；负性高 tense；久未说话 cold', () => {
  assert.equal(evaluateGroupState({ messages: [], now: T }).label, 'unknown');
  const warm = evaluateGroupState({ messages: Array.from({ length: 10 }, (_, i) => msg({ sender: `u${i % 4}`, userId: String(i % 4), time: T - i * 1000 })), now: T, windowMs: 30 * 60000 });
  assert.equal(warm.label, 'warm');
  const tense = evaluateGroupState({ messages: Array.from({ length: 6 }, (_, i) => msg({ sender: `u${i % 2}`, userId: String(i % 2), tone: 'neg', time: T - i * 1000 })), now: T });
  assert.equal(tense.label, 'tense');
  const old = evaluateGroupState({ messages: [msg({ time: T - 48 * 3600000 })], now: T });
  assert.equal(old.label, 'cold');
  assert.ok(warm.herShare >= 0 && warm.herShare <= 1);
});

test('互动预算：最小间隔未到 / 每小时上限 / 允许', () => {
  const gap = evaluateInteractionBudget({ spokeAt: [T - 5000], now: T, minGapMs: 20000 });
  assert.equal(gap.allowed, false);
  assert.equal(gap.reason, 'min-gap');
  assert.ok(gap.waitMs > 0);

  const cap = evaluateInteractionBudget({ spokeAt: Array.from({ length: 12 }, (_, i) => T - 30000 - i * 1000), now: T, maxPerHour: 12 });
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'hourly-cap');

  const ok = evaluateInteractionBudget({ spokeAt: [T - 60000], now: T });
  assert.equal(ok.allowed, true);
});

test('退场：没人接 / 独白 / 正常留下', () => {
  const silent = shouldWithdraw({ herMessages: [msg({ time: T - 11 * 60000 })], othersAfter: 0, now: T });
  assert.equal(silent.withdraw, true);
  assert.equal(silent.reason, 'no-response');
  const monologue = shouldWithdraw({ herMessages: [msg({ time: T - 1000 }), msg({ time: T - 2000 }), msg({ time: T - 3000 })], othersAfter: 0, now: T });
  assert.equal(monologue.withdraw, true);
  assert.equal(monologue.reason, 'monologue');
  const stay = shouldWithdraw({ herMessages: [msg({ time: T - 60000 })], othersAfter: 2, now: T });
  assert.equal(stay.withdraw, false);
});

test('动作层：预算不允许 → 沉默；气氛紧且没点她 → 沉默；点她仍回', () => {
  const blocked = chooseMove({ perception: percept({ addressee: 'her', speechAct: 'question' }), self: {}, bond: {}, scene: 'group', budget: { allowed: false, reason: 'hourly-cap' } });
  assert.equal(blocked.move, 'silence');
  assert.ok(blocked.reasons.some((r) => r.includes('互动预算')));

  const tense = chooseMove({ perception: percept(), self: {}, bond: {}, scene: 'group', groupHealth: { label: 'tense' } });
  assert.equal(tense.move, 'silence');

  const tenseHer = chooseMove({ perception: percept({ addressee: 'her', speechAct: 'question' }), self: {}, bond: {}, scene: 'group', groupHealth: { label: 'tense' } });
  assert.equal(tenseHer.move, 'reply', '点她时不能拿气氛当借口');

  // 最小间隔给“直接问她”让路；每小时上限仍是硬配额。
  const direct = chooseMove({ perception: percept({ addressee: 'her', speechAct: 'question' }), self: {}, bond: {}, scene: 'private', budget: { allowed: false, reason: 'min-gap' } });
  assert.equal(direct.move, 'reply');
  const cap = chooseMove({ perception: percept({ addressee: 'her', speechAct: 'question' }), self: {}, bond: {}, scene: 'private', budget: { allowed: false, reason: 'hourly-cap' } });
  assert.equal(cap.move, 'silence');

  const plan = planResponse({ perception: percept(), self: {}, bond: {}, scene: 'group', budget: { allowed: true }, groupHealth: { label: 'warm' } });
  assert.ok(plan.move);
});

test('渲染：空群为空串，有名有数不带命令', () => {
  assert.equal(renderGroupHealthLine({ total: 0 }), '');
  const line = renderGroupHealthLine({ label: 'warm', total: 8, participants: 3, herShare: 0.25, negativeRate: 0 });
  assert.match(line, /群里聊得热乎/);
  assert.match(line, /8 条/);
  assert.equal(/应该|必须/.test(line), false);
});
