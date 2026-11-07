// 中控台/唤醒优先级/逐条回 @：controlRoom 注入、at-split 队列。
//
// 从 app.mjs 的 main() 搬出（P3-RW-33，2026-11-01）。只读写 social-v2 的 atSplit 字段，
// 投递仍走 sendWakePromptV2。
/**
 * @param {object} ctx
 */
export function createControlRoom(ctx) {
  const {
    socialV2, isSessionAllowedInCurrentMode, isConversationBusyV2, buildScenes,
    isolatedSessions, renderOpsLine, turnDispatch, maxConcurrentTurns, log, cfg,
    pruneSplitQueue, isDirectedAtAi, saveSocialV2State, getSocialV2State, sendWakePromptV2,
  } = ctx;
  function controlRoomLineFor(currentKey) {
    try {
      const convs = {};
      for (const [k, st2] of socialV2.conversations) {
        if (k !== currentKey && !isSessionAllowedInCurrentMode(k)) continue; // 白名单外的不算进"手头会话"
        convs[k] = st2;
      }
      const runningKeys = [];
      for (const [k, st2] of socialV2.conversations) {
        if (isConversationBusyV2(k, st2)) runningKeys.push(k);
      }
      const scenes = buildScenes(convs, { runningKeys });
      const background = [...isolatedSessions.keys()].slice(0, 4);
      // [CONVERSATIONS] 已负责"谁在等我"；这里只补调度事实，避免两份会话清单重复占 token
      const text = renderOpsLine({
        activeTurns: turnDispatch.occupancy(),
        maxTurns: maxConcurrentTurns(),
        queued: turnDispatch.stats().queued,
        background,
      });
      // [CONTROL-ROOM] 可机检：记一条注入日志（最多 1 分钟一条，别刷屏）
      try {
        const manyScenes = scenes.filter((x) => x.unread > 0 || x.running).length;
        if (scenes.length > 1 && Date.now() - (globalThis.__ctrlRoomLoggedAt || 0) > 60000) {
          globalThis.__ctrlRoomLoggedAt = Date.now();
          log(`[control-room] 注入（会话 ${scenes.length} 个，活跃 ${manyScenes} 个，后台 ${background.length} 个，回合 ${turnDispatch.occupancy()}/${maxConcurrentTurns()}，排队 ${turnDispatch.stats().queued}）`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'control-room-service.mjs:11487'); }
      return text ? `${text}\n\n` : '';
    } catch { return ''; }
  }

  const WAKE_PRIORITY = {
    private: 100,
    aboutSelf: 95,
    atMention: 90,
    taskHandoff: 92, // [TASK-NOTICE] 刚把活交出去：要跟他说一声
    taskDone: 92,    // [TASK-NOTICE] 活做完了：要汇报
    topicMention: 85,
    continueChat: 82, // [JOIN] 她刚说过、别人接着说 → 接着聊
    atSplit: 88,      // [AT-SPLIT] 逐条回：一条一条排队回 @
    question: 80,
    joinTopic: 78, // [JOIN] 活跃群里给她一次插话机会
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // ── [AT-SPLIT] 群聊多条 @ 拆成逐条回 ──────────────────────────────────────
  // 为什么：一次唤醒把攒着的 @ 合并成一个回合，她会一次性回一堆；改成「一条一条排队」：
  //   首条照常唤醒，其余进 st.atSplitQueue；每个回合结束后隔 6~14 秒派下一条（直接投递，不走 debounce 合并）。
  function directedUnreadList(st) {
    const list = Array.isArray(st?.unread) ? st.unread : [];
    return list
      .filter((m) => m && !m.isSelf)
      .filter((m) => isDirectedAtAi(String(m.plain || m.text || '')))
      .map((m) => ({ seq: Number(m.seq) || 0, sender: String(m.sender || ''), text: String(m.plain || m.text || '').slice(0, 160) }))
      .filter((m) => m.seq > 0);
  }

  function armAtSplit(key, st, reason) {
    try {
      const a = cfg.socialV2?.atSplit || {};
      if (a.enabled === false) return null;
      if (!String(key).startsWith('group:')) return null;
      if (Array.isArray(st.atSplitQueue) && st.atSplitQueue.length) {
        // 已有队列：焦点被读掉时推进到下一条还活着的 @（以前是整队清空，后面的 @ 就永远没人回了）
        const pruned = pruneSplitQueue(st.atSplitQueue, (Array.isArray(st.unread) ? st.unread : []).map((m) => m && m.seq));
        if (!pruned.queue.length) {
          st.atSplitQueue = []; st.atSplitFocus = 0; st.atSplitSender = '';
        } else {
          st.atSplitQueue = pruned.queue;
          st.atSplitFocus = pruned.focus;
          if (pruned.changed) log(`[at-split] ${key} 焦点已被读掉，推进到下一条 seq=${pruned.focus}（剩 ${pruned.queue.length} 条）`);
          return null;
        }
      }
      const root = String(reason || '').split(':')[0];
      if (!['atMention', 'nameMention', 'question', 'aboutSelf', 'topicMention', 'keyword'].includes(root)) return null;
      const max = Math.max(1, Math.min(5, Number(a.maxPerWake) || 3));
      const list = directedUnreadList(st);
      if (list.length < 2) return null;
      const pick = list.slice(-max);
      st.atSplitQueue = pick.map((x) => x.seq);
      st.atSplitFocus = pick[0].seq;
      st.atSplitSender = pick[0].sender;
      saveSocialV2State();
      log(`[at-split] ${key} 发现 ${list.length} 条点她的消息 → 拆成逐条回（首条 seq=${pick[0].seq}，队列 ${pick.length} 条）`);
      return pick;
    } catch { return null; }
  }

  /** 回合结束：把刚回完的那条出队，隔几秒直接投下一条 */
  function scheduleNextAtSplit(key, opts = {}) {
    try {
      const st = getSocialV2State(key);
      const q = Array.isArray(st.atSplitQueue) ? st.atSplitQueue.slice() : [];
      if (!q.length) return;
      // 只有这一回合真的开口回了，才把焦点那条出队；憋着没回的不动，等下次唤醒重新派。
      // 但连续两轮都没开口就放下这条（不追着要她回），换下一条或清空。
      if (opts.replied === false) {
        const focus = Number(q[0]) || 0;
        const tries = Number(st.atSplitSkipSeq) === focus ? (Number(st.atSplitSkipTries) || 0) + 1 : 1;
        st.atSplitSkipSeq = focus; st.atSplitSkipTries = tries;
        if (tries < 2) { saveSocialV2State(); log(`[at-split] ${key} 这回合没开口，队列保持 ${q.length} 条（第 ${tries} 次）`); return; }
        log(`[at-split] ${key} 这条连续 ${tries} 轮没回，放下 seq=${focus}（不追）`);
        st.atSplitSkipSeq = 0; st.atSplitSkipTries = 0;
      }
      q.shift(); // 刚回完的这条
      // 跳过已经不在未读里的（被读掉/撤回）：别为幽灵消息再开一个回合
      const alive = (seq) => (Array.isArray(st.unread) ? st.unread : []).some((m) => m && Number(m.seq) === Number(seq));
      while (q.length && !alive(q[0])) q.shift();
      if (!q.length) {
        st.atSplitQueue = []; st.atSplitFocus = 0; st.atSplitSender = ''; saveSocialV2State();
        log(`[at-split] ${key} 逐条回完`);
        return;
      }
      st.atSplitQueue = q; st.atSplitFocus = q[0]; st.atSplitSkipSeq = 0; st.atSplitSkipTries = 0; saveSocialV2State();
      const a = cfg.socialV2?.atSplit || {};
      const min = Math.max(1000, Number(a.gapMinMs) || 6000);
      const max = Math.max(min, Number(a.gapMaxMs) || 14000);
      const gap = min + Math.round(Math.random() * (max - min));
      const timer = setTimeout(() => {
        try {
          // 直接投递（不走 scheduleWakeV2 的 debounce 合并，否则会被同批消息吃掉）
          st.pendingWakeReason = 'atSplit';
          void sendWakePromptV2(key, 'atSplit').catch((e) => log(`[at-split] 下一条投递失败 ${key}: ${e?.message ?? e}`));
        } catch (e) { log(`[at-split] 下一条投递异常 ${key}: ${e?.message ?? e}`); }
      }, gap);
      timer.unref?.();
      log(`[at-split] ${key} ${Math.round(gap / 1000)} 秒后回下一条（seq=${q[0]}，剩 ${q.length} 条）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'control-room-service.mjs:11601'); }
  }

  return { controlRoomLineFor, wakePriorityV2, directedUnreadList, armAtSplit, scheduleNextAtSplit };
}
