// 意志门：把 meta-controller 的 selected 意图转成 允许/拦截 + 概率缩放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateProactive } from '../src/domain/mind/intention-gate.mjs';

test('gate：rest/reflect/consolidate 一律拦截', () => {
  for (const type of ['rest', 'reflect', 'consolidate']) {
    const r = gateProactive({ selected: { type, reason: 'x' } }, { scope: 'join' });
    assert.equal(r.allow, false, `${type} 应拦截`);
    assert.equal(r.boost, 0);
    assert.equal(r.type, type);
  }
});

test('gate：reply/initiate 放行并上调概率', () => {
  const reply = gateProactive({ selected: { type: 'reply', reason: '有人在对她说' } });
  assert.equal(reply.allow, true);
  assert.ok(reply.boost > 1);
  const init = gateProactive({ selected: { type: 'initiate', reason: '想找人说话' } });
  assert.equal(init.allow, true);
  assert.ok(init.boost > 1);
});

test('gate：没有明确意图时放行且不改变概率', () => {
  const r = gateProactive({ selected: null });
  assert.equal(r.allow, true);
  assert.equal(r.boost, 1);
  assert.equal(r.type, null);
});
