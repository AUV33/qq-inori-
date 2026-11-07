import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntentionCandidates, renderIntentionCandidates } from '../src/domain/leaves/inori-intention-candidates.js';

test('合并 wish/curiosity/goal/day-plan，去重、限量', () => {
  const list = buildIntentionCandidates({
    wishes: [{ wish: 'A', source: 'her' }],
    curiosity: [{ text: 'A' }, { text: 'B' }],
    goals: [{ title: 'C' }, { title: 'C', done: true }],
    dayPlan: [{ what: 'D' }],
  }, { max: 3 });
  assert.deepEqual(list.map((x) => x.text), ['A', 'B', 'C']);
});

test('渲染是候选，不是任务清单', () => {
  const text = renderIntentionCandidates([{ text: 'A', source: 'wish' }, { text: 'B', source: 'goal' }]);
  assert.match(text, /^【可以接的事】/);
  assert.match(text, /选不选、选哪件都行/);
  assert.doesNotMatch(text, /必须|应该/);
});

test('空候选返回空串', () => {
  assert.equal(renderIntentionCandidates([]), '');
});
