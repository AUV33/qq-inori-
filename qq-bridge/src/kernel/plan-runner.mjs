// plan-runner.mjs · G1 长程规划执行器
//
// 干什么：驱动一个 active plan 的逐步执行（ReAct 式 observe→act→emit）。
//   - 内核只负责 plan 状态的事件溯源（plan.started/step/completed/failed），不直接执行任何外部动作。
//   - 真实"执行"由调用方注入的 executeStep 完成（qq_* 工具 / 影子桩 / mock）。
// 为什么：把"长程规划闭环"落在内核纪律内——任何进度只经 kernel.emit 写入，reducer 是唯一状态入口，
//         replay(events) 即权威状态；内核本身保持零模型依赖。
// 接入点：在 app.mjs 的 shadowKernel onTick 里门控挂载（默认关闭），或将来由 social-loop/DSH 接管真实执行器。
//
// 事件契约（见 events.mjs）：
//   plan.started   → decide 阶段已由 cognition 触发（本模块不负责）
//   plan.step      → 每执行一步 emit（带 index/intention/ok/note/observation）
//   plan.completed → 全部步骤完成
//   plan.failed    → 致命步失败

/**
 * 创建 plan 执行器。
 * @param {object} deps
 * @param {object} deps.kernel           内核实例（需有 emit / state）
 * @param {Function} deps.executeStep    调用方注入的步骤执行器：async (index, plan, ctx) => ({
 *                                          ok: boolean,
 *                                          intention?: string,     // 这一步实际执行的意图（记录用）
 *                                          note?: string,          // 备注
 *                                          observation?: string,   // 观察到的反馈（喂回下一步）
 *                                          done?: boolean,         // 显式标记完成
 *                                          total?: number,         // 总步数（达到则完成）
 *                                          fatal?: boolean,        // 致命失败→emit plan.failed
 *                                        })
 * @returns {{ tick: Function, activePlans: Function, stepPlan: Function }}
 */
export function createPlanRunner({ kernel, executeStep }) {
  if (!kernel || typeof kernel.emit !== 'function') throw new Error('plan-runner 需要 kernel 实例（含 emit）');
  if (typeof executeStep !== 'function') throw new Error('plan-runner 需要 executeStep 回调');

  function activePlans() {
    return (kernel.state?.plans || []).filter((p) => p.status === 'active');
  }

  // 推进单个 plan 的下一步；通过 kernel.emit 写回，绝不自己改 kernel.state。
  // 返回 { more: boolean, result }。
  async function stepPlan(plan, at) {
    const index = Number(plan.currentStep) || 0;
    let res;
    try {
      res = await executeStep(index, plan, { at, kernel, lastObservation: (plan.steps || []).slice(-1)[0]?.observation || '' });
    } catch (error) {
      kernel.emit('plan.failed', { id: plan.id, reason: `executeStep 异常: ${error?.message ?? error}` });
      return { more: false, result: { ok: false, error } };
    }

    const ok = Boolean(res?.ok);
    const done = Boolean(res?.done) || (typeof res?.total === 'number' && index + 1 >= res.total);
    const fatal = Boolean(res?.fatal);

    // 写回这一步（注意：observation 留给后续步骤的 executeStep 通过 ctx 读取，这里只入链供回放）
    kernel.emit('plan.step', {
      id: plan.id,
      index,
      intention: String(res?.intention || 'unknown'),
      ok,
      note: String(res?.note || ''),
      observation: String(res?.observation || ''),
    });

    if (!ok && fatal) {
      kernel.emit('plan.failed', { id: plan.id, reason: String(res?.note || 'step failed (fatal)') });
      return { more: false, result: { ok: false } };
    }
    if (done) {
      kernel.emit('plan.completed', { id: plan.id });
      return { more: false, result: { ok } };
    }
    return { more: true, result: { ok } };
  }

  // 每 tick 驱动：对每个 active plan 推进最多 maxStepsPerPlan 步（默认 1，避免长时间阻塞一个 tick）。
  async function tick(at = Date.now(), opts = {}) {
    const maxSteps = Math.max(1, Number(opts.maxStepsPerPlan) || 1);
    let progressed = 0;
    for (const plan of activePlans()) {
      for (let i = 0; i < maxSteps; i++) {
        const cur = (kernel.state?.plans || []).find((p) => p.id === plan.id);
        if (!cur || cur.status !== 'active') break;
        const { more } = await stepPlan(cur, at);
        progressed++;
        if (!more) break;
      }
    }
    return progressed;
  }

  return { tick, activePlans, stepPlan };
}

