// test-life-kernel.test.mjs · "她真的活着"的行为判据（可证伪，不是结构断言）
//
// 五条判据对应蓝图七个闭环里最关键、也是旧系统实测断掉的几条：
//   1 连续性 —— 时间自己流过，状态可由事件流完全重建
//   2 内生驱动 —— 没有消息也会因孤独/好奇自己产生意图（不是只被 @ 才动）
//   3 经验改变行为 —— 反思产出的 lesson 必须改变下一次决策，且引用可度量（R7）
//   4 有限性 —— 会累、会睡、会忘
//   5 契约完整 —— 事件无孤儿类型；损坏输入在入口暴露而不是静默
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertEvent, auditEventContracts, EVENT_CONTRACTS, EVENT_TYPES } from '../src/kernel/events.mjs';
import { createMemoryPorts, createHostPorts, assertPorts } from '../src/kernel/ports.mjs';
import { reduce, replay, finiteNeeds, INITIAL_STATE } from '../src/kernel/state.mjs';
import { decide, reflect, INTENTIONS } from '../src/kernel/cognition.mjs';
import { createKernel, PHASE_ORDER } from '../src/kernel/index.mjs';

const T = Date.UTC(2026, 10, 4, 8, 0, 0);
const H = 3600000;
const at = (h) => T + h * H;

function kernel(opts = {}) {
  const ports = createMemoryPorts({ at: T });
  return createKernel({ ports, reflectMs: opts.reflectMs ?? 6 * H, ...opts });
}

test('契约：事件表零孤儿，未知类型/缺字段一律抛错', () => {
  assert.deepEqual(auditEventContracts(), [], '每个类型都必须有消费者，且阶段合法');
  assert.ok(EVENT_TYPES.includes('error.observed'), '旧系统只消费无生产的类型已纳入契约');
  assert.ok(EVENT_CONTRACTS['lesson.formed'].consumers.includes('decide'), '反思产物必须被决策消费');
  const e = assertEvent('message.received', { key: 'group:1' }, T);
  assert.equal(e.phase, 'sense');
  assert.throws(() => assertEvent('no.such.event', {}, T), /unknown event type/);
  assert.throws(() => assertEvent('message.received', {}, T), /missing required field/);
});

test('判据1 · 连续性：无输入也会随时间衰减；事件流可完整重建当前状态', () => {
  const k = kernel();
  const t1 = k.tick(at(0));
  assert.deepEqual(t1.phases, PHASE_ORDER);
  const energy0 = k.state.energy;
  k.tick(at(6));
  assert.ok(k.state.energy < energy0, '醒着 6 小时会累');
  assert.ok(k.state.socialHunger > INITIAL_STATE.socialHunger, '没人说话，孤独会涨');
  const rebuilt = k.replayFrom();
  assert.deepEqual(rebuilt, k.state, '同一串事件必然重建出同一个她');
});

test('判据2 · 内生驱动：没有任何消息，也会因社交饥饿主动发起', () => {
  const k = kernel({ reflectMs: 100 * H });
  k.tick(at(0));
  // 7h 后社交饥饿越过阈值、精力仍充沛；全程无 message.received
  const t = k.tick(at(7));
  assert.equal(t.decision.selected, 'initiate');
  assert.match(t.decision.reason, /社交饥饿/);
  assert.ok(k.ports.act.history().some((a) => a.selected === 'initiate'), '意图真的被执行了');
  assert.equal(k.ports.events.read().filter((e) => e.type === 'message.received').length, 0, '确实无人发消息');
});

