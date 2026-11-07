import test from 'node:test';
import assert from 'node:assert/strict';

import { planExpression } from '../src/domain/mind/expression-policy.mjs';

test('默认：私聊一条、中性语气、有界', () => {
  const p = planExpression({});
  assert.equal(p.scene, 'private');
  assert.equal(p.messages, 1);
  assert.ok(p.targetChars >= 20 && p.targetChars <= 120);
  assert.ok(p.delayMs >= 500 && p.delayMs <= 8000);
  assert.equal(p.tone, 'neutral');
});

test('压力/火气高：话更短、延迟更长、语气严肃', () => {
  const base = planExpression({});
  const hot = planExpression({ self: { stress: 0.8, affect: { anger: 0.7 } } });
  assert.ok(hot.targetChars < base.targetChars);
  assert.ok(hot.delayMs > base.delayMs);
  assert.equal(hot.tone, 'serious');
});

test('亲近：语气放软、可带表情', () => {
  const p = planExpression({ self: { affection: 0.6 } });
  assert.equal(p.tone, 'warm');
  assert.equal(p.emoji, true);
  const bond = planExpression({ belief: { affinity: 0.8 } });
  assert.equal(bond.tone, 'warm');
});

test('群聊：一条说完；精力低更短', () => {
  const g = planExpression({ scene: 'group' });
  assert.equal(g.messages, 1);
  const tired = planExpression({ self: { energy: 0.1 } });
  assert.ok(tired.targetChars <= 35);
  assert.ok(tired.delayMs >= 2000);
});

test('确定性：同输入同结果', () => {
  const input = { self: { stress: 0.7 }, belief: { affinity: 0.8 }, scene: 'private' };
  assert.deepEqual(planExpression(input), planExpression(input));
});
