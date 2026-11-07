// test-kernel-integrity.test.mjs · 独立审计 P1-1/P1-2/P1-3/P2-7/P2-8/P2-9/P2-10 的负向判据。
// 这些用例在审计时全部失败；修好后必须一直绿，防止状态机退化成"事件怎么写都算数"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertEvent } from '../src/kernel/events.mjs';
import {
  INITIAL_STATE, reduce, normalizeState, finiteNeeds,
} from '../src/kernel/state.mjs';
import { decide } from '../src/kernel/cognition.mjs';

const T = Date.UTC(2026, 10, 4, 0, 0, 0);
const H = 3600000;
const at = (h) => T + h * H;
const S = normalizeState({ ...INITIAL_STATE, at: T });

test('P1-1 终态不可回滚：broken→kept / dropped→done / closed→closed 全部拒绝', () => {
  let c = reduce(S, assertEvent('commitment.made', { id: 'c1', text: 'x' }, T));
  c = reduce(c, assertEvent('commitment.broken', { id: 'c1', reason: 'r' }, at(1)));
  const stressAfterBreak = c.stress;
  c = reduce(c, assertEvent('commitment.kept', { id: 'c1' }, at(1)));
  assert.equal(c.commitments[0].status, 'broken', '终态不得被 kept 回滚');
  assert.equal(c.stress, stressAfterBreak, '被拒绝的迁移不得施加情绪副作用');

  let g = reduce(S, assertEvent('goal.formed', { id: 'g1', text: 'x' }, T));
  g = reduce(g, assertEvent('goal.abandoned', { id: 'g1', reason: '不做了' }, at(1)));
  g = reduce(g, assertEvent('goal.completed', { id: 'g1' }, at(2)));
  assert.equal(g.goals[0].status, 'dropped');
  assert.equal(g.affect.joy, 0, '被拒绝的完成不得发 joy');

  let q = reduce(S, assertEvent('curiosity.opened', { id: 'q1', text: 'x' }, T));
  q = reduce(q, assertEvent('curiosity.closed', { id: 'q1', how: 'resolved' }, at(1)));
  const joyAfterResolve = q.affect.joy;
  q = reduce(q, assertEvent('curiosity.closed', { id: 'q1', how: 'lost' }, at(1)));
  assert.equal(q.curiosities[0].how, 'resolved');
  assert.equal(q.affect.joy, joyAfterResolve);
});

test('P1-2 未知 id / 重复事件不产生幻情绪', () => {
  const a = reduce(S, assertEvent('goal.completed', { id: 'nope' }, at(1)));
  assert.equal(a.affect.joy, 0);
  const b = reduce(S, assertEvent('commitment.broken', { id: 'nope', reason: 'x' }, at(1)));
  assert.equal(b.affect.sadness, 0);
  assert.ok(b.stress <= S.stress, '未知承诺不得叠加压力');
  const q = reduce(S, assertEvent('curiosity.closed', { id: 'nope', how: 'resolved' }, at(1)));
  assert.equal(q.affect.joy, 0);

  let c = reduce(S, assertEvent('commitment.made', { id: 'c1', text: 'x' }, T));
  c = reduce(c, assertEvent('commitment.broken', { id: 'c1', reason: 'r' }, at(1)));
  const once = { stress: c.stress, sadness: c.affect.sadness };
  c = reduce(c, assertEvent('commitment.broken', { id: 'c1', reason: 'r' }, at(1)));
  assert.equal(c.stress, once.stress, '重复食言事件不得二次扣压力');
  assert.equal(c.affect.sadness, once.sadness);

  let g = reduce(S, assertEvent('goal.formed', { id: 'g1', text: 'x' }, T));
  g = reduce(g, assertEvent('goal.completed', { id: 'g1' }, at(1)));
  const joy = g.affect.joy;
  g = reduce(g, assertEvent('goal.completed', { id: 'g1' }, at(1)));
  assert.equal(g.affect.joy, joy, '重复完成不得二次发 joy');
});

test('P1-3 事件入口拒绝坏 payload（selfTrust / how / amount / 文本类型）', () => {
  assert.throws(() => assertEvent('self.trust_assessed', { value: 'abc', reason: 'x' }, T), /finite number/);
  assert.throws(() => assertEvent('self.trust_assessed', { value: false, reason: 'x' }, T), /finite number/);
  assert.throws(() => assertEvent('self.trust_assessed', { value: 2, reason: 'x' }, T), /greater than 1/);
  assert.throws(() => assertEvent('curiosity.closed', { id: 'q1', how: 'whatever' }, T), /one of/);
  assert.throws(() => assertEvent('attention.spent', { amount: '0.5', reason: 'x' }, T), /finite number/);
  assert.throws(() => assertEvent('attention.spent', { amount: -0.1, reason: 'x' }, T), /less than 0/);
  assert.throws(() => assertEvent('goal.formed', { id: 'g1', text: 123 }, T), /must be a string/);
  assert.throws(() => assertEvent('goal.formed', { id: 'g1', text: 'x'.repeat(301) }, T), /longer than 300/);
});

