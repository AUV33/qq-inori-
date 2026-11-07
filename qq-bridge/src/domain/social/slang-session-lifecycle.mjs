// 黑话学习者会话失效：清 id、按等待/收集情况移出集合、归档旧会话、删记录。
//
// 从 app.mjs 的 main() 搬出（P3-RW-63，2026-11-01）。状态由 app 持有，getter/setter 读写。
/**
 * @param {object} ctx
 */
export function createSlangSessionLifecycle(ctx) {
  const {
    log, fs, cfg, STATE_DIR, SLANG_SESSION_FILE, learnerSessions, learnerWaiters, learnerCollectors,
    getApi, getSlangLearnerSessionId, setSlangLearnerSessionId, getResolvePresetName,
    ensureHerWorkspace, ensureChatModel, unwrap, readJsonSafe, atomicWriteJson, recordSessionKind,
  } = ctx;
  async function ensureSlangLearnerSession() {
    const herWsId = await ensureHerWorkspace();
    const preset = getResolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });

    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset || saved?.workspaceId !== herWsId) invalidateSlangLearnerSession();
    if (getSlangLearnerSessionId()) {
      learnerSessions.add(getSlangLearnerSessionId());
      getApi().events.follow(getSlangLearnerSessionId());
      return getSlangLearnerSessionId();
    }
    // [WS-MATCH] 必须同时校验工作区：只比 preset 会把别的 workspace 的会话当成本工作区的复用
    if (saved?.sessionId && saved.preset === preset && saved.workspaceId === herWsId) {
      setSlangLearnerSessionId(String(saved.sessionId));
      learnerSessions.add(getSlangLearnerSessionId());
      getApi().events.follow(getSlangLearnerSessionId());
      await ensureChatModel(getSlangLearnerSessionId());
      return getSlangLearnerSessionId();
    }
    const params = { workspaceId: herWsId };
    params.agentPreset = preset;
    const value = unwrap(await getApi().sessions.create(params), 'slang session.create');
    setSlangLearnerSessionId(value.sessionId);
    learnerSessions.add(getSlangLearnerSessionId());
    getApi().events.follow(getSlangLearnerSessionId());
    await ensureChatModel(getSlangLearnerSessionId());
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: getSlangLearnerSessionId(), preset, workspaceId: herWsId });
    recordSessionKind(getSlangLearnerSessionId(), 'slang'); // [SESSION-RETAIN] 学习会话是临时 kind
    log(`黑话学习会话已创建：${getSlangLearnerSessionId()}`);
    return getSlangLearnerSessionId();
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = getSlangLearnerSessionId();
    // [SESSION-GC] 内存里没有 id（刚启动/上轮已清）时，磁盘记录里的旧会话同样要归档，
    // 否则每次 turn error 重建都会在 DSH 会话列表里多留一个孤儿。
    let orphanId = null;
    if (!oldId) {
      try { orphanId = String(readJsonSafe(SLANG_SESSION_FILE, null)?.sessionId ?? '') || null; } catch { orphanId = null; }
    }
    setSlangLearnerSessionId(null);
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    // [SESSION-GC] 重建学习会话时把旧的归档，否则每次 turn error 重建都会在列表里留一个。
    const toArchive = oldId || orphanId;
    if (toArchive) {
      void (async () => {
        try { await getApi().workspace.archiveSession({ sessionId: toArchive }); }
        catch (error) { log(`归档旧学习会话失败: ${error?.message ?? error}`); }
      })();
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'slang-session-lifecycle.mjs:2902'); }
  }

  return { ensureSlangLearnerSession, invalidateSlangLearnerSession };
}
