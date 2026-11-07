import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntention, transitionIntention, activeIntentions, renderIntentionsBlock } from '../src/domain/leaves/inori-intentions.js';
import { createOutcome, summarizeOutcomes, renderOutcomesBlock } from '../src/domain/leaves/inori-outcome.js';

const now = 1_800_000_000_000;

test('意图：创建、推进、完成，不丢 why', () => {
  let list = [createIntention({ text: '把这章看完', why: '想知道后面', expected: '看完', now, id: 'a' })];
  assert.equal(list[0].status, 'open');
  list = transitionIntention(list, 'a', 'active', { now: now + 1 });
  assert.equal(list[0].status, 'active');
  list = transitionIntention(list, 'a', 'done', { now: now + 2, evidence: '看完了' });
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].evidence.length, 1);
});

test('activeIntentions 只取 open/active，并按更新时间倒序', () => {
  const list = [
    createIntention({ text: 'A', now, id: 'a' }),
    createIntention({ text: 'B', now: now + 1, id: 'b' }),
    { ...createIntention({ text: 'C', now, id: 'c' }), status: 'done' },
  ];
  assert.deepEqual(activeIntentions(list).map((x) => x.id), ['b', 'a']);
});

test('意图渲染是许可，不是催促', () => {
  const text = renderIntentionsBlock([createIntention({ text: 'A', why: '好奇', now, id: 'a' })]);
  assert.match(text, /^【你自己挂着的事】/);
  assert.match(text, /你可以继续、换、放下/);
  assert.doesNotMatch(text, /必须|应该/);
});

test('结果账本：创建、汇总、渲染', () => {
  const row = createOutcome({ intentionId: 'a', expected: 'X', actual: 'Y', result: 'partial', now });
  assert.equal(row.result, 'partial');
  assert.equal(summarizeOutcomes([row]).by.partial, 1);
  assert.match(renderOutcomesBlock([row]), /\[partial\]/);
});

test('result 非法时回退 partial，不抛', () => {
  assert.equal(createOutcome({ result: 'nonsense' }).result, 'partial');
});
