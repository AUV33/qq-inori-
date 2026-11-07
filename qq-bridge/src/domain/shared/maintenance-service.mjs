// 运维维护：备份/日志裁剪、会话保留、记忆压缩、向量缓存清理。
//
// 从 app.mjs 的 main() 搬出（P3-RW-32，2026-11-01）。定时器随服务创建启动；
// 所有状态与路径注入，模块不 import app。
/**
 * @param {object} ctx
 */
export function createMaintenance(ctx) {
  const {
    fs, path, cfg, log, state, isolatedSessions, getSlangLearnerSessionId, learnerSessions,
    transientArchiveTimers, getTaskPoolRunning, planRetention, sweepRetention, planStaleArchive, planOrphanRetention,
    HER_WORKSPACE_DIR, sessionKinds, RETENTION_DEFAULTS, dshHomeDir, api, getDshReady,
    MEM_DIR, STATE_DATA_DIR, STATE_DIR, stateDataPath, maintainMemoryDir, pruneUtterances, pruneRaw,
    pruneEmbeddingCaches,
  } = ctx;
  function cleanupOldBackups(dir, days) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.bak-(?:\d{8}(?:-\d{2,4})?|\d{10,})$/.test(f)) continue;
        const file = path.join(dir, f);
        try {
          const st = fs.statSync(file);
          if (Date.now() - st.mtimeMs > days * 86400000) { fs.unlinkSync(file); log(`[cleanup] 删除旧备份 ${f}`); }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7851'); }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7853'); }
  }
  // [ROTATE] 数据日志裁剪：learning-trend（9 万行/9MB）、action-log、evolution 等无界增长 → 保留最近 N 行
  function trimLogTail(file, keep) {
    try {
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      if (lines.length <= keep) return;
      const dropped = lines.length - keep;
      fs.writeFileSync(file, lines.slice(-keep).join('\n') + '\n', 'utf8');
      log(`[rotate] ${path.basename(file)} 裁剪 ${dropped} 行（保留 ${keep}）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7864'); }
  }
  function trimLargeLogs() {
    trimLogTail(stateDataPath('learning-trend.jsonl'), 3000);
    trimLogTail(stateDataPath('action-log.jsonl'), 3000);
    trimLogTail(stateDataPath('evolution.jsonl'), 2000);
    trimLogTail(stateDataPath('style-profile.jsonl'), 400);
    trimLogTail(stateDataPath('lesson-usage.jsonl'), 2000);
    trimLogTail(stateDataPath('self-emotion.jsonl'), 2000);
    // [LOG-ROTATE] crash.log 每分钟一条心跳、embed-errors.log 每次嵌入失败追加一行，
    // 两者原本都无上限。复用同一裁剪器保留尾部（取证看最近，历史不必永久留）。
    if (STATE_DIR) {
      trimLogTail(path.join(STATE_DIR, 'crash.log'), 5000);
      trimLogTail(path.join(STATE_DIR, 'embed-errors.log'), 1000);
    }
  }
  function cleanupBackupsAll() {
    try { trimLargeLogs(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7874'); }
    cleanupOldBackups('qq-bridge/src', 7);
    cleanupOldBackups(MEM_DIR, 7);
    cleanupOldBackups(STATE_DATA_DIR, 7);
    cleanupOldBackups('qq-bridge/roles', 30);
  }
  const cleanupTimer = setInterval(cleanupBackupsAll, 24 * 3600 * 1000);
  cleanupTimer.unref?.();
  try { cleanupBackupsAll(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7882'); }

  // ── [SESSION-RETAIN] 会话目录保留 ──────────────────────────────────────────
  // DSH 没有删会话的 API：archiveSession 只把会话藏起来，session-*.jsonl.zstd 还留在
  // ~/.dsh/sessions/<工作区>/ 下。桥接又是一个任务一个会话、临时会话用完即归档，
  // 于是目录只增不减（实测 4 天 627 个 / 147MB）。这里每天清一次：
  //   1) 已归档 + 不在用 + 超过保留期（聊天类 7 天，临时 kind 1 天）→ 删目录；
  //   2) 未归档但闲置超过 archiveStaleHours 的会话 → 归档（清掉 DSH 侧栏堆积）。
  // kind 账本（session-kinds.json，见 [HER-WORKSPACE] 上方）让「临时会话」能用更短的保留期。
  /** 当前一定不能动的会话：聊天主会话、隔离 kind、黑话学习、待归档临时会话、任务池在跑。 */
  function liveSessionIdSet() {
    const live = new Set();
    for (const sid of Object.values(state.sessions || {})) if (typeof sid === 'string' && sid) live.add(sid);
    for (const sid of isolatedSessions.values()) if (sid) live.add(String(sid));
    if (getSlangLearnerSessionId()) live.add(String(getSlangLearnerSessionId()));
    for (const sid of learnerSessions) if (sid) live.add(String(sid));
    for (const sid of transientArchiveTimers.keys()) live.add(String(sid));
    for (const t of (getTaskPoolRunning() || [])) if (t?.sessionId) live.add(String(t.sessionId));
    return live;
  }
  async function runSessionRetain() {
    const rc = cfg.sessionRetain ?? {};
    if (rc.enabled === false) return;
    const dshHome = dshHomeDir();
    try {
      const plan = planRetention({
        dshHome,
        herWorkspaceDir: HER_WORKSPACE_DIR,
        liveIds: liveSessionIdSet(),
        kinds: sessionKinds,
        days: rc.days ?? RETENTION_DEFAULTS.days,
        ephemeralDays: rc.ephemeralDays ?? RETENTION_DEFAULTS.ephemeralDays,
      });
      const swept = sweepRetention(plan.candidates, { log });
      if (swept.removed) log(`[session-retain] 清掉 ${swept.removed} 个已归档旧会话（${(swept.bytes / 1e6).toFixed(1)}MB）`);
      // [ORPHAN] workspace 登记外的孤儿目录：独立、保守（默认 30 天），只扫她的会话目录。
      if (rc.orphanEnabled !== false) {
        try {
          const orphanPlan = planOrphanRetention({
            dshHome,
            herWorkspaceDir: HER_WORKSPACE_DIR,
            liveIds: liveSessionIdSet(),
            orphanDays: rc.orphanDays ?? RETENTION_DEFAULTS.orphanDays,
            maxDelete: rc.maxOrphanDelete ?? RETENTION_DEFAULTS.maxOrphanDelete,
          });
          const orphanSwept = sweepRetention(orphanPlan.candidates, { log });
          if (orphanSwept.removed) log(`[session-retain] 清掉 ${orphanSwept.removed} 个孤儿会话目录（${(orphanSwept.bytes / 1e6).toFixed(1)}MB）`);
        } catch (error) {
          log(`[session-retain] 孤儿清理失败（已忽略）：${error?.message ?? error}`);
        }
      }
    } catch (error) {
      log(`[session-retain] 清理失败（已忽略）：${error?.message ?? error}`);
    }
    if (!getDshReady()) return; // 归档要走 DSH API，没连上就等下一轮
    try {
      const stale = planStaleArchive({
        dshHome,
        herWorkspaceDir: HER_WORKSPACE_DIR,
        liveIds: liveSessionIdSet(),
        minIdleMs: (Number(rc.archiveStaleHours) || RETENTION_DEFAULTS.archiveStaleHours) * 3600000,
      });
      let archived = 0;
      for (const { sid } of stale.ids) {
        try { await api.workspace.archiveSession({ sessionId: sid }); archived += 1; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7930'); }
      }
      if (archived) log(`[session-retain] 归档 ${archived} 个长期闲置的未归档会话`);
    } catch (error) {
      log(`[session-retain] 归档旧会话失败（已忽略）：${error?.message ?? error}`);
    }
  }
  const sessionRetainTimer = setInterval(
    () => { void runSessionRetain().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/shared/maintenance-service.mjs:128')); },
    Math.max(1, Number(cfg.sessionRetain?.intervalHours) || 12) * 3600 * 1000,
  );
  sessionRetainTimer.unref?.();

  // [MEMORY-COMPACT] 记忆压缩（mem0 consolidation / Generative Agents summary 的确定性版）：
  // 每 6 小时检查各群记忆，把「早于 3 天且超出最近 20 条保留窗」的 group-digest 压成一条摘要（压前备份）。
  // [MEM-MAINT] 记忆维护单一流水线（压缩 → fact 上限 → 归档），实现在 inori-memory-maint.js
  function compactGroupMemories() {
    try {
      const dir = cfg.socialV2?.memoryInject?.dir || cfg.socialV2?.memory?.dir || MEM_DIR;
      const r = maintainMemoryDir(dir, {
        afterDays: 3,
        keepRecentDigests: 20,
        factCap: Math.max(50, Number(cfg.socialV2?.memoryInject?.factCap) || 300),
        archiveAfterDays: Math.max(7, Number(cfg.socialV2?.memoryInject?.archiveAfterDays) || 90),
      });
      if (r.compacted) log(`[memory-compact] ${r.files} 个群文件压缩 ${r.compacted} 条群摘要 → group-compact`);
      if (r.factsArchived) log(`[fact-cap] ${r.factsArchived} 条最旧 fact → _archive（仍可检索）`);
      if (r.consolidatable) log(`[consolidate-shadow] 近重复记忆可合并 ${r.consolidatable} 条（只测量，不写盘）`);
      if (r.archived) log(`[mem-archive] 归档 ${r.archived} 条旧记忆 → _archive/（可检索）`);
      if (r.errors.length) log(`[mem-maint] 部分失败（已忽略）: ${r.errors.slice(0, 3).join('；')}`);
      try {
        const pu = pruneUtterances(cfg.socialV2?.memoryInject?.dir || cfg.socialV2?.memory?.dir || MEM_DIR, { maxAgeDays: 14, maxPerFile: 800 });
        if (pu.removed) log(`[utterance-prune] 剪掉 ${pu.removed} 条旧发言（${pu.files} 个文件）`);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7962'); }
      try {
        const rawDir = path.join(cfg.socialV2?.memoryInject?.dir || cfg.socialV2?.memory?.dir || MEM_DIR, '..', 'raw');
        const pr = pruneRaw(rawDir, { maxAgeDays: 30, maxPerFile: 20000 });
        if (pr.removed) log(`[raw-prune] 剪掉 ${pr.removed} 条超期原文（${pr.files} 个文件）`);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'maintenance-service.mjs:7967'); }
    } catch (e) { log(`[mem-maint] 维护失败（已忽略）: ${e?.message ?? e}`); }
  }
  const compactTimer = setInterval(compactGroupMemories, 6 * 3600 * 1000);
  compactTimer.unref?.();

  // [EMBED-PRUNE] 向量缓存清理：删掉记忆里已不存在条目的向量 / 孤儿缓存文件。
  // 注意：7 天 interval 会被「重启」重置，桥接若一周内重启过几次就永远不会跑——
  // 所以启动 60 秒后再跑一次（幂等、只动缓存文件），别等第一次 7 天到期。
  const pruneEmbedCachesOnce = () => {
    try {
      const dir = cfg.socialV2?.memoryInject?.dir || cfg.socialV2?.memory?.dir || MEM_DIR;
      const r = pruneEmbeddingCaches(dir);
      if (r.dropped || r.removedFiles) log(`[embed-prune] 清掉 ${r.dropped} 条失效向量 / ${r.removedFiles} 个孤儿缓存（${r.files} 个文件）`);
    } catch (e) { log(`[embed-prune] 清理失败（已忽略）: ${e?.message ?? e}`); }
  };
  const embedPruneTimer = setInterval(pruneEmbedCachesOnce, 7 * 24 * 3600 * 1000);
  embedPruneTimer.unref?.();
  setTimeout(pruneEmbedCachesOnce, 60 * 1000).unref?.();

  // [MAINT-FIX] app.mjs 的引导/控制台入口还直接调这两个，必须从服务返回，否则 ReferenceError（11-02 启动崩溃根因）
  return { _cleanupOldBackups: cleanupOldBackups, _trimLogTail: trimLogTail, _liveSessionIdSet: liveSessionIdSet, runSessionRetain, compactGroupMemories };
}