test('判据3 · 经验改变行为（旧系统断点）：反思形成 lesson → 下一次决策改变 → 引用可度量', () => {
  const k = kernel({ reflectMs: 100 * H });
  k.tick(at(0));

  // 环①：反思从"连续主动发起却没人回"里形成经验（纯函数，证据可检）
  const r = reflect(k.state, [
    { type: 'message.sent', payload: { key: 'private:1' }, at: at(0) },
    { type: 'message.sent', payload: { key: 'private:1' }, at: at(1) },
  ], { now: at(1) });
  assert.equal(r.lessons.length, 1, '发出两条却没人回 → 一条经验');
  assert.equal(r.evidence.sent, 2);
  assert.equal(r.evidence.received, 0);
  assert.match(r.lessons[0].text, /缓一缓/);

  // 环②：经验写回状态（唯一入口 reduce）
  for (const lesson of r.lessons) k.emit('lesson.formed', lesson, at(1));
  const lesson = k.state.lessons[k.state.lessons.length - 1];
  assert.ok(lesson, '经验进入单一状态权威');

  // 环③：同一个"社交饥饿高"场景下，有无经验导致不同行为
  const scene = { ...k.state, socialHunger: 0.8, energy: 0.7, sleeping: false, unread: [], lastInitiateAt: at(1) };
  const before = decide({ ...scene, lessons: [] }, { now: at(2) });
  assert.equal(before.selected, 'initiate', '没有经验时会主动找人');
  const after = decide(scene, { now: at(2) });
  assert.equal(after.selected, 'reflect', '有了经验，她改变了行为（不再连着打扰）');
  assert.equal(after.usedLessonId, lesson.id, '引用哪条经验必须可追溯');

  // 环④：引用是可度量的事实（R7「lesson 应用率」），不是口头承诺
  k.emit('decision.context', { intention: after.selected, usedLessonId: after.usedLessonId }, at(2));
  assert.equal(k.state.lessonRefs.length, 1);
  assert.equal(k.state.lessons.at(-1).hits, 1);
  assert.equal(k.replayFrom().lessonRefs.length, 1, '引用证据也能从事件流重建');
});

test('判据3b · 反思空产出是诚实结果，不伪装成成功', () => {
  const r = reflect(INITIAL_STATE, [], { now: T });
  assert.equal(r.empty, true);
  assert.equal(r.insight, '今天没有');
  const r2 = reflect(INITIAL_STATE, [
    { type: 'message.sent', payload: { key: 'private:1' }, at: T },
    { type: 'message.sent', payload: { key: 'private:1' }, at: T + 1 },
  ], { now: T });
  assert.equal(r2.lessons.length, 1);
  assert.equal(r2.evidence.sent, 2);
  assert.equal(r2.evidence.received, 0);
  const r3 = reflect(INITIAL_STATE, [
    { type: 'message.sent', payload: { key: 'private:1' }, at: T },
    { type: 'message.received', payload: { key: 'private:1' }, at: T + 1 },
  ], { now: T });
  assert.equal(r3.empty, true, '发一条、回一条 = 被接住，不该硬凑经验');
});

test('判据3c · 端到端一天：闭环必须真的发生（防退化成静默）', () => {
  // 回归锁：旧系统 reflections=0 正是"跑了很多轮却什么都没形成"。
  // 这里要求 24h 真实推演中至少形成一条经验，且它确实被决策引用、改变了行为。
  const k = kernel();
  for (let h = 0; h <= 24; h += 1) {
    if (h === 12) k.ports.sense.push({ type: 'message.received', payload: { key: 'private:1' }, at: at(h) });
    const tr = k.tick(at(h));
    assert.equal(tr.failed, null, `${h}h 不应有阶段失败`);
  }
  assert.ok(k.state.lessons.length >= 1, '一天里应至少想明白一件事');
  assert.ok(k.state.lessonRefs.length >= 1, '经验必须真的被下一次决策引用');
  const changed = k.ports.events.read().some((e) => e.type === 'decision.context'
    && e.payload?.intention === 'reflect' && e.payload?.usedLessonId);
  assert.ok(changed, '必须存在一条"因经验而改变行为"的可追溯决策');
  assert.deepEqual(k.replayFrom(), k.state, '整天可完整回放');
});

test('判据4 · 有限性：累了会睡、睡着会恢复、过期没用过的经验会忘', () => {
  const k = kernel({ reflectMs: 100 * H });
  k.tick(at(0));
  k.tick(at(16));
  assert.ok(finiteNeeds({ ...k.state, energy: 0.1, sleepDebt: 0.9, sleeping: false }).shouldSleep, '精力见底必须休息');
  const s = reduce({ ...k.state, at: at(16), sleeping: true, energy: 0.1 }, assertEvent('life.tick', { at: at(24) }, at(24)));
  assert.ok(s.energy > 0.1, '睡眠恢复精力');
  const stale = finiteNeeds({
    ...k.state, at: T + 40 * 24 * H,
    lessons: [{ id: 'old', at: T, hits: 0, text: 'x', trigger: '' }],
  });
  assert.equal(stale.staleLessons.length, 1, '30 天没用过的经验会被遗忘');
});

