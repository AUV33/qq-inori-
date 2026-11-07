// kernel/index.mjs · 生命内核：单心跳六阶段，她是"一个持续的过程"而不是一堆定时器。
//
// 干什么：createKernel(ports) → 一个 tick() 依次跑 sense→state→decide→act→memory→reflect；
//         每阶段只通过事件说话，状态只由 reducer 变化，全部可回放。
// 为什么：旧系统 20+ 定时器各自推进状态、各写各的账本，时间被切碎，反思产物进不了决策。
//         一个心跳 = 一个因果链：这次行为是上次反思的结果，下次反思是这次行为的结果。
// 输入输出：注入 ports（见 ports.mjs）；tick(at) 返回完整 trace，确定性、离线可跑。
// 失败模式：任一阶段抛错不污染状态（返回 failed 阶段与原因），事件流保留已发生的部分。
// 不做什么：不自设 setInterval（节拍归宿主）、不连真实服务、不改旧系统任何行为。

import { assertEvent, EVENT_TYPES, auditEventContracts } from './events.mjs';
import { assertPorts, createMemoryPorts } from './ports.mjs';
import { normalizeState, reduce, replay, finiteNeeds, INITIAL_STATE } from './state.mjs';
import { decide, reflect } from './cognition.mjs';

export const KERNEL_VERSION = 1;
export const PHASE_ORDER = Object.freeze(['sense', 'state', 'decide', 'act', 'memory', 'reflect']);

/** 反思周期：默认 6 小时（可注入；不用定时器，由 tick 时间判据触发）。 */
export const DEFAULT_REFLECT_MS = 6 * 3600000;
/**
 * 反思回看的窗口：默认 24 小时，**刻意大于周期**。
 * 若窗口 == 周期，内生意图（约 4~7h 一次）在窗口内永远凑不到 2 次，
 * 反思就会像旧系统那样恒为空产出。想得勤、看得长，才想得出东西。
 */
export const DEFAULT_REFLECT_WINDOW_MS = 24 * 3600000;

