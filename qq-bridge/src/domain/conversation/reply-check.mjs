// 回复检查与静默缺席计数：强触发回合没开口 → streak；说完了 → 30s 后查一次未读。
//
// 从 app.mjs 的 main() 搬出（P3-RW-17，2026-10-31）。状态都在传入的 st/socialV2 上，
// 本模块只安排/取消定时器，不自己持有会话。
/**
 * @param {object} ctx
 */
export function createReplyCheck(ctx) {
  const {
    getCurrentMode, getSocialV2State, saveSocialV2State, log, cfg, socialV2,
    recentTaskReportAt, sendWakePromptV2, pendingWakeKeys, promptQueues, state,
    v2TurnStartAt, collectors, OWNER_LANE_SUFFIX,
  } = ctx;
  function noteSilentTurnEndV2(key) {
    try {
      if (getCurrentMode() !== 'reserved2') return;
      const stS = getSocialV2State(key);
      const reasonRoot = String(stS.lastWakeReason || '').split(':')[0];
      const strong = ['atMention', 'nameMention', 'poke', 'question', 'keyword', 'aboutSelf', 'topicMention'];
      if (!strong.includes(reasonRoot)) return; // 非强触发（recovery/timeout/proactiveCheck…）不算「被叫到」
      if ((Number(stS.lastAiReplyAt) || 0) > (Number(stS.silentRef) || 0)) return; // 本回合开过口（或基准未知，不误伤）
      stS.silentStreak = (Number(stS.silentStreak) || 0) + 1;
      log(`[silent-guard] ${key} 强触发 (${stS.lastWakeReason}) 回合收口未开口，连续缺席 ${stS.silentStreak}`);
      saveSocialV2State();
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reply-check.mjs:11263'); }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || getCurrentMode() !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      // [REPLY-CHECK] 没有新消息就别跑 turn：之前无条件唤醒，30 秒后一个
      // reasoning-max 的 turn 会把会话占住 20–60 秒，期间新消息只能排队，
      // 表现就是「他都说别的了才开始回上面的」。
      const cur = getSocialV2State(key);
      const unread = Array.isArray(cur?.unread) ? cur.unread.length : 0;
      // [DEDUP] 5 分钟内刚交过任务：task 会话会自己回报，主会话别再提一遍
      if (Date.now() - (recentTaskReportAt.get(key) || 0) < 5 * 60 * 1000) {
        log(`[reserved2] replyCheck ${key}：任务刚交付/汇报，跳过以免重复说`);
        return;
      }
      if (!unread) {
        log(`[reserved2] replyCheck ${key}：没有新消息，跳过（不占会话）`);
        return;
      }
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid && (v2TurnStartAt.has(sid) || collectors.has(sid))) return true;
    // owner lane 的 turn 也算这个会话在忙，避免同群双开两个会话同时说话
    const laneSid = state.sessions[`${key}${OWNER_LANE_SUFFIX}`];
    if (laneSid && (v2TurnStartAt.has(laneSid) || collectors.has(laneSid))) return true;
    return false;
  }

  return { noteSilentTurnEndV2, cancelReplyCheckV2, scheduleReplyCheckV2, isConversationBusyV2 };
}
