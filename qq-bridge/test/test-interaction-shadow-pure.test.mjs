// test-interaction-shadow-pure.test.mjs · S8e/S8f：影子建议行本身可单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShadowRow, keyHashOf } from '../src/domain/conversation/interaction-shadow.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const msg = (over = {}) => ({ sender: 'u1', userId: '1', text: '闲聊', time: T - 60000, isSelf: false, ...over });
const percept = (over = {}) => ({ addressee: 'her', speechAct: 'statement', ...over });

test('影子行：抱怨+关系近 → comfort；keyHash 不含原串', () => {
  const row = buildShadowRow({
    keyHash: keyHashOf('private:10001'), perception: percept({ speechAct: 'complaint' }),
    self: { energy: 0.7 }, bond: { affinity: 0.7 }, scene: 'private', recentMessages: [], now: T,
  });
  assert.equal(row.intent, 'seek_comfort');
  assert.equal(row.move, 'comfort');
  assert.equal(row.keyHash, keyHashOf('private:10001'));
  assert.equal(JSON.stringify(row).includes('10001'), false);
  assert.equal(buildShadowRow({ perception: null }), null);
});

test('影子行：群气氛紧 → 没点她时 silence；预算 min-gap 给直接提问让路', () => {
  const tense = buildShadowRow({
    perception: percept({ addressee: 'broadcast' }), self: {}, bond: {}, scene: 'group',
    recentMessages: Array.from({ length: 6 }, (_, i) => msg({ userId: String(i % 2), tone: 'neg', time: T - i * 1000 })),
    now: T,
  });
  assert.equal(tense.group.label, 'tense');
  assert.equal(tense.move, 'silence');

  const direct = buildShadowRow({
    perception: percept({ addressee: 'her', speechAct: 'question' }), self: {}, bond: {}, scene: 'private',
    recentMessages: [msg({ isSelf: true, time: T - 5000 })], now: T,
  });
  assert.equal(direct.budget.allowed, false);
  assert.equal(direct.budget.reason, 'min-gap');
  assert.equal(direct.move, 'reply', '直接提问可以越过 min-gap');

  const cap = buildShadowRow({
    perception: percept({ addressee: 'her', speechAct: 'question' }), self: {}, bond: {}, scene: 'private',
    recentMessages: Array.from({ length: 12 }, (_, i) => msg({ isSelf: true, time: T - 30000 - i * 1000 })), now: T,
  });
  assert.equal(cap.budget.reason, 'hourly-cap');
  assert.equal(cap.move, 'silence');
});