export function createKernel(opts = {}) {
  const ports = opts.ports ? assertPorts(opts.ports) : createMemoryPorts(opts);
  const reflectMs = Number.isFinite(opts.reflectMs) && opts.reflectMs > 0 ? opts.reflectMs : DEFAULT_REFLECT_MS;
  const reflectWindowMs = Number.isFinite(opts.reflectWindowMs) && opts.reflectWindowMs > 0
    ? opts.reflectWindowMs : DEFAULT_REFLECT_WINDOW_MS;
  const contextText = typeof opts.contextText === 'function' ? opts.contextText : () => '';
  // 陈旧目标默认 14 天：只产生事实事件，不自动 drop（C4/A6，旧 inori-goals.js:128 的自动 drop 是违宪的）。
  const goalStaleMs = Number.isFinite(opts.goalStaleMs) && opts.goalStaleMs > 0 ? opts.goalStaleMs : 14 * 24 * 3600000;
  // 首次启动要把状态锚定到"现在"，否则 at=0 会让第一拍凭空跨过几十年，直接把精力抽干；
  // 刚醒也不该立刻反思，lastReflectAt 同样锚定到启动时刻。
  const loaded = ports.state.load();
  const base = loaded || opts.initial || INITIAL_STATE;
  const startAt = Number(base.at) > 0 ? Number(base.at) : ports.clock.now();
  const initialState = normalizeState({
    ...base,
    at: startAt,
    lastReflectAt: Number(base.lastReflectAt) > 0 ? Number(base.lastReflectAt) : startAt,
  });
  let state = initialState;
  let lastError = '';

  function emit(type, payload, at) {
    const row = assertEvent(type, payload, at);
    ports.events.append(row);
    state = reduce(state, row);
    return row;
  }

  /** 一次心跳 = 一条完整因果链。 */
  function tick(at = ports.clock.now()) {
    const trace = { at, phases: [], events: [], decision: null, reflection: null, failed: null };
    try {
      // 1 SENSE：把外部输入变成事件（没有输入也要走，时间照样流）。
      const inputs = ports.sense.poll() || [];
      for (const input of inputs) {
        const type = input?.type || 'message.received';
        const row = emit(type, input?.payload || {}, input?.at ?? at);
        trace.events.push(row);
      }
      trace.phases.push('sense');

      // 2 STATE：心跳本身是事件；由它推进衰减、睡眠与有限性判据。
      trace.events.push(emit('life.tick', { at }, at));
      const needs = finiteNeeds(state, { idleMs: 0 });
      if (needs.shouldSleep) trace.events.push(emit('sleep.started', {}, at));
      else if (needs.shouldWake) trace.events.push(emit('sleep.ended', {}, at));
      // 陈旧目标：只写"事实事件"，status 仍是 active；放不放弃由她决定（C4/A6）。
      const staleGoals = state.goals.filter(
        (g) => g.status === 'active' && !g.stale && at - Number(g.updatedAt) >= goalStaleMs,
      );
      for (const goal of staleGoals) trace.events.push(emit('goal.stale', { id: goal.id }, at));
      trace.phases.push('state');

      // 3 DECIDE：内生意图 + 经验引用（引用本身落事件，R7 可度量）。
      const decision = decide(state, { now: at, contextText: contextText(state), model: opts.model });
      trace.decision = decision;
      trace.events.push(emit('intention.shadow', { selected: decision.selected, reason: decision.reason }, at));
      trace.events.push(emit('decision.context', {
        intention: decision.selected, reason: decision.reason, usedLessonId: decision.usedLessonId,
      }, at));
      // [G1] 进入规划：为这次 plan 锚定一个可观测的事件溯源起点（真实多步执行在 DSH 层循环推进）。
      if (decision.selected === 'plan' && decision.goalId) {
        trace.events.push(emit('plan.started', {
          id: `plan-${decision.goalId}-${at}`,
          goalId: String(decision.goalId),
          text: String(decision.goalText || ''),
        }, at));
      }
      trace.phases.push('decide');

      // 4 ACT：行动由端口执行；是否发消息由执行结果决定，内核不假设。
      const result = ports.act.perform(decision, state, at);
      trace.events.push(emit('action.taken', { intention: decision.selected, ok: result?.ok === true }, at));
      if (result?.sentKey) trace.events.push(emit('message.sent', { key: String(result.sentKey) }, at));
      trace.action = result;
      trace.phases.push('act');

      // 5 MEMORY：巩固 + 遗忘（有限性：不无限膨胀，也不假装全记得）。
      const window = ports.events.since(at - reflectMs);
      const cons = ports.memory.consolidate(window);
      if (cons) trace.events.push(emit('memory.consolidated', { count: cons }, at));
      const stale = finiteNeeds(state, { idleMs: 0 }).staleLessons;
      if (stale.length) {
        ports.memory.forget(stale);
        trace.events.push(emit('memory.forgotten', { ids: stale.map((l) => l.id) }, at));
      }
      trace.phases.push('memory');

      // 6 REFLECT：慢周期；产物立刻进入状态，下一个 tick 的 decide 就能引用。
      if (at - state.lastReflectAt >= reflectMs) {
        const r = reflect(state, ports.events.since(at - reflectWindowMs), { now: at });
        trace.reflection = r;
        for (const lesson of r.lessons) {
          trace.events.push(emit('lesson.formed', lesson, at));
        }
        trace.events.push(emit(r.empty ? 'reflection.failed' : 'reflection.completed', {
          reason: r.empty ? 'no-lesson' : 'formed', windowSize: r.windowSize,
        }, at));
      }
      trace.phases.push('reflect');

      ports.state.save(state);
    } catch (error) {
      lastError = String(error?.message ?? error);
      trace.failed = { phase: trace.phases.at(-1) || 'sense', error: lastError };
    }
    return trace;
  }

  return {
    v: KERNEL_VERSION,
    tick,
    emit,
    /** 从事件流重建：证明"她怎么变成现在这样"完全可解释（与实时状态同源）。 */
    replayFrom: (initial) => replay(ports.events.read(), initial || initialState),
    contractAudit: () => auditEventContracts(),
    eventTypes: EVENT_TYPES,
    get state() { return state; },
    get lastError() { return lastError; },
    ports,
  };
}

export { assertEvent, EVENT_TYPES, EVENT_CONTRACTS, PHASES, auditEventContracts } from './events.mjs';
export { createMemoryPorts, assertPorts, PORT_NAMES, createQQPorts } from './ports.mjs';
export { INITIAL_STATE, reduce, replay, normalizeState, finiteNeeds } from './state.mjs';
export { decide, reflect, matchLesson, INTENTIONS } from './cognition.mjs';
