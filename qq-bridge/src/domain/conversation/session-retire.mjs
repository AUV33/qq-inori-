// 会话退役：停 DSH 工作、清内存缓存、撤销映射、按策略对账。
//
// 从 app.mjs 的 main() 搬出（P3-RW-10，2026-10-31）。这组函数只操作会话映射与相关 Map/Set，
// 不创建会话；所有状态容器由 app 注入（同一批 Map/Set 实例，不能复制）。
import crypto from 'node:crypto';

const OWNER_LANE_SUFFIX = '#owner';

/**
 * @param {object} ctx
 * @param {object} ctx.api
 * @param {(...args:any[])=>void} ctx.log
 * @param {object} ctx.state
 * @param {()=>void} ctx.saveState
 * @param {()=>object} ctx.getOutgoing
 * @param {Map<string,any>} ctx.activeWaits
 * @param {Map<string,number>} ctx.queuedHintAt
 * @param {Map<string,number>} ctx.slangSubmitTimes
 * @param {Map<string,number>} ctx.feedbackTimes
 * @param {Map<string,number>} ctx.wakeConfigMissCount
 * @param {Set<string>} ctx.wakeConfigUpdatedKeys
 * @param {Set<string>} ctx.markReadCalledKeys
 * @param {object} ctx.sessionTelemetry
 * @param {Map<string,string>} ctx.reverse
 * @param {Map<string,any>} ctx.collectors
 * @param {()=>Map<string,any>} ctx.getModelAppliedSessions
 * @param {Set<string>} ctx.sendToolSucceededSessions
 * @param {Map<string,any>} ctx.pendingSendToolCalls
 * @param {Map<string,any>} ctx.waitToolCalls
 * @param {Map<string,number>} ctx.waitStartAt
 * @param {Map<string,number>} ctx.turnWaitMs
 * @param {Map<string,number>} ctx.v2TurnStartAt
 * @param {Map<string,any>} ctx.toolCallNames
 * @param {()=>object} ctx.getSocial
 * @param {()=>object} ctx.getSocialV2
 * @param {Map<string,any>} ctx.pending
 * @param {(entry:any)=>Promise<void>} ctx.cancelPendingEntry
 * @param {(key:string)=>void} ctx.clearSocialV2Timers
 * @param {(key:string)=>void} ctx.cancelSocialTimers
 * @param {(key:string)=>void} ctx.disarmPendingWakeLease
 * @param {Set<string>} ctx.pendingWakeKeys
 * @param {(key:string,token:string)=>void} ctx.rememberAgentToken
 * @param {()=>void} ctx.saveSocialV2State
 * @param {(key:string,sessionId:string)=>boolean} ctx.isCurrentSession
 * @param {(key:string)=>boolean} ctx.isOwnerLaneKey
 * @param {()=>string[]} ctx.getDshPresetIds
 */
export function createSessionRetire(ctx) {
  const {
    api, log, state, saveState, getOutgoing,
    activeWaits, queuedHintAt, slangSubmitTimes, feedbackTimes,
    wakeConfigMissCount, wakeConfigUpdatedKeys, markReadCalledKeys,
    sessionTelemetry, reverse, collectors,
    getModelAppliedSessions, sendToolSucceededSessions, pendingSendToolCalls,
    waitToolCalls, waitStartAt, turnWaitMs, v2TurnStartAt, toolCallNames,
    getSocial, getSocialV2, getPending, cancelPendingEntry,
    clearSocialV2Timers, cancelSocialTimers, disarmPendingWakeLease, pendingWakeKeys,
    rememberAgentToken, saveSocialV2State, isCurrentSession, isOwnerLaneKey, getDshPresetIds,
  } = ctx;
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try {
        const r = await api.stopSessionWork(sessionId);
        if (r?.queueError) log(`⚠️ 旧会话队列读取失败（已继续 cancel）${key}：${r.queueError}`);
      } catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    getOutgoing().clearFailed(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    // [PERM-BY-PERSON] 主会话退役时，owner lane 也一起退役（避免主会话重建后残留旧 admin 会话）
    if (!isOwnerLaneKey(key)) {
      const laneKey = `${key}${OWNER_LANE_SUFFIX}`;
      if (state.sessions[laneKey] || state.sessionPolicies[laneKey]) {
        try { retireSession(laneKey); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'session-retire.mjs:4352'); }
      }
    }
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionTelemetry.forgetSession(sessionId);
    getModelAppliedSessions().delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    waitToolCalls.delete(sessionId);
    waitStartAt.delete(sessionId);
    turnWaitMs.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    getSocial().silentTurns.delete(sessionId);
    getSocial().exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = getPending().get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/session-retire.mjs:123')); }
    getPending().delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = getSocialV2().conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      st.sessionTurns = 0; // [SESSION-ROTATE] 换了会话就从零数
      rememberAgentToken(key, st.agentToken);
      // [ROTATE-NO-BOOTSTRAP] 不重置 bootstrapSent：轮换是"同一个对话换房间"，
      // 重置会让下一条消息触发 bootstrap 唤醒，她会重新自我介绍/重讲一遍（重复输出）。
      // [ROTATE-KEEP-SEEN] 保留 modelSeenSeqs：清空会让"已展示水位"从 2792 掉回 2763，
      // 她随后 qq_mark_read 传看到的 seq 就 400，未读永远清不掉 → 每次唤醒重复注入同一批消息。
      // （原来这里有一行 st.modelSeenSeqs = new Set()，已删；见上。）
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (getDshPresetIds().length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  return { stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies };
}