test('判据5 · 失败隔离：单个阶段抛错不污染状态，且能定位到阶段', () => {
  const ports = createMemoryPorts({ at: T });
  ports.act.perform = () => { throw new Error('boom'); };
  const k = createKernel({ ports });
  const t = k.tick(at(0));
  assert.ok(t.failed, '应记录失败');
  assert.equal(t.failed.phase, 'decide', '失败发生在 act 之前的那一步');
  assert.match(t.failed.error, /boom/);
  assert.ok(k.state.ticks >= 1, '已发生的状态推进不被回滚（事件流是事实）');
});

test('端口：宿主接线复用既有 lifeLog/store，不另造并行数据', () => {
  const appended = [];
  const saved = [];
  const host = createHostPorts({
    at: T,
    lifeLog: {
      append: (e, o) => { appended.push({ ...e, at: o.at }); return e; },
      read: () => appended.map((e) => ({ type: e.type, at: e.at, payload: e.payload })),
    },
    store: {
      readJson: () => null,
      writeJson: (_f, v) => { saved.push(v); },
    },
  });
  assertPorts(host);
  const k = createKernel({ ports: host, reflectMs: 100 * H });
  k.tick(at(0));
  assert.ok(appended.length >= 4, '事件写进既有生命线');
  assert.ok(saved.length >= 1, '状态存进既有状态仓');
  assert.equal(k.state.ticks, 1);
});

test('决策：意图集合封闭、决策永远可解释', () => {
  assert.ok(INTENTIONS.includes('rest'));
  const d = decide({ ...INITIAL_STATE, at: T, energy: 0.05 }, { now: T });
  assert.equal(d.selected, 'rest');
  assert.equal(d.explainable, true);
  assert.ok(d.reason.length > 0);
});

test('模型端口：可注入判断，规则保留为兜底；生理硬约束不可被模型覆盖', () => {
  const scene = { ...INITIAL_STATE, at: T, energy: 0.7, socialHunger: 0.8, sleeping: false, unread: [] };
  const rule = decide(scene, { now: T });
  assert.equal(rule.selected, 'initiate');
  assert.equal(rule.source, 'rule');

  const withModel = decide(scene, { now: T, model: ({ rule: r }) => ({ selected: 'repair', reason: `模型改写（规则=${r.selected}）` }) });
  assert.equal(withModel.selected, 'repair');
  assert.equal(withModel.source, 'model');
  assert.match(withModel.reason, /规则=initiate/);

  assert.equal(decide(scene, { now: T, model: () => ({ selected: 'not-an-intention' }) }).selected, 'initiate', '非法输出回退');
  assert.equal(decide(scene, { now: T, model: () => null }).selected, 'initiate', '空输出回退');
  assert.equal(decide(scene, { now: T, model: () => { throw new Error('model down'); } }).selected, 'initiate', '模型抛错回退');

  const tired = { ...scene, energy: 0.05 };
  const guarded = decide(tired, { now: T, model: () => ({ selected: 'initiate', reason: '我还想聊' }) });
  assert.equal(guarded.selected, 'rest', '累了就是累了，模型不能把她抽干');
  assert.equal(guarded.source, 'vital');
});

test('影子对账：life-loop 同拍触发内核钩子，钩子失败不影响既有循环', async () => {
  // 用内核自己的 tick 作为影子入口做契约验证（app.mjs 接线为 life.mode 开关，默认关闭、新部署默认 shadow）。
  const { createStateStore } = await import('../src/domain/shared/state-store.mjs');
  const { createLifeLog } = await import('../src/domain/shared/life-log.mjs');
  const { createLifeLoop } = await import('../src/domain/life/life-loop.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathM = await import('node:path');
  const base = fs.mkdtempSync(pathM.join(os.tmpdir(), 'qq-shadow-'));
  const store = createStateStore({ root: pathM.join(base, 'state') });
  const lifeLog = createLifeLog({ root: pathM.join(base, 'logs') });
  const seen = [];
  let onTickFn = ({ at }) => seen.push(at);
  const loop = createLifeLoop({ store, lifeLog, now: () => 0, minTickMs: 0, onTick: onTickFn });
  await loop.tick({ now: 0, force: true });
  await loop.tick({ now: 60000, force: true });
  assert.equal(seen.length, 2, '每拍一次，不新增定时器');

  const broken = createLifeLoop({ store, lifeLog, now: () => 0, minTickMs: 0, onTick: () => { throw new Error('shadow down'); } });
  const r = await broken.tick({ now: 120000, force: true });
  assert.equal(r.skipped, false, '钩子抛错不影响既有 tick');
  assert.match(broken.status().lastError, /shadow down/, '失败原因仍可查');
});
