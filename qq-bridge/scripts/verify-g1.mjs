// verify-g1.mjs · G1 长程规划闭环离线验证
// 验证：目标 → decide 选 plan → 多步执行（ReAct 式）→ completed → replay 重建一致；
//       以及失败路径：致命步 → plan.failed。
// 运行：node scripts/verify-g1.mjs
import assert from 'node:assert/strict';
import { createKernel, INITIAL_STATE } from '../src/kernel/index.mjs';
import { createMemoryPorts } from '../src/kernel/ports.mjs';
import { createPlanRunner, createMockStepExecutor, createDSHPlanExecutor } from '../src/kernel/plan-runner.mjs';

async function happyPath() {
  const ports = createMemoryPorts();
  const kernel = createKernel({ ports });

  // 0) 事件契约审计：G1 新增 plan.* 不应有缺口（无消费者 / 阶段非法 / 引用不存在的消费阶段）
  const planGaps = kernel.contractAudit().filter((g) => g.type.startsWith('plan.'));
  assert.equal(planGaps.length, 0, 'plan 事件契约应无缺口: ' + JSON.stringify(planGaps));
  console.log('[contract] plan 事件契约审计通过 ✓');

  // 1) 立一个目标 → tick 触发 decide 选 plan → emit plan.started
  kernel.emit('goal.formed', { id: 'g1', text: '把画世界的画补完' }, 1000);
  const tr = kernel.tick(1000);
  assert.equal(tr.decision?.selected, 'plan', 'decide 应选 plan 意图');
  assert.equal(kernel.state.plans.length, 1, '应生成 1 个 plan');
  assert.equal(kernel.state.plans[0].status, 'active', 'plan 应处于 active');

  // 2) 用 mock 执行器驱动三步（每 tick 推进一步，maxStepsPerPlan=1）
  const runner = createPlanRunner({ kernel, executeStep: createMockStepExecutor(['open_app', 'tap_canvas', 'save']) });
  let at = 1000;
  for (let i = 0; i < 6; i++) {
    at += 1000;
    await runner.tick(at);
    if (kernel.state.plans[0].status !== 'active') break;
  }
  const final = kernel.state.plans[0];
  console.log('[happy] final plan:', JSON.stringify(final, null, 2));
  assert.equal(final.status, 'completed', 'plan 应完成');
  assert.equal(final.steps.length, 3, '应有 3 步');
  assert.ok(final.steps.every((s) => s.ok), '每步都应 ok');

  // 3) 回放一致性：实时状态 == 事件流重建状态（证明可解释/可审计）
  //    注意：replay 不传初值，让内核用与 live 相同的内部初始态（否则绝对时间戳会因起点不同偏移）。
  const replayed = kernel.replayFrom();
  assert.deepEqual(replayed.plans, kernel.state.plans, 'replay 应与实时状态一致');
  console.log('[happy] 回放一致 ✓');
}

async function failedPath() {
  const ports = createMemoryPorts();
  const kernel = createKernel({ ports });
  kernel.emit('goal.formed', { id: 'g2', text: '帮我订外卖' }, 1000);
  kernel.tick(1000);
  assert.equal(kernel.state.plans.length, 1, '应生成 plan');

  // 第二步致命失败
  const runner = createPlanRunner({ kernel, executeStep: createMockStepExecutor([
    { intention: 'open_app', ok: true },
    { intention: 'pay', ok: false, fatal: true, note: '支付被拒' },
  ]) });
  let at = 1000;
  for (let i = 0; i < 4; i++) {
    at += 1000;
    await runner.tick(at);
    if (kernel.state.plans[0].status !== 'active') break;
  }
  const final = kernel.state.plans[0];
  console.log('[failed] final plan:', JSON.stringify(final, null, 2));
  assert.equal(final.status, 'failed', '致命步应导致 plan.failed');
  assert.equal(final.failReason, '支付被拒', '应记录失败原因');
  assert.equal(final.steps.length, 2, '应记录 2 步（含失败步）');
  const replayed = kernel.replayFrom();
  assert.deepEqual(replayed.plans, kernel.state.plans, '失败路径回放也应一致');
  console.log('[failed] 回放一致 ✓');
}

async function dshPath() {
  const ports = createMemoryPorts();
  const kernel = createKernel({ ports });
  kernel.emit('goal.formed', { id: 'g3', text: 'DSH 真实执行' }, 1000);
  kernel.tick(1000);
  assert.equal(kernel.state.plans.length, 1, '应生成 plan');

  // 用 mock runStep 模拟"等待式 DSH 会话"：每步返回 observation，末步带 DONE 标记。
  const script = [
    { observation: '已打开画世界 app' },
    { observation: '已在画布落笔作画' },
    { observation: '画作已保存【DONE】' },
  ];
  const runStep = async (index) => script[index] || { observation: '多余步', done: true };
  const executor = createDSHPlanExecutor({ runStep });
  const runner = createPlanRunner({ kernel, executeStep: executor });

  let at = 1000;
  for (let i = 0; i < 6; i++) {
    at += 1000;
    await runner.tick(at);
    if (kernel.state.plans[0].status !== 'active') break;
  }
  const final = kernel.state.plans[0];
  console.log('[dsh] final plan:', JSON.stringify(final, null, 2));
  assert.equal(final.status, 'completed', 'DSH 驱动应完成');
  assert.equal(final.steps.length, 3, '应有 3 步');
  assert.ok(final.steps[0].observation.includes('打开画世界'), '应把 DSH 回复写回 observation');
  assert.ok(final.steps[2].observation.includes('DONE'), 'DONE 标记应触发完成');
  const replayed = kernel.replayFrom();
  assert.deepEqual(replayed.plans, kernel.state.plans, 'DSH 路径回放也应一致');
  console.log('[dsh] 回放一致 ✓');
}

async function main() {
  await happyPath();
  await failedPath();
  await dshPath();
  console.log('\nG1 长程规划闭环验证全部通过 ✓');
}

main().catch((e) => { console.error('G1 验证失败:', e); process.exit(1); });