/**
 * 影子/演示用执行器：不执行真实外部动作，只把"意图"记下来，用于让 shadowKernel 跑通 plan 生命周期
 * （验证事件溯源/可回放）。真实生产应替换为接 qq_* 工具的执行器（见 g1-plan.md §4）。
 */
export function createLoggingStepExecutor(log = () => {}) {
  return async (index, plan) => {
    const note = `影子推进：plan=${plan.id} step=${index}`;
    log(note);
    // 影子模式下无法知道"总共几步"，由调用方的 plan 语义决定何时完成；
    // 这里默认每步都继续，直到外部 emit plan.completed/failed 或 steps 触顶（reducer 封顶 50）。
    // 注意：logging 执行器不返回 done/total，故 plan 不会自终止——仅用于验证内核闭环，生产须替换为真实执行器。
    return { ok: true, intention: 'shadow.advance', note, observation: `已记录第 ${index} 步` };
  };
}

/**
 * 测试/演示用执行器：基于预定义步骤列表逐步返回，跑完即完成。
 * @param {Array} steps  形如 ['open_app', { intention:'tap', ok:true }, ...] ；空数组或越界→done。
 */
export function createMockStepExecutor(steps = []) {
  return async (index) => {
    const step = steps[index];
    if (step == null) return { ok: true, done: true, intention: 'none', note: '无更多步骤' };
    if (typeof step === 'string') return { ok: true, intention: step, note: '', total: steps.length };
    return {
      ok: step.ok !== false,
      intention: step.intention || `step-${index}`,
      note: step.note || '',
      observation: step.observation || '',
      done: Boolean(step.done),
      total: step.total ?? steps.length,
      fatal: Boolean(step.fatal),
    };
  };
}

/**
 * 真实执行器：每步驱动一次 DSH 会话（LLM 决策并调用 qq_* 工具），等待式拿到结果作为 observation。
 * @param {object} deps
 * @param {Function} deps.runStep  调用方注入的一步执行：async (index, plan, ctx) => ({ ok?, intention?, observation?, note?, done?, fatal? })
 *                                  内部用 api.sessions.prompt 等待式会话，返回 LLM 回复/工具结果。
 * @param {string[]} [deps.doneMarkers] 回复中出现即视为任务完成（默认含【DONE】/完成 等）。
 * @param {Function} [deps.log]
 *
 * 设计要点（防重跑）：DSH 步骤一旦执行即视为"已尝试"——除非 runStep 显式 fatal:true，否则返回 ok:true 让 plan-runner 推进 currentStep，
 * 避免对同一步无限重试（重跑可能重复发消息）。真实失败由 LLM 在回复里用【FAIL】/【DONE】表达（由 runStep 译成语义）。
 */
export function createDSHPlanExecutor({ runStep, doneMarkers = ['【DONE】', '[DONE]'], log = () => {} } = {}) {
  if (typeof runStep !== 'function') throw new Error('createDSHPlanExecutor 需要 runStep 回调');
  const markers = Array.isArray(doneMarkers) && doneMarkers.length ? doneMarkers : ['【DONE】', '[DONE]'];
  return async (index, plan, ctx) => {
    let r;
    try {
      r = await runStep(index, plan, ctx);
    } catch (error) {
      log(`runStep 异常（第 ${index} 步）: ${error?.message ?? error}`);
      // 执行器异常：不致命，记为已尝试并带出 observation，让 plan 继续/由后续步骤决定走向。
      return { ok: true, intention: 'dsh-step', observation: `runStep 异常: ${error?.message ?? error}`, note: '执行器异常', done: false };
    }
    const observation = String(r?.observation ?? r?.text ?? '');
    const done = Boolean(r?.done) || markers.some((m) => observation.includes(m));
    const fatal = Boolean(r?.fatal);
    // 默认 ok:true（已尝试），仅当 runStep 显式 fatal 才 ok:false → plan-runner 触发 plan.failed。
    return {
      ok: !fatal,
      intention: String(r?.intention || 'dsh-step'),
      observation,
      note: String(r?.note || ''),
      done,
      fatal,
    };
  };
}
