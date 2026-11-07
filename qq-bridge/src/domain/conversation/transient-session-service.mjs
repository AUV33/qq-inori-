// 临时会话归档与清理：记录待归档、到点归档、恢复、 pruneMissingSessions、ensureHerWorkspace。
//
// 从 app.mjs 的 main() 搬出（P3-RW-47，2026-11-01）。定时器 Map/会话账本注入同一实例；
// 归档动作只经 getApi().workspace.archiveSession。
/**
 * @param {object} ctx
 */
export function createTransientSession(ctx) {
  const {
    fs, path, log, cfg, STATE_DIR, STATE_DATA_DIR, getApi, unwrap, atomicWriteJson, ensureChatModel,
    isolatedPresetFor, isolatedStatePath, loadBrowse, loadWorks, recordSessionKind,
    saveIsolatedDead, saveState, isolatedSessions, transientArchiveTimers,
    sessionKinds, state, getSocialV2, getDshReady,
    // [WIRING-FIX] 归档时反查 kind / 超时 / gate preset 校验都是 main() 的局部状态，裸引用 → 归档与 gate 会话创建会炸
    isolatedKindBySession, TRANSIENT_IDLE_MS, isolatedDead, getDshPresetIds,
    // [WIRING-FIX] 这几个原来在 main() 里，搬出后模块拿不到 → gate/own-life 循环异常
    learnerSessions, SLANG_SESSION_FILE, getSlangLearnerSessionId, setSlangLearnerSessionId, getCfgRef,
  } = ctx;
  const TRANSIENT_ARCHIVE_FILE = path.join(STATE_DIR, 'transient-archive.json');
  function readTransientArchives() {
    try {
      const arr = JSON.parse(fs.readFileSync(TRANSIENT_ARCHIVE_FILE, 'utf8'));
      return Array.isArray(arr) ? arr.filter((x) => x && typeof x.sessionId === 'string' && typeof x.kind === 'string') : [];
    } catch { return []; }
  }
  function writeTransientArchives(list) {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); atomicWriteJson(TRANSIENT_ARCHIVE_FILE, list); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:2930'); }
  }
  function noteTransientArchive(kind, sid, archiveAt) {
    const list = readTransientArchives().filter((x) => x.sessionId !== sid);
    list.push({ kind, sessionId: sid, archiveAt });
    writeTransientArchives(list);
  }
  function dropTransientArchive(sid) {
    writeTransientArchives(readTransientArchives().filter((x) => x.sessionId !== sid));
  }
  async function archiveTransientNow(kind, sid) {
    try { await getApi().workspace.archiveSession({ sessionId: sid }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:2941'); }
    try {
      if (isolatedSessions.get(kind) === sid) { isolatedSessions.delete(kind); isolatedKindBySession.delete(sid); }
      if (learnerSessions.has(sid)) {
        learnerSessions.delete(sid);
        if (getSlangLearnerSessionId() === sid) setSlangLearnerSessionId(null);
        try { fs.unlinkSync(SLANG_SESSION_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:2947'); }
      }
      try { fs.unlinkSync(isolatedStatePath(kind)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:2949'); }
      dropTransientArchive(sid);
      log(`[transient-archive] ${kind} 临时会话已归档：${sid.slice(0, 8)}`);
    } catch (error) { log(`[transient-archive] 清理失败（已忽略）：${error?.message ?? error}`); }
  }
  function cancelTransientArchive(sessionId) {
    const sid = String(sessionId);
    const t = transientArchiveTimers.get(sid);
    if (t) { clearTimeout(t); transientArchiveTimers.delete(sid); }
    dropTransientArchive(sid);
  }
  function scheduleTransientArchiveAt(sessionId, kind, atMs) {
    const sid = String(sessionId);
    const ex = transientArchiveTimers.get(sid);
    if (ex) { clearTimeout(ex); transientArchiveTimers.delete(sid); }
    const delay = Math.max(0, Number(atMs) - Date.now());
    const timer = setTimeout(async () => {
      transientArchiveTimers.delete(sid);
      await archiveTransientNow(kind, sid);
    }, delay);
    timer.unref?.();
    transientArchiveTimers.set(sid, timer);
    noteTransientArchive(kind, sid, Number(atMs) || (Date.now() + TRANSIENT_IDLE_MS));
  }
  function scheduleTransientArchive(sessionId, kind) {
    scheduleTransientArchiveAt(sessionId, kind, Date.now() + TRANSIENT_IDLE_MS);
  }
  // [TRANSIENT-RESTORE] 桥接重启后：过期的立刻归档，没到点的按剩余时间重挂
  function restoreTransientArchives() {
    const now = Date.now();
    for (const rec of readTransientArchives()) {
      if (!rec?.sessionId || !rec?.kind) continue;
      if (Number(rec.archiveAt) <= now) void archiveTransientNow(rec.kind, rec.sessionId);
      else scheduleTransientArchiveAt(rec.sessionId, rec.kind, Number(rec.archiveAt));
    }
  }
  // [SESSION-CLEAN] 用户在 DSH 里清空了她的会话/工作区后，桥接内存/状态里的旧 sessionId 全部作废。
  async function pruneMissingSessions() {
    const wsFile = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'storages', 'workspace.json');
    let valid = null;
    try {
      const raw = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
      valid = new Set();
      for (const v of Object.values(raw?.tables?.workspaces ?? {})) {
        for (const id of (Array.isArray(v?.sessionIds) ? v.sessionIds : [])) valid.add(String(id));
      }
    } catch { return; }
    let changed = false;
    for (const key of Object.keys(state.sessions || {})) {
      const sid = String(state.sessions[key]);
      if (!valid.has(sid)) {
        delete state.sessions[key];
        if (state.sessionPolicies) delete state.sessionPolicies[key];
        changed = true;
        log(`[session-clean] 会话映射失效，已清除：${key}（${sid.slice(0, 8)}）`);
      }
    }
    if (changed) { try { saveState(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3006'); } }
    for (const kind of ['intake', 'reflect', 'ownlife', 'diary', 'vision', 'gate', 'task']) {
      try {
        const saved = JSON.parse(fs.readFileSync(isolatedStatePath(kind), 'utf8'));
        if (saved?.sessionId && !valid.has(String(saved.sessionId))) {
          try { fs.unlinkSync(isolatedStatePath(kind)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3011'); }
          isolatedSessions.delete(kind);
          log(`[session-clean] ${kind} 隔离会话已失效，缓存已清`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3015'); }
    }
    try {
      const saved = JSON.parse(fs.readFileSync(SLANG_SESSION_FILE, 'utf8'));
      if (saved?.sessionId && !valid.has(String(saved.sessionId))) {
        try { fs.unlinkSync(SLANG_SESSION_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3020'); }
        setSlangLearnerSessionId(null);
        log('[session-clean] 黑话学习会话已失效，缓存已清');
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3024'); }
  }
  // [HER-WORKSPACE] 她的一切会话（聊天 / 隔离 / 任务 / 黑话学习）都挂在同一个工作区。
  const HER_WORKSPACE_DIR = String(cfg.sessionCwd || '').trim() || path.join(STATE_DIR, 'agents');
  const HER_WORKSPACE_TITLE = String(cfg.workspaceTitle || 'QQ 聊天').trim() || 'QQ 聊天';
  let herWorkspacePromise = null;
  function ensureHerWorkspace() {
    if (!herWorkspacePromise) {
      herWorkspacePromise = (async () => {
        fs.mkdirSync(HER_WORKSPACE_DIR, { recursive: true });
        const wsValue = unwrap(await getApi().workspace.create({ path: HER_WORKSPACE_DIR }), 'her workspace.create');
        const id = wsValue.workspace.workspaceId;
        try { await getApi().workspace.rename({ workspaceId: id, title: HER_WORKSPACE_TITLE }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3036'); }
        return id;
      })().catch((error) => { herWorkspacePromise = null; throw error; });
    }
    return herWorkspacePromise;
  }

  async function ensureIsolatedSession(kind, opts = {}) {
    const herWsId = await ensureHerWorkspace();
    // [ISOLATED-REVIVE] force=重建：先归档并丢掉旧 id，再按原流程新建一个
    if (opts.force) {
      try { const old = JSON.parse(fs.readFileSync(isolatedStatePath(kind), 'utf8'))?.sessionId;
        if (old && old !== isolatedSessions.get(kind)) { try { await getApi().workspace.archiveSession({ sessionId: old }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3048'); } }
        if (old) isolatedKindBySession.delete(old);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3050'); }
      isolatedSessions.delete(kind);
      try { fs.unlinkSync(isolatedStatePath(kind)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3052'); }
      log(`[isolated] ${kind} 会话已失效 → 重建`);
    }
    const cached = isolatedSessions.get(kind);
    if (cached) { isolatedKindBySession.set(cached, kind); return cached; }
    const gatePreset = isolatedPresetFor(kind, getCfgRef());
    try {
      const saved = JSON.parse(fs.readFileSync(isolatedStatePath(kind), 'utf8'));
      if (saved?.sessionId) {
        // [HER-WORKSPACE] 旧缓存若属于别的工作区 → 归档重建，别把它留在散落的工作区里。
        if (saved.workspaceId !== herWsId) {
          try { await getApi().workspace.archiveSession({ sessionId: saved.sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3063'); }
        } else if (saved.preset && saved.preset !== gatePreset) {
          try { await getApi().workspace.archiveSession({ sessionId: saved.sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3065'); }
          log(`[isolated] ${kind} 旧会话 preset=${saved.preset} → 归档，按 ${gatePreset} 重建`);
        } else if (kind !== 'gate' || saved.preset === gatePreset) {
          isolatedSessions.set(kind, saved.sessionId);
          isolatedKindBySession.set(saved.sessionId, kind);
          return saved.sessionId;
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3073'); }
    // [GATE] fail-closed：qq-gate preset 缺失时直接拒绝开判定会话（setup-dsh 没装就是没装）
    if (kind === 'gate' && (!Array.isArray(getDshPresetIds()) || !getDshPresetIds().includes('qq-gate'))) {
      log('[gate] qq-gate preset 不可用（DSH 侧未安装？跑一次 scripts/setup-dsh.mjs）→ 注意门本次禁用');
      throw new Error('qq-gate preset 不可用');
    }
    const value = unwrap(
      await getApi().sessions.create({ workspaceId: herWsId, agentPreset: gatePreset }),
      `isolated ${kind} session`,
    );
    if (kind === 'gate') {
      // [GATE] 门判定走 flash（不跟随桥接主模型）：每批几百 token，成本≈0；主模型留给她的会话
      const gmc = getCfgRef()?.gate?.model ?? {};
      await getApi().sessions.selectModel({ sessionId: value.sessionId, provider: gmc.provider || 'deepseek-official', model: gmc.model || 'deepseek-flash', reasoningEffort: 'low' });
    } else {
      await ensureChatModel(value.sessionId);
    }
    // 新建的隔离会话自动命名，避免又出现一堆无标题会话
    try {
      const titleMap = { task: '任务分派', reflect: '夜间反思', ownlife: '自主时间', intake: '每轮学习', vision: '看屏幕', diary: '今日日记', gate: '注意门', groupfact: '群事实抽取' };
      await getApi().callUnary('session/rename', { sessionId: value.sessionId, title: titleMap[kind] || kind });
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'transient-session-service.mjs:3094'); }
    isolatedSessions.set(kind, value.sessionId);
    isolatedKindBySession.set(value.sessionId, kind);
    if (isolatedDead.delete(kind)) saveIsolatedDead(); // 新建成功 = 这个 kind 活了
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(isolatedStatePath(kind), { sessionId: value.sessionId, kind, preset: gatePreset, workspaceId: herWsId, at: Date.now() });
    recordSessionKind(value.sessionId, kind); // [SESSION-RETAIN] 临时 kind 走更短保留期
    log(`[isolated] ${kind} 独立会话已创建（${value.sessionId.slice(0, 8)}）${kind === 'gate' ? '（qq-gate preset + flash）' : ''}`);
    return value.sessionId;
  }

  // ── [TASK-POOL] 任务池：一个任务一个会话（并行上限 + FIFO 队列 + 超时回收）─────
  // 旧实现：所有 handoff 任务挤在**一个**共享任务会话（isolated-task.json）——
  //   多任务被迫串行、上下文互相污染（越攒越大）、台账逐 turn 只能关一条、
  //   无超时/无回收（卡死任务永久挂着，「手头在跑的事」注入成假清单）。
  // 新实现：
  //   - 每个任务开自己的会话（上下文干净、互不污染），池并行上限默认 2
  //   - 池满 → 任务进队列（台账 status=queued，按 at 升序 FIFO），任一会话收尾/超时自动 drain
  //   - 单任务超 taskMaxMs（默认 30min）→ 台账 expired + 归档会话 + drain
  //   - 任务会话 turn 结束（正常/取消/异常）→ 台账回写 + 归档会话 + drain
  //   - 全局并发槽（dsh.maxConcurrentTurns）提到 4：对话侧常占 1-2 槽，池 2 槽，互不饿死

  return {
    readTransientArchives, writeTransientArchives, noteTransientArchive, dropTransientArchive,
    archiveTransientNow, cancelTransientArchive, scheduleTransientArchiveAt,
    scheduleTransientArchive, restoreTransientArchives, pruneMissingSessions, ensureHerWorkspace,
    ensureIsolatedSession, // [WIRING-FIX] app.mjs:1572 的包装函数依赖它，漏导出会让 own-life/gate 全挂
  };
}
