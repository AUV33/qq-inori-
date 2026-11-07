// 会话模型应用：跟随 DSH / 固定 provider+model / 思考档回退 / 去重 epoch。
//
// 从 app.mjs 的 main() 搬出（P3-RW-54，2026-11-01）。状态 Map/epoch 由 app 持有，
// 本模块只在成功/终态时写 epoch。
/**
 * @param {object} ctx
 */
export function createSessionModel(ctx) {
  const {
    cfg, log, api, unwrap, sleep, modelAppliedSessions, getModelSelectionEpoch,
    REASONING_EFFORT_DEFAULT,
  } = ctx;
  const appliedEffort = new Map();
  async function ensureChatModel(sessionId, effortOverride = null) {
    const wanted = effortOverride ? String(effortOverride) : '';
    if (modelAppliedSessions.get(sessionId) === getModelSelectionEpoch()
      && (!wanted || appliedEffort.get(sessionId) === wanted)) return 'applied';
    // [FOLLOW-DSH] 跟随 DSH 默认模型：不 selectModel，也不把固定模型写进 DSH 全局默认
    // （selectModel 会同时写 ~/.dsh/settings.yaml 的 agent-default-model）。
    // 这样「DSH 里能用的模型，她就一样能用」——DSH 换模型她自动跟着换。
    if (cfg.dsh?.followDshModel === true) {
      modelAppliedSessions.set(sessionId, getModelSelectionEpoch());
      return 'applied';
    }
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    // [TASK-FAST] 任务会话可单独用更低的思考档（默认 medium）：手机/电脑操作是"看一步做一步"，
    // high 每次都要多想几秒，一条流水线十几步就多出十几秒；复杂推理仍可 configuration 调回 high。
    const effort = String(effortOverride || cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    let effortNow = effort;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effortNow }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, getModelSelectionEpoch());
        appliedEffort.set(sessionId, wanted || String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT));
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        // [EFFORT-FALLBACK] 模型不支持这个思考档（如 deepseek-flash 没有 medium）时，
        // 直接回退到 high 一次，不要白等两次失败 + 1s 重试。
        const msg = String(error?.message ?? error);
        if (/does not support reasoning effort/i.test(msg) && effortNow !== 'high') {
          log(`思考档位 ${effortNow} 不受支持，回退 high（${sessionId.slice(0, 8)}）`);
          effortNow = 'high';
        }
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${msg}`);
        if (attempt < 2) await sleep(300);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, getModelSelectionEpoch());
      return 'not-found';
    }
    return 'failed';
  }

  return { ensureChatModel };
}
