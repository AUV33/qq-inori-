// test-move-selector.test.mjs · 宪章 §5.16：先选动作（沉默/回应/安慰/接梗/避开），再说怎么发。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chooseMove, describeMove, MOVES } from '../src/domain/conversation/move-selector.mjs';
import { planResponse } from '../src/domain/mind/expression-policy.mjs';

const percept = (over = {}) => ({ addressee: 'her', speechAct: 'statement', ambiguity: 0.2, candidates: [], ...over });
const self = (over = {}) => ({ energy: 0.7, stress: 0.2, socialHunger: 0.4, ...over });
const bond = (over = {}) => ({ affinity: 0.5, trust: 0.5, taboo: [], ...over });

test('生理/场合底线：没精力沉默，压力高极简，别人说话不插', () => {
  assert.equal(chooseMove({ perception: percept(), self: self({ energy: 0.1 }), bond: bond() }).move, 'silence');
  assert.equal(chooseMove({ perception: percept(), self: self({ stress: 0.9 }), bond: bond() }).move, 'minimal');
  assert.equal(chooseMove({ perception: percept({ addressee: 'other' }), self: self(), bond: bond() }).move, 'silence');
  assert.equal(chooseMove({ perception: percept({ speechAct: 'withdraw' }), self: self(), bond: bond() }).move, 'silence');
});

test('禁忌：碰到就不硬接；哪怕对方是主人也避开', () => {
  const b = bond({ taboo: [{ topic: '体重' }] });
  const m = chooseMove({ perception: percept(), self: self(), bond: b, text: '你最近体重多少' });
  assert.equal(m.move, 'deflect');
  assert.ok(m.reasons.some((x) => x.includes('禁忌')));
  assert.equal(chooseMove({ perception: percept(), self: self(), bond: bond(), text: '今天吃什么' }).move !== 'deflect', true);
});

test('情绪动作：抱怨先接情绪（关系近）/不擅自安慰（关系一般）；玩笑看亲疏', () => {
  assert.equal(chooseMove({ perception: percept({ speechAct: 'complaint' }), self: self(), bond: bond({ affinity: 0.7 }) }).move, 'comfort');
  assert.equal(chooseMove({ perception: percept({ speechAct: 'complaint' }), self: self(), bond: bond({ affinity: 0.3 }) }).move, 'minimal');
  assert.equal(chooseMove({ perception: percept({ speechAct: 'tease' }), self: self(), bond: bond({ affinity: 0.6 }) }).move, 'tease');
  assert.equal(chooseMove({ perception: percept({ speechAct: 'tease' }), self: self(), bond: bond({ affinity: 0.2 }) }).move, 'minimal');
});

test('提问：问她就回；群里泛问看社交饥饿；问别人不抢答', () => {
  const her = chooseMove({ perception: percept({ speechAct: 'question', addressee: 'her' }), self: self(), bond: bond(), scene: 'group' });
  assert.equal(her.move, 'reply');
  assert.ok(her.explicitness > 0.5);

  const hungry = chooseMove({ perception: percept({ speechAct: 'question', addressee: 'broadcast' }), self: self({ socialHunger: 0.7 }), bond: bond(), scene: 'group' });
  assert.equal(hungry.move, 'participate');

  const quiet = chooseMove({ perception: percept({ speechAct: 'question', addressee: 'broadcast' }), self: self({ socialHunger: 0.2 }), bond: bond(), scene: 'group' });
  assert.equal(quiet.move, 'silence');

  const other = chooseMove({ perception: percept({ speechAct: 'question', addressee: 'other' }), self: self(), bond: bond(), scene: 'group' });
  assert.equal(other.move, 'silence');
});

test('群里泛说：社交饥饿高才参与；私聊主人默认回应', () => {
  assert.equal(chooseMove({ perception: percept({ addressee: 'broadcast' }), self: self({ socialHunger: 0.8 }), bond: bond(), scene: 'group' }).move, 'participate');
  assert.equal(chooseMove({ perception: percept({ addressee: 'broadcast' }), self: self({ socialHunger: 0.3 }), bond: bond(), scene: 'group' }).move, 'silence');
  assert.equal(chooseMove({ perception: percept(), self: self(), bond: bond(), scene: 'private', isOwner: true }).move, 'reply');
});

test('一体化计划：动作 + 表达 + 理由；未知感知保守；动作集合稳定', () => {
  const plan = planResponse({
    perception: percept({ addressee: 'her', speechAct: 'question' }), self: self(), bond: bond({ affinity: 0.8 }), scene: 'private', isOwner: true,
  });
  assert.equal(plan.move.move, 'reply');
  assert.equal(plan.expression.scene, 'private');
  assert.ok(plan.expression.targetChars >= 20);
  assert.ok(plan.reasons.length >= 2);
  assert.match(describeMove(plan.move), /动作=/);
  assert.equal(chooseMove({}).move, 'reply');
  assert.deepEqual(MOVES, ['silence', 'minimal', 'reply', 'participate', 'question', 'tease', 'comfort', 'deflect']);
});

test('接线：expression-policy 已接 move-selector', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'src/domain/mind/expression-policy.mjs'), 'utf8');
  assert.match(src, /chooseMove/);
  assert.match(src, /planResponse/);
});
