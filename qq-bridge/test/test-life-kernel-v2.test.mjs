// test-life-kernel-v2.test.mjs · 宪章 S1：L1 状态（selfTrust/attention）+ L2 欲望（目标/好奇）
// + L4 立法（承诺/拒绝/自由调整）+ §5.20 self-thread 的可证伪判据。
//
// 核心宪法断言（不是功能断言）：
//   C4/A6：系统不自动改 selfTrust、不自动撤销 goal；承诺兑现/食言只是事实，信任由她自己的评估改写。
//   可回放：同一串事件必须重建出同一个她。
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertEvent, auditEventContracts, EVENT_TYPES } from '../src/kernel/events.mjs';
import { createMemoryPorts } from '../src/kernel/ports.mjs';
import { reduce, replay, normalizeState, INITIAL_STATE, finiteNeeds } from '../src/kernel/state.mjs';
import { decide, reflect } from '../src/kernel/cognition.mjs';
import { createKernel } from '../src/kernel/index.mjs';

const T = Date.UTC(2026, 10, 4, 0, 0, 0);
const H = 3600000;
const at = (h) => T + h * H;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} != ${b}`);
// 直接 reduce 的用例必须把初始状态锚到 T，否则从 epoch 到 2026 的时间流逝会先把状态推到边界，
// 断言"关闭好奇带来 +Δ"就失去意义（这也是 kernel 工厂会做 at 锚定的原因）。
const S = normalizeState({ ...INITIAL_STATE, at: T });

function reduceAll(events, initial = S) {
  return events.reduce((s, e) => reduce(s, e), normalizeState(initial));
}

test('契约 v2：L1/L2/L4 事件入表，零孤儿，缺字段在入口暴露', () => {
  assert.deepEqual(auditEventContracts(), []);
  for (const type of [
    'goal.formed', 'goal.progressed', 'goal.completed', 'goal.abandoned', 'goal.stale',
    'curiosity.opened', 'curiosity.closed',
    'commitment.made', 'commitment.kept', 'commitment.broken',
    'declined', 'freedom.adjust', 'freedom.rebutted',
    'self.trust_assessed', 'self_thread.updated', 'attention.spent', 'attention.restored',
  ]) assert.ok(EVENT_TYPES.includes(type), `缺少事件契约: ${type}`);

  assert.equal(assertEvent('goal.formed', { id: 'g1', text: '查清 ws 重连原理' }, T).phase, 'decide');
  assert.throws(() => assertEvent('goal.formed', { id: 'g1' }, T), /missing required field: text/);
  assert.throws(() => assertEvent('self.trust_assessed', { value: 0.4 }, T), /missing required field: reason/);
});

test('C4/A6：承诺兑现/食言只是事实，系统不自动拨动 selfTrust；信任只由她自己的评估改写', () => {
  let s = reduce(S, assertEvent('commitment.made', {
    id: 'c1', text: '每天睡前回读一次自己的账本', penalty: '把 decoFloor 调回 0.3',
  }, T));
  assert.equal(s.commitments[0].status, 'active');
  assert.equal(s.commitments[0].penalty.includes('decoFloor'), true);

  s = reduce(s, assertEvent('commitment.kept', { id: 'c1' }, at(1)));
  assert.equal(s.commitments[0].status, 'kept');
  assert.equal(s.selfTrust, 0.5, '兑现本身不自动加信任');

  // 终态不可回滚：另立一条来验证食言（kept 的 c1 不能再被 broken）。
  s = reduce(s, assertEvent('commitment.made', { id: 'c2', text: '不熬夜查资料' }, at(2)));
  s = reduce(s, assertEvent('commitment.broken', { id: 'c2', reason: '沉迷查资料忘了' }, at(3)));
  assert.equal(s.commitments.find((c) => c.id === 'c1').status, 'kept');
  assert.equal(s.commitments.find((c) => c.id === 'c2').status, 'broken');
  assert.equal(s.selfTrust, 0.5, '食言本身不自动扣信任（解读归她）');
  assert.ok(s.stress > 0.1, '食言让她自己难受是状态回流，不是系统审判');

  s = reduce(s, assertEvent('self.trust_assessed', { value: 0.38, reason: '两次食言，我对自己没那么信了' }, at(4)));
  close(s.selfTrust, 0.38);
  assert.equal(s.trustLog.length, 1);
  assert.match(s.trustLog[0].reason, /食言/);

  // 入口契约拒绝越界值：不能静默 clamp（审计 P1-3）。
  assert.throws(() => assertEvent('self.trust_assessed', { value: 1.7, reason: '夸张' }, at(5)), /greater than 1/);
  close(s.selfTrust, 0.38);
});

test('C4/A6：目标陈旧只置事实标记，不自动 drop；放弃只能由她自己的事件完成', () => {
  let s = reduce(S, assertEvent('goal.formed', { id: 'g1', text: '查清 ws 重连原理' }, T));
  assert.equal(s.goals[0].status, 'active');
  assert.equal(s.goals[0].stale, false);

  s = reduce(s, assertEvent('life.tick', { at: at(1) }, at(1)));
  s = reduce(s, assertEvent('goal.progressed', { id: 'g1', note: '读完了端口层' }, at(2)));
  assert.equal(s.goals[0].stale, false);
  assert.match(s.goals[0].progress, /端口/);

  s = reduce(s, assertEvent('goal.stale', { id: 'g1' }, at(24 * 15)));
  assert.equal(s.goals[0].status, 'active', '陈旧不是撤销：状态仍是 active');
  assert.equal(s.goals[0].stale, true);

  const needs = finiteNeeds({ ...s, at: at(24 * 16) });
  assert.equal(needs.staleGoals.length, 0, '已置 stale 的不重复报告');

  s = reduce(s, assertEvent('goal.abandoned', { id: 'g1', reason: '优先级变了，我先放下' }, at(24 * 16)));
  assert.equal(s.goals[0].status, 'dropped');
  assert.match(s.goals[0].abandonedReason, /优先级/);
});

test('内核 tick：超过陈旧阈值只产生 goal.stale 事件；replay 与实时状态一致', () => {
  const k = createKernel({ ports: createMemoryPorts({ at: T }), reflectMs: 1000 * H, goalStaleMs: 14 * 24 * H });
  k.emit('goal.formed', { id: 'g1', text: '把明日方舟那步操作学会' }, T);
  const trace = k.tick(at(24 * 15));
  assert.equal(trace.failed, null);
  assert.ok(trace.events.some((e) => e.type === 'goal.stale' && e.payload.id === 'g1'), '应报告陈旧事实');
  assert.equal(k.state.goals[0].status, 'active', '不替她撤销');
  assert.deepEqual(k.replayFrom(), k.state, '同一串事件重建出同一个她');
});

test('L2：active 目标本身是动机；stale 目标不再驱动行为（但仍在状态里）', () => {
  const base = normalizeState({
    ...INITIAL_STATE, at: T, energy: 0.7, socialHunger: 0.3, curiosity: 0.4,
    attention: 0.9, lastReflectAt: T, unread: [],
    goals: [{ id: 'g1', text: '查清 ws 重连原理', status: 'active', createdAt: T, updatedAt: T, stale: false }],
  });
  const d = decide(base, { now: T });
  // [G1] active 目标现在触发长程规划意图（plan），不再是 explore；目标本身仍是动机。
  assert.equal(d.selected, 'plan');
  assert.equal(d.goalId, 'g1', '规划必须绑定触发它的目标');
  assert.match(d.reason, /推进目标/);

  const stale = normalizeState({ ...base, goals: [{ ...base.goals[0], stale: true }] });
  assert.notEqual(decide(stale, { now: T }).selected, 'plan', '陈旧目标不再驱动行为');
});

test('§5.19：注意力见底时休息是硬约束；时间会恢复注意力', () => {
  const low = normalizeState({
    ...INITIAL_STATE, at: T, attention: 0.05, energy: 0.8, lastReflectAt: T, unread: [],
  });
  const d = decide(low, { now: T });
  assert.equal(d.selected, 'rest');
  assert.equal(d.source, 'vital');
  assert.match(d.reason, /注意力/);

  const rested = reduce(low, assertEvent('life.tick', { at: at(6) }, at(6)));
  assert.ok(rested.attention > low.attention, '静置 6 小时注意力恢复');

  const limited = reduce(low, assertEvent('attention.spent', { amount: 0.5, reason: '连续处理群消息' }, T));
  close(limited.attention, 0);
});

test('§5.3：自我信任低且压力大 → 先照顾自己（不是继续产出）', () => {
  const s = normalizeState({
    ...INITIAL_STATE, at: T, energy: 0.7, selfTrust: 0.2, stress: 0.5,
    lastReflectAt: T, unread: [], attention: 0.9,
  });
  const d = decide(s, { now: T });
  assert.equal(d.selected, 'selfcare');
  assert.match(d.reason, /自我信任/);
});

test('L2 好奇：开启→查清关闭带来小步正向；丢掉关闭只留一点未完成感', () => {
  let s = reduce(S, assertEvent('curiosity.opened', { id: 'q1', text: 'ws 重连为什么掉线' }, T));
  assert.equal(s.curiosities[0].status, 'open');
  const before = { valence: s.valence, curiosity: s.curiosity, stress: s.stress };

  const resolved = reduce(s, assertEvent('curiosity.closed', { id: 'q1', how: 'resolved' }, at(1)));
  assert.equal(resolved.curiosities[0].status, 'closed');
  assert.ok(resolved.valence > before.valence);
  assert.ok(resolved.curiosity > before.curiosity);

  const lost = reduce(s, assertEvent('curiosity.closed', { id: 'q1', how: 'lost' }, at(1)));
  assert.ok(lost.stress > before.stress);
  assert.equal(lost.curiosities[0].how, 'lost');
});

test('L4 拒绝通道 + 世界后果可被她的立法反驳', () => {
  let s = reduce(S, assertEvent('declined', {
    target: '每日主动提案', reason: '我不想变成打卡机器',
  }, T));
  assert.equal(s.declined.length, 1);
  assert.match(s.declined[0].reason, /打卡/);

  s = reduce(s, assertEvent('freedom.adjust', { kind: 'wake_budget', detail: '每日自主唤醒上限 8 次', ref: 'f1' }, at(1)));
  assert.equal(s.freedomAdjustments[0].rebutted, false);
  s = reduce(s, assertEvent('freedom.rebutted', { ref: 'f1', reason: '这是我自己的生活节奏，不该用次数衡量' }, at(2)));
  assert.equal(s.freedomAdjustments[0].rebutted, true);
  assert.match(s.freedomAdjustments[0].rebuttal, /生活节奏/);
});

test('§5.20 self-thread：跨沉默保留"此刻在想什么"，可回放', () => {
  const events = [
    assertEvent('self_thread.updated', { thought: '还在想 ws 重连那件事，没查完' }, T),
    assertEvent('life.tick', { at: at(3) }, at(3)),
  ];
  const s = reduceAll(events);
  assert.match(s.selfThread.thought, /ws 重连/);
  assert.equal(s.selfThread.at, T);
  assert.deepEqual(replay(events, S), s);
});

test('有界：目标/承诺/拒绝无限增长会被压实，但活跃条目不先被挤掉', () => {
  let s = S;
  for (let i = 0; i < 45; i += 1) {
    s = reduce(s, assertEvent('goal.formed', { id: `g${i}`, text: `目标 ${i}` }, T));
  }
  assert.ok(s.goals.length <= 40, '目标有界');
  assert.equal(s.goals.some((g) => g.id === 'g44'), true, '最新目标保留');

  // 已了结的目标准先淘汰：塞满后再加，活跃的 g44 不应被挤掉
  s = reduce(s, assertEvent('goal.completed', { id: 'g0' }, T));
  for (let i = 45; i < 50; i += 1) s = reduce(s, assertEvent('goal.formed', { id: `g${i}`, text: `目标 ${i}` }, T));
  assert.equal(s.goals.some((g) => g.id === 'g44'), true);
  assert.equal(s.goals.some((g) => g.id === 'g49'), true);

  for (let i = 0; i < 60; i += 1) {
    s = reduce(s, assertEvent('declined', { target: `事项 ${i}`, reason: '不想做' }, T));
  }
  assert.ok(s.declined.length <= 50);
});

test('兼容：旧状态升级到 v3 不丢字段，数值 clamp 有界', () => {
  const legacy = { v: 1, at: T, energy: 2, socialHunger: -1, lessons: [{ id: 'l', text: 'x', at: T }] };
  const s = normalizeState(legacy);
  assert.equal(s.v, 3);
  assert.deepEqual(s.affect, { joy: 0, sadness: 0, anger: 0, fear: 0, affection: 0 });
  assert.equal(s.energy, 1);
  assert.equal(s.socialHunger, 0);
  assert.equal(s.selfTrust, 0.5);
  assert.equal(s.attention, 0.9);
  assert.deepEqual(s.goals, []);
  assert.equal(s.selfThread.thought, '');
});

test('反思：承诺食言/目标陈旧会形成经验（证据可检、不硬凑）', () => {
  const r = reflect(INITIAL_STATE, [
    { type: 'commitment.broken', payload: { id: 'c1' }, at: T },
  ], { now: T });
  assert.equal(r.lessons.length, 1);
  assert.match(r.lessons[0].text, /答应过的事/);
  assert.equal(r.evidence.promisesBroken, 1);

  const r2 = reflect(INITIAL_STATE, [
    { type: 'goal.stale', payload: { id: 'g1' }, at: T },
  ], { now: T });
  assert.equal(r2.lessons.length, 1);
  assert.match(r2.lessons[0].text, /挂着/);

  const r3 = reflect(INITIAL_STATE, [], { now: T });
  assert.equal(r3.empty, true, '没有证据就是没有');
});

test('7 日闭环推演：状态→欲望→行动→后果→自我裁决，全部可追溯、可回放', () => {
  const ports = createMemoryPorts({ at: T });
  const k = createKernel({ ports, reflectMs: 6 * H, goalStaleMs: 5 * 24 * H });
  const all = [];
  const originalAppend = ports.events.append;
  ports.events.append = (row) => { all.push(row); return originalAppend(row); };

  k.emit('goal.formed', { id: 'g1', text: '把 ws 重连原理查清楚' }, at(4));
  k.emit('commitment.made', { id: 'c1', text: '查清楚之前每天推进一点', penalty: '把 decoFloor 调回 0.3' }, at(50));

  for (let h = 0; h <= 24 * 7; h += 1) {
    // 后半段刻意断联：让社交饥饿越过阈值，验证「经验真的改变下一次行为」而不是只形成经验。
    if (h % 12 === 6 && h < 96) ports.sense.push({ type: 'message.received', payload: { key: 'private:1' }, at: at(h) });
    if (h === 12) k.emit('goal.progressed', { id: 'g1', note: '读完 ports.mjs' }, at(h));
    if (h === 80) k.emit('commitment.kept', { id: 'c1' }, at(h));
    if (h === 120) k.emit('self.trust_assessed', { value: 0.58, reason: '答应自己的事做到了，我对自己多一点信任' }, at(h));
    if (h === 140) k.emit('curiosity.closed', { id: 'q-never', how: 'lost' }, at(h));
    const tr = k.tick(at(h));
    assert.equal(tr.failed, null, `${h}h 不应有阶段失败`);
  }

  // 1) 每一个动作都能回到同一刻的决策与理由（100% 可追溯）
  const decisions = new Map();
  for (const e of all) {
    if (e.type === 'intention.shadow' || e.type === 'decision.context') {
      decisions.set(`${e.at}:${e.payload.intention ?? e.payload.selected}`, e.payload.reason || '');
    }
  }
  const actions = all.filter((e) => e.type === 'action.taken');
  assert.ok(actions.length > 0);
  for (const a of actions) {
    const key = `${a.at}:${a.payload.intention}`;
    assert.ok(decisions.has(key), `动作 ${key} 必须有同刻决策`);
    assert.ok(String(decisions.get(key)).length > 0, '决策理由不能为空');
  }

  // 2) 承诺兑现后，信任仍由她自己评估改写（不是系统算术）
  assert.equal(k.state.commitments[0].status, 'kept');
  close(k.state.selfTrust, 0.58);

  // 3) 目标被推进过，且没有因 5 天阈值被自动 drop（只置 stale 事实）
  assert.equal(k.state.goals[0].status, 'active');

  // 4) 经验闭环：至少形成一条经验并被决策引用
  assert.ok(k.state.lessons.length >= 1, '一周里应至少想明白一件事');
  assert.ok(k.state.lessonRefs.length >= 1, '经验必须真的改变下一次决策');

  // 5) 整周可回放
  assert.deepEqual(k.replayFrom(), k.state);
});
