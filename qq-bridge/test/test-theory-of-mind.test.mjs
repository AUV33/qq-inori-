// test-theory-of-mind.test.mjs · §5.13：感知之外再读“他想要什么”，且保留不确定性。
import test from 'node:test';
import assert from 'node:assert/strict';

import { inferIntent, renderIntentLine } from '../src/domain/conversation/theory-of-mind.mjs';
import { chooseMove } from '../src/domain/conversation/move-selector.mjs';
import { planResponse } from '../src/domain/mind/expression-policy.mjs';

const percept = (over = {}) => ({ addressee: 'her', speechAct: 'statement', ambiguity: 0.2, ...over });

test('意图：抱怨/提问/请求/玩笑/退开/陈述各有候选', () => {
  assert.equal(inferIntent({ perception: percept({ speechAct: 'complaint' }), bond: { affinity: 0.7 } }).intent, 'seek_comfort');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'complaint' }), bond: { affinity: 0.3 } }).intent, 'seek_comfort');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'question' }), bond: {} }).intent, 'ask_help');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'request' }), bond: {} }).intent, 'ask_help');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'withdraw' }), bond: {} }).intent, 'withdraw');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'tease' }), bond: { affinity: 0.7 } }).intent, 'play');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'tease' }), bond: { affinity: 0.2 } }).intent, 'test_boundary');
  assert.equal(inferIntent({ perception: percept({ speechAct: 'statement', addressee: 'other' }), bond: {} }).intent, 'inform');
});

test('不确定性：候选越接近，uncertainty 越高；无感知 low confidence', () => {
  const ambiguous = inferIntent({ perception: percept({ speechAct: 'complaint' }), bond: { affinity: 0.45 } });
  assert.ok(ambiguous.candidates.length >= 2);
  assert.ok(ambiguous.uncertainty > 0);
  const none = inferIntent({ perception: null, bond: {} });
  assert.equal(none.intent, 'unknown');
  assert.ok(none.confidence <= 0.3);
  assert.equal(renderIntentLine(none), '');
  assert.match(renderIntentLine(ambiguous), /置信/);
});

test('动作层：试探边界且关系不近 → 极简；不把试探当玩笑', () => {
  const move = chooseMove({ perception: percept({ speechAct: 'tease' }), self: {}, bond: { affinity: 0.3 }, scene: 'private' });
  assert.equal(move.move, 'minimal');
  assert.ok(move.reasons.some((x) => x.includes('试探边界')));
});

test('计划层：返回 tom 与 intentLine，move 仍自洽', () => {
  const plan = planResponse({ perception: percept({ speechAct: 'complaint' }), self: { energy: 0.7 }, bond: { affinity: 0.7 }, scene: 'private' });
  assert.equal(plan.tom.intent, 'seek_comfort');
  assert.equal(plan.move.move, 'comfort');
  assert.match(plan.intentLine, /安慰/);
});
