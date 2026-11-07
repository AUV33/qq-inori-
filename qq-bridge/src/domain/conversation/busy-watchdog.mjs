// 忙回合看门狗：长 turn 让位、幽灵回合自愈、busy 硬上限、任务池巡检。
//
// 从 app.mjs 的 main() 搬出（P3-RW-24，2026-10-31）。只读写传入的 Map/Set 与 social-v2 状态。
/**
 * @param {object} ctx
 */
export function createBusyWatchdog(ctx) {
  const {
    cfg, getDshReady, taskPoolWatchdog, migrateTaskPoolOnce, pruneMissingSessions,
    socialV2, getSocialV2State, isConversationBusyV2, busySinceMs, log, state, collectors,
    v2TurnStartAt, pendingWakeKeys, promptQueues, disarmPendingWakeLease, wakePriorityV2,
    scheduleWakeV2, saveSocialV2State, api, unwrap, getWakeRetryTimers, getWakeRetryCounts,
    turnToolStats, sendToolSucceededSessions, getAutoCancelledKeys, waitToolCalls, waitStartAt,
    turnWaitMs, logAction,
  } = ctx;
  function startBusyWatchdog() {
    const interval = Math.max(30000, Number(cfg.socialV2?.wake?.busyCheckMs) || 60 * 1000);
    const staleMs = Math.max(60000, Number(cfg.socialV2?.wake?.busyStaleMs) || 4 * 60 * 1000);
    // [TURN-MAX] 长 turn 占会话：她在一个 turn 里玩手机（phone_look/tap/macro + sleep + wait）
    // 能跑 7 分钟，期间新消息全排队——用户看到的就是「他都说别的了才开始回上面的」。
    // 规则：turn 跑超 turnMaxMs 且该会话有未读在等 → 强制取消让位（没未读就让她继续跑完）。
    const turnMaxMs = Math.max(30000, Number(cfg.socialV2?.wake?.turnMaxMs) || 60 * 1000);
    let lastPruneAt = 0;
    // [REENTRY] setInterval(async) 没有重入锁：单轮里有多处 await（sessions.list 全量 RPC、
    // 补唤醒、写状态），一旦超过 60s，下一拍会并发进来。两个 tick 同时命中 busy-cap
    // 就会重复 cancel + 重复 scheduleWakeV2（同一批未读被唤醒两次）。
    let watchdogRunning = false;
    const timer = setInterval(async () => {
      if (watchdogRunning) return;
      watchdogRunning = true;
      // 同一拍内只拉一次会话列表：旧实现每个会话拉一次全量 list，O(N) 次 RPC。
      let sessionStateCache;
      async function sessionRunning(sid) {
        if (sessionStateCache === undefined) {
          try {
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const items = Array.isArray(list) ? list : (list?.items ?? []);
            sessionStateCache = new Map(items.map((s) => [s?.sessionId, s?.running === true]));
          } catch { sessionStateCache = null; /* 查不到 = 未知，按在跑处理，下轮再试 */ }
        }
        if (!sessionStateCache) return null;
        return sessionStateCache.get(sid) === true;
      }
      try {
        if (!getDshReady()) return;
        // [TASK-POOL] 任务池超时巡检 + 启动迁移（幂等；任务会话不在 socialV2.conversations 里，单独看）
        void taskPoolWatchdog().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/busy-watchdog.mjs:47'));
        void migrateTaskPoolOnce().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/busy-watchdog.mjs:48'));
        // [SESSION-CLEAN] 每 10 分钟清一次失效会话映射（GUI 手删会话不必等重启）
        if (Date.now() - lastPruneAt > 10 * 60 * 1000) {
          lastPruneAt = Date.now();
          void pruneMissingSessions().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/busy-watchdog.mjs:52'));
        }
        for (const key of socialV2.conversations.keys()) {
          const st = getSocialV2State(key);
          if (!isConversationBusyV2(key, st)) {
            busySinceMs.delete(key);
            continue;
          }
          // [BUSY-CAP] 任何 busy 组合的硬上限：看门狗原有两条路径会静默 continue——
          // ① sid 缺失/无 startedAt（busy 源是 promptQueues 的 running 或 pendingWakeKeys，
          //   而这两个标志没有 turn/end 对应清理，挂了就永远 busy）；
          // ② DSH 侧 running 恒 true（模型调用挂死，running 判断无上限，一直 defer）。
          // 实测后果：group:123456789 卡 45+ 分钟，30 条未读 + @ 全被堵死，每 75s 空转一条
          // wake-retry 日志。上限：超过 busyCapMs 强制释放全部本地 busy 源并补发最高优先级暂存。
          const nowMs = Date.now();
          const since = busySinceMs.get(key);
          const busyCapMs = Math.max(600000, Number(cfg.socialV2?.wake?.busyCapMs) || 15 * 60 * 1000);
          if (!since) busySinceMs.set(key, nowMs);
          else if (nowMs - since > busyCapMs) {
            log(`[busy-cap] ${key} busy 已持续 ${Math.round((nowMs - since) / 60000)} 分钟，强制解除（busy 源: sid=${state.sessions[key] || '无'}, queue=${promptQueues.has(key) ? `有(${promptQueues.get(key)?.queue?.length ?? 0}条)` : '无'}, pendingWakeKeys=${pendingWakeKeys.has(key) ? '是' : '否'}）`);
            const sid = state.sessions[key];
            if (sid) { collectors.delete(sid); v2TurnStartAt.delete(sid); }
            pendingWakeKeys.delete(key);
            const qe = promptQueues.get(key);
            if (qe) { qe.running = false; qe.queue.length = 0; promptQueues.delete(key); }
            st.pendingWakeTimer = null; st.sleepTimer = null; st.replyCheckTimer = null; st.proactiveTimer = null;
            disarmPendingWakeLease(key);
            busySinceMs.delete(key);
            const stashed = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.splice(0) : [];
            const best = stashed.map((i) => i?.reason).filter(Boolean)
              .reduce((a, b) => (wakePriorityV2(b) > wakePriorityV2(a) ? b : a), 'recovery');
            scheduleWakeV2(key, best);
            saveSocialV2State();
            continue;
          }
          const sid = state.sessions[key];
          const startedAt = sid ? (Number(v2TurnStartAt.get(sid)) || 0) : 0;
          // [BUSY-GHOST] busy 但没有 turn 开始标记：多半是 DSH 重启把回合杀了，
          // turn/end 永远不会来，而 wake-retry / pendingWakeKeys 还挂着 busy。
          // 老逻辑在这里直接 continue，只能等 15 分钟 busy-cap——这就是"她突然不回私聊"的根因。
          // 自愈：busy 超过 15 秒且 DSH 侧没有在跑 → 清 busy + 重置 recovery 去重 + 补唤醒。
          if (!startedAt) {
            // 已有一个批量唤醒定时器在等（通常 5 秒内触发）→ 这不是幽灵，别取消它
            if (st.pendingWakeTimer) continue;
            const sinceMs0 = since || nowMs;
            if (nowMs - sinceMs0 >= 15000) {
              let running0 = false;
              if (sid) {
                running0 = await sessionRunning(sid);
                if (running0 === null) running0 = true; /* 查不到先当在跑，下轮再试 */
              }
              if (!running0) {
                pendingWakeKeys.delete(key);
                if (sid) { collectors.delete(sid); v2TurnStartAt.delete(sid); }
                // 兜底重试定时器也要取消，否则 20s 后它会再补一次，造成重复唤醒。
                // 槽位键是 `${key}\0${seq}`，这个会话所有 seq 的兜底都要清。
                try {
                  const timers = getWakeRetryTimers();
                  const counts = getWakeRetryCounts();
                  for (const [rid, t] of [...timers]) {
                    if (!String(rid).startsWith(`${key}\u0000`)) continue;
                    clearTimeout(t); timers.delete(rid); counts.delete(rid);
                  }
                } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'busy-watchdog.mjs:7739'); }
                const q0 = promptQueues.get(key);
                if (q0) { q0.running = false; q0.queue.length = 0; promptQueues.delete(key); }
                try { if (st.pendingWakeTimer) { clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; } } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'busy-watchdog.mjs:7742'); }
                disarmPendingWakeLease(key);
                busySinceMs.delete(key);
                try { st.recoveryForSeq = 0; saveSocialV2State(); } catch (error) { log(`[busy-ghost] 保存 recoveryForSeq 失败: ${error?.message ?? error}`); }
                const stashedG = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.splice(0) : [];
                const bestG = stashedG.map((i) => i?.reason).filter(Boolean)
                  .reduce((a, b) => (wakePriorityV2(b) > wakePriorityV2(a) ? b : a), 'recovery');
                log(`[busy-ghost] ${key} busy ${Math.round((nowMs - sinceMs0) / 1000)}s 但没有进行中的回合，DSH 侧不在跑 → 强制解除并补发唤醒（${bestG}）`);
                scheduleWakeV2(key, bestG);
                continue;
              }
            }
            continue;
          }
          const busyMs = Date.now() - startedAt;
          const unread = Array.isArray(st.unread) ? st.unread.length : 0;
          // [TURN-MAX] 让位条件：本轮 turn 开始后进来的未读（说明用户在她做事期间发话了）。
          // 不能用"新鲜度"判断——实测 148 秒后这个窗口就失效了，她玩 3 分钟手机全程不让位。
          const latestUnreadAt = unread > 0 ? (Number(st.unread[unread - 1]?.time) || 0) : 0;
          const arrivedDuringTurn = unread > 0 && latestUnreadAt > startedAt;
          // [WAIT-HOLD] 等待不算「霸占会话」：qq_wait_for_messages 是她在做正事（合批/收尾观察）。
          // 旧行为把等 60s 算进 45s 上限，于是每一轮都在「等消息 → 被掐」之间循环，一条都发不出去
          //（10/28 21:48–23:27 群里 0 发送、154 次让位取消全是这么来的）。
          // 这里只扣等待时间；墙钟另有 4×turnMaxMs 的绝对上限，防止她用连等无限续命。
          const waitInflightNow = (waitToolCalls.get(sid)?.size ?? 0) > 0;
          const waitInflightStart = Number(waitStartAt.get(sid)) || 0;
          const waitedSoFarMs = (Number(turnWaitMs.get(sid)) || 0)
            + (waitInflightNow && waitInflightStart > 0 ? Math.max(0, Date.now() - waitInflightStart) : 0);
          const activeBusyMs = Math.max(0, busyMs - waitedSoFarMs);
          // [PHONE-BUDGET] 手机操作天然比聊天重：macro 里一个 sleep 就 8–20 秒、截图/识别也要时间。
          // 按本轮 mcp__phone__* 调用数放宽预算，否则 45s 一到就把她正在操作的手砍掉（实测 23:26/23:29 两次）。
          // 只放宽"手机参与"的回合；纯聊天仍是 turnMaxMs。硬上限同步放大，防止无限续命。
          const turnNamesThisTurn = turnToolStats.get(sid)?.names;
          const phoneCallsThisTurn = turnNamesThisTurn instanceof Set
            ? [...turnNamesThisTurn].filter((n) => String(n).startsWith('mcp__phone__')).length
            : 0;
          const phoneBudgetMs = Math.min(120000, phoneCallsThisTurn * 20000);
          const effectiveTurnMaxMs = turnMaxMs + phoneBudgetMs;
          const hardCapMs = effectiveTurnMaxMs * 4;
          // ① 长 turn + 期间有新消息 → 强制取消让位
          const spokeThisTurn = sendToolSucceededSessions.has(sid);
          // [CONTINUITY] 已经开口说话的回合不按硬取消（那是打断对话）；只有跑超过 3 倍上限才强制收场
          const overActiveBudget = activeBusyMs >= effectiveTurnMaxMs && arrivedDuringTurn && !(spokeThisTurn && activeBusyMs < effectiveTurnMaxMs * 3);
          if (overActiveBudget || busyMs >= hardCapMs) {
            // [AUTO-CANCEL] 标记这是系统让位取消：turn/end(aborted) 时不要给 QQ 发「⏹️ 已停止」
            getAutoCancelledKeys().add(key);
            // [BUSY-WATCH-LOG] 让位取消要留够证据：她这一轮已经做了什么、为什么被打断、之后重排什么
            const turnStats = turnToolStats.get(sid) || { ok: 0, fail: 0 };
            const sentThisTurn = sendToolSucceededSessions.has(sid);
            let cancelledOk = false;
            try {
              await api.callUnary('session/cancel', { sessionId: sid });
              cancelledOk = true;
            } catch (error) {
              log(`[busy-watch] ${key} 取消长 turn 失败（继续走兜底）: ${error?.message ?? error}`);
            }
            const stashed0 = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.splice(0) : [];
            const best0 = stashed0.map((i) => i?.reason).filter(Boolean)
              .reduce((a, b) => (wakePriorityV2(b) > wakePriorityV2(a) ? b : a), 'recovery');
            const detail = `回合 ${Math.round(busyMs / 1000)}s（有效 ${Math.round(activeBusyMs / 1000)}s / 上限 ${Math.round(effectiveTurnMaxMs / 1000)}s，其中手机操作 ${phoneCallsThisTurn} 次放宽 +${Math.round(phoneBudgetMs / 1000)}s，等待 ${Math.round(waitedSoFarMs / 1000)}s 不计）· 未读 ${unread} 条在等 · 本回合已开口=${sentThisTurn ? '是' : '否'} · 工具 ok=${Number(turnStats.ok) || 0}/fail=${Number(turnStats.fail) || 0} · 醒来原因=${String(st.lastWakeReason || '-')} · 重排=${best0}${cancelledOk ? '' : '（取消失败）'}`;
            log(`[busy-watch] ${key} 让位取消：${detail}`);
            try { logAction({ t: 'turn_cancel', key, why: 'busy-watch', busyMs, activeBusyMs, waitedMs: waitedSoFarMs, unread, sent: sentThisTurn, tools: { ok: Number(turnStats.ok) || 0, fail: Number(turnStats.fail) || 0 }, wakeReason: String(st.lastWakeReason || ''), refire: best0, cancelled: cancelledOk }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'busy-watchdog.mjs:7803'); }
            collectors.delete(sid);
            v2TurnStartAt.delete(sid);
            waitToolCalls.delete(sid);
            waitStartAt.delete(sid);
            turnWaitMs.delete(sid);
            pendingWakeKeys.delete(key);
            disarmPendingWakeLease(key);
            scheduleWakeV2(key, best0);
            continue;
          }
          // ② 忙超 staleMs → 问 DSH 是否真的还在跑，不在跑就是幽灵回合
          if (busyMs < staleMs) continue;
          const running = await sessionRunning(sid);
          if (running !== false) continue; // true=真在跑；null=查不到，保守不动
          collectors.delete(sid);
          v2TurnStartAt.delete(sid);
          pendingWakeKeys.delete(key);
          disarmPendingWakeLease(key);
          log(`[busy-watch] ${key} 已忙 ${Math.round(busyMs / 1000)} 秒但 DSH 侧不在跑，强制解除 busy`);
          const stashed = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.splice(0) : [];
          const best = stashed.map((i) => i?.reason).filter(Boolean)
            .reduce((a, b) => (wakePriorityV2(b) > wakePriorityV2(a) ? b : a), 'recovery');
          scheduleWakeV2(key, best);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'busy-watchdog.mjs:7834'); }
      finally { watchdogRunning = false; }
    }, interval);
    timer.unref?.();
  }

  return { startBusyWatchdog };
}