test('P2-7 时间单调：晚到事件不让 state.at 倒退、不重复计时', () => {
  const direct = reduce(S, assertEvent('life.tick', { at: at(11) }, at(11)));
  let late = reduce(S, assertEvent('life.tick', { at: at(10) }, at(10)));
  late = reduce(late, assertEvent('life.tick', { at: at(5) }, at(5)));
  late = reduce(late, assertEvent('life.tick', { at: at(11) }, at(11)));
  assert.equal(late.at, at(11), 'state.at 只能前进');
  assert.ok(Math.abs(late.energy - direct.energy) < 1e-9, '同一段时间不得被重复耗能');
});

test('P2-8 同 id 不重复建条目；normalize 也会去重', () => {
  let g = reduce(S, assertEvent('goal.formed', { id: 'g1', text: 'a' }, T));
  g = reduce(g, assertEvent('goal.completed', { id: 'g1' }, at(1)));
  g = reduce(g, assertEvent('goal.formed', { id: 'g1', text: 'reborn' }, at(2)));
  assert.equal(g.goals.length, 1);
  assert.equal(g.goals[0].status, 'active');
  assert.equal(g.goals[0].text, 'reborn');

  let c = reduce(S, assertEvent('commitment.made', { id: 'c1', text: 'a' }, T));
  c = reduce(c, assertEvent('commitment.made', { id: 'c1', text: 'b' }, at(1)));
  assert.equal(c.commitments.length, 1);
  assert.equal(c.commitments[0].text, 'a', '承诺是不可变事实，重复 id 忽略第二条');

  const deduped = normalizeState({ ...S, goals: [
    { id: 'x', text: 'old', status: 'done', createdAt: T, updatedAt: T },
    { id: 'x', text: 'new', status: 'active', createdAt: T, updatedAt: T },
  ] });
  assert.equal(deduped.goals.length, 1);
  assert.equal(deduped.goals[0].status, 'active');
});

test('P2-9 好奇心满 40 时先淘汰 closed，不淘汰 open', () => {
  let s = S;
  for (let i = 0; i < 40; i += 1) s = reduce(s, assertEvent('curiosity.opened', { id: `q${i}`, text: 'x' }, T));
  s = reduce(s, assertEvent('curiosity.closed', { id: 'q0', how: 'resolved' }, T));
  assert.equal(s.curiosities.filter((c) => c.status === 'closed').length, 1);
  s = reduce(s, assertEvent('curiosity.opened', { id: 'q-new', text: 'x' }, T));
  assert.equal(s.curiosities.length, 40);
  assert.equal(s.curiosities.filter((c) => c.status === 'closed').length, 0, 'closed 应先被淘汰');
  assert.ok(s.curiosities.some((c) => c.id === 'q1'), '老 open 仍在');
});

test('P2-10 目标驱动不虚假引用经验；只有经验真正改变行为才记 usedLessonId', () => {
  const withGoal = normalizeState({
    ...S, at: T, unread: [],
    lessons: [{ id: 'l1', text: '别连着发', trigger: '', at: T, hits: 0 }],
    goals: [{ id: 'g1', text: '查清 ws', status: 'active', createdAt: T, updatedAt: T, stale: false }],
  });
  const d = decide(withGoal, { now: T, contextText: '' });
  // [G1] 目标驱动现在选中 plan；P2-10 的核心契约仍是"不虚假引用经验"。
  assert.equal(d.selected, 'plan');
  assert.equal(d.usedLessonId, null, '目标动机不是经验命中');

  const withUnread = normalizeState({
    ...S, at: T, unread: [{ key: 'private:1', at: T }],
    lessons: [{ id: 'l1', text: '别连着发', trigger: '', at: T, hits: 0 }],
  });
  assert.equal(decide(withUnread, { now: T, contextText: '' }).usedLessonId, null, '回复动机不是经验命中');
});

test('边界统一：14 天整的陈旧目标，finiteNeeds 与 tick 判据一致', () => {
  const s = normalizeState({
    ...S, at: T + 14 * 24 * H,
    goals: [{ id: 'g1', text: 'x', status: 'active', createdAt: T, updatedAt: T, stale: false }],
  });
  assert.equal(finiteNeeds(s).staleGoals.length, 1, '恰好 14 天应视为陈旧');
});
