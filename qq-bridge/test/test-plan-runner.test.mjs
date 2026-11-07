// [MATRIX] plan-runner.mjs 的直接测试：进度只经 kernel.emit，步骤上限/失败/完成语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanRunner, createLoggingStepExecutor, createMockStepExecutor, createDSHPlanExecutor } from '../src/kernel/plan-runner.mjs';

function fakeKernel(plans) {
  const events = [];
  const kernel = {
    state: { plans },
    emit(type, payload) {
      events.push({ type, payload });
      const p = plans.find((x) => x.id === payload.id);
      if (!p) return;
      if (type === 'plan.step') {
        p.steps = [...(p.steps || []), { index: payload.index, ok: payload.ok, observation: payload.observation }];
        p.currentStep = payload.index + 1;
      } else if (type === 'plan.completed') p.status = 'completed';
      else if (type === 'plan.failed') p.status = 'failed';
    },
  };
  return { kernel, events, plans };
}
const active = (id, extra = {}) => ({ id, status: 'active', currentStep: 0, steps: [], ...extra });

test('构造校验：kernel.emit 与 executeStep 缺一不可', () => {
  assert.throws(() => createPlanRunner({ executeStep: async () => ({ ok: true }) }), /kernel/);
  assert.throws(() => createPlanRunner({ kernel: { emit() {} } }), /executeStep/);
});

test('activePlans 只挑 status=active 的 plan', () => {
  const plans = [active('a'), { id: 'b', status: 'completed' }, active('c')];
  const { kernel } = fakeKernel(plans);
  const runner = createPlanRunner({ kernel, executeStep: async () => ({ ok: true, done: true }) });
  assert.deepEqual(runner.activePlans().map((p) => p.id), ['a', 'c']);
});

test('stepPlan 把结果写成 plan.step 事件；done/total 触发 plan.completed', async () => {
  const { kernel, events, plans } = fakeKernel([active('p')]);
  const runner = createPlanRunner({
    kernel,
    executeStep: async (index, plan, ctx) => {
      assert.equal(ctx.lastObservation, index === 0 ? '' : '看到 0', '上一步 observation 必须喂回下一步');
      return { ok: true, intention: `step-${index}`, observation: `看到 ${index}`, total: 2 };
    },
  });
  const r0 = await runner.stepPlan(plans[0], 1);
  assert.equal(r0.more, true);
  assert.ok(events.some((e) => e.type === 'plan.step' && e.payload.index === 0 && e.payload.intention === 'step-0'));
  const r1 = await runner.stepPlan(plans[0], 2);
  assert.equal(r1.more, false);
  assert.equal(events.at(-1).type, 'plan.completed');
  assert.equal(plans[0].status, 'completed');
});

test('executeStep 抛异常 / fatal 步 → plan.failed；非致命失败继续推进', async () => {
  const a = fakeKernel([active('boom')]);
  await createPlanRunner({ kernel: a.kernel, executeStep: async () => { throw new Error('工具炸了'); } }).stepPlan(a.plans[0], 1);
  assert.equal(a.events.at(-1).type, 'plan.failed');
  assert.match(a.events.at(-1).payload.reason, /工具炸了/);
  assert.equal(a.plans[0].status, 'failed');

  const b = fakeKernel([active('fatal')]);
  const rb = await createPlanRunner({ kernel: b.kernel, executeStep: async () => ({ ok: false, fatal: true, note: '不可恢复' }) }).stepPlan(b.plans[0], 1);
  assert.equal(rb.more, false);
  assert.equal(b.events.at(-1).type, 'plan.failed');
  assert.equal(b.events.at(-1).payload.reason, '不可恢复');
  assert.ok(b.events.some((e) => e.type === 'plan.step' && e.payload.ok === false), '失败步也要入链供回放');

  const c = fakeKernel([active('soft')]);
  const rc = await createPlanRunner({ kernel: c.kernel, executeStep: async () => ({ ok: false, fatal: false }) }).stepPlan(c.plans[0], 1);
  assert.equal(rc.more, true);
  assert.equal(c.events.some((e) => e.type === 'plan.failed'), false);
});

test('tick 默认每 plan 最多一步；maxStepsPerPlan 可放大；plan 变非 active 立即停', async () => {
  const { kernel, events, plans } = fakeKernel([active('p1'), active('p2')]);
  const calls = [];
  const runner = createPlanRunner({
    kernel,
    executeStep: async (index, plan) => { calls.push(`${plan.id}:${index}`); return { ok: true, observation: `o${index}`, total: 3 }; },
  });
  assert.equal(await runner.tick(1), 2, '默认每 plan 一步');
  assert.deepEqual(calls, ['p1:0', 'p2:0']);
  assert.equal(events.some((e) => e.type === 'plan.completed'), false);
  assert.equal(await runner.tick(2, { maxStepsPerPlan: 5 }), 4, '每个 plan 再推 2 步后完成');
  assert.equal(events.filter((e) => e.type === 'plan.completed').length, 2);
  assert.equal(await runner.tick(3), 0, '已完成的 plan 不再推进');
});

test('影子执行器只记意图不自终止；mock 执行器跑完列表即 done', async () => {
  const notes = [];
  const shadow = await createLoggingStepExecutor((m) => notes.push(m))(0, { id: 's' });
  assert.equal(shadow.intention, 'shadow.advance');
  assert.equal(shadow.done, undefined, '影子执行器不得自终止（生产须换真实执行器）');
  assert.equal(notes.length, 1);
  const mock = createMockStepExecutor(['open', 'tap']);
  assert.deepEqual((await mock(0)).intention, 'open');
  assert.equal((await mock(1)).total, 2);
  assert.equal((await mock(2)).done, true, '越界即完成');
  assert.equal((await createMockStepExecutor([])(0)).done, true);
});

test('DSH 执行器：done 标记、fatal 透传、异常不致命（防同一步重跑）', async () => {
  assert.throws(() => createDSHPlanExecutor(), /runStep/);
  const ok = createDSHPlanExecutor({ runStep: async () => ({ observation: '搞定【DONE】' }) });
  assert.equal((await ok(0, {}, {})).done, true);
  assert.equal((await ok(0, {}, {})).ok, true);
  const custom = createDSHPlanExecutor({ doneMarkers: ['<FIN>'], runStep: async () => ({ text: '<FIN>' }) });
  assert.equal((await custom(0, {}, {})).done, true);
  const fatal = createDSHPlanExecutor({ runStep: async () => ({ fatal: true, note: '炸' }) });
  assert.equal((await fatal(0, {}, {})).ok, false);
  assert.equal((await fatal(0, {}, {})).fatal, true);
  const logs = [];
  const throwing = createDSHPlanExecutor({ log: (m) => logs.push(m), runStep: async () => { throw new Error('LLM 超时'); } });
  const r = await throwing(0, {}, {});
  assert.equal(r.ok, true, '异常也记为已尝试，避免反复重跑同一条消息');
  assert.equal(r.done, false);
  assert.match(r.observation, /LLM 超时/);
  assert.equal(logs.length, 1);
});
