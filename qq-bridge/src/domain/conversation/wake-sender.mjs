// wake-sender.mjs · 从 app.mjs 的 main() 搬出的调度层（2026-10-28 M-1）
//
// 为什么单独成模块：
//   sendWakePromptV2 是"什么时候叫她、等多久、什么时候重试"的决策层。
//   以前它们和发送/状态/调度器混在 main() 的闭包里，改一个间隔只能靠线上日志验证；
//   搬出来之后，入参（依赖）和出参（计划/定时器）都是显式的。
//
// 依赖注入 + 懒构造：
//   调用方（app.mjs）在**第一次调用**时才构造本模块的实例并传入依赖快照，避免 main() 里
//   那些后声明的 const（TDZ）在构造期被提前求值。依赖对象被闭包持有；cfg/socialV2 这类
//   可变对象是原地修改，所以不会陈旧。
//
// 纪律：
//   · 本模块不 import 运行态模块；仅允许 import 同域的纯函数叶子（wake-stash.mjs，零 IO 零状态）。
//   · 新增依赖必须同时更新 app.mjs 的 deps 清单，否则这里会 ReferenceError。
import { stashWakeReason } from './wake-stash.mjs';

export function createWakeSender(deps) {
  const {
    addressedJudgmentLine,
    FOCUS_SLOTS,
    STATE_DATA_DIR,
    activityTracker,
    applyReplyPace,
    appraiseValence,
    armPendingWakeLease,
    armWakeRetryForPending,
    budgetWarnings,
    compactInjection,
    SAFE_INJECTION_CAPS,
    enforceInjectionBudget,
    // [LOOKUP] 被截断/被丢的块挂一句「完整版在哪查」（prompt-catalog.lookupHintFor）；缺省不影响旧行为
    lookupHintFor = () => '',
    // [SCENE-BUDGET] 场景预算（私聊/群聊）与 wake-prompt 共用；缺省回落原值
    SCENE_BUDGETS,
    buildLinkDigest,
    buildRecallQuery,
    renderQuoteContext,
    renderSelfRecentBlock,
    renderSkillCandidateLine,
    buildSelfModel,
    buildWakePromptV2,
    cancelReplyCheckV2,
    cfg,
    chaseAdaptMax,
    chaseState,
    classifyTopic,
    cleanText,
    cognition,
    computeGroupHabits,
    composeSelfSnapshot,
    computeProactivity,
    computeStyleStats,
    currentMode,
    getCurrentMode,
    decideMood,
    deliverPrompt,
    describeStyle,
    disarmPendingWakeLease,
    ensureRerank,
    evaluateStyle,
    expireGoals,
    expireLessons,
    extractLinks,
    findSkills,
    formatBudgetLine,
    fs,
    getSocialV2State,
    groupFeedbackRate,
    groupMutedUntil,
    inferLessonTrigger,
    isConversationBusyV2,
    isSameLocalDay,
    isSessionAllowedInCurrentMode,
    lessonPendingByKey,
    loadFocus,
    loadGoals,
    loadLessons,
    renderLessons,
    loadMoodState,
    loadSkills,
    listUndelivered,
    renderUndeliveredLine,
    undeliveredFile,
    takeDeviceBlockedLine,
    stateWithKey,
    log,
    logAction,
    mergeBlocks,
    moodLine,
    muteWakeSkipped,
    noteSkillInjected,
    path,
    pendingWakeKeys,
    pickTalkingPeers,
    prepareAffectHint,
    questionHint,
    readJsonlSafe,
    readPageForIntake,
    recallBlock,
    renderCoreFacts,
    renderFocusBlock,
    renderGoalIdeas,
    renderGoals,
    renderGraphLine,
    renderGroupHabits,
    renderInsightHints,
    renderLearningWritesLine,
    renderLedger,
    renderKnowledgeCandidates,
    renderMembers,
    renderPeerBotLine,
    renderSelfModel,
    renderSelfProfile,
    renderSelfTrend,
    renderThoughts,
    renderTraceHint,
    renderWorksLine,
    retireSession,
    rewriteLessons,
    runMemoryExtractV2,
    saveGoals,
    saveMoodState,
    saveSkills,
    saveSocialV2State,
    selectLessonsForContext,
    setupSleepTimerV2,
    sinkUnsentHint,
    socialGraph,
    socialV2,
    stateDataPath,
    stripUrls,
    summarizeLearningWrites,
    summarizeBehavior,
    renderBehaviorLogLine,
    renderBehaviorLedger,
    behaviorDigestRow,
    toolCallLogFile,
    summarizePrompt,
    summarizeSelfTrend,
    targetFromScene,
    tickMood,
    touchLesson,
    wakePriorityV2,
    worksStore,
  } = deps;

  // [MODE-CONTEXT] 不冻结构造时的 currentMode；见 message-intake 同名说明。
  const modeNow = () => (typeof getCurrentMode === 'function' ? getCurrentMode() : currentMode);

async function sendWakePromptV2(key, reason) {
    // [MEM-EXTRACT] 唤醒时顺手沉淀（后台异步；条数/间隔不够会直接跳过）
    try { void runMemoryExtractV2(key, getSocialV2State(key)?.recentMessages).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/wake-sender.mjs:153')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:146'); }
    if (cfg.socialV2?.enabled === false) return;
    // [SESSION-ROTATE] 会话跑太久就在唤醒间隙换一个：每次唤醒都把注入层/记忆再写进历史，
    // 历史会无限累积（最后表现为 400 或对着旧历史复读）。记忆/经验都在磁盘上，换会话不丢。
    try {
      const maxTurns = Math.max(10, Number(cfg.socialV2?.context?.maxSessionTurns) || 40);
      const stRot = getSocialV2State(key);
      if ((Number(stRot.sessionTurns) || 0) >= maxTurns) {
        // [ROTATE-IDLE] 只有手上没未读时才换会话：带未读换会话会丢上下文，
        // 并且轮换后紧接着补 bootstrap，看起来就像她把刚才说过的话又说了一遍。
        const unreadNow = Array.isArray(stRot.unread) ? stRot.unread.length : 0;
        if (unreadNow > 0) {
          // [ROTATE-STUCK] 活跃群里未读可能永远清不空（她读完的下一秒又来新的），
          // 旧逻辑会一直「等清空再换」，会话卡在上百回合、历史无限膨胀，
          // 最后表现成对着旧历史复读、或干脆不开口。这里给一个硬退出：
          // 卡住超过 10 分钟、或回合数到阈值两倍，就强制换新会话。
          // 未读不会丢——它们仍在 stRot.unread 里，下次唤醒照常喂给新会话。
          stRot.rotateBlockedSince = Number(stRot.rotateBlockedSince) || Date.now();
          const blockedMs = Date.now() - Number(stRot.rotateBlockedSince);
          const hardTurns = maxTurns * 2;
          const stuck = blockedMs >= 10 * 60 * 1000 || (Number(stRot.sessionTurns) || 0) >= hardTurns;
          if (!stuck) {
            log(`[SESSION-ROTATE] ${key} 已跑 ${stRot.sessionTurns} 回合但还有 ${unreadNow} 条未读，等清空再换（已等 ${Math.round(blockedMs / 1000)}s）`);
          } else {
            // 未读不清空也要换：新会话下一次唤醒会重新收到这批未读，上下文不会丢。
            log(`[SESSION-ROTATE] ${key} 已跑 ${stRot.sessionTurns} 回合、${unreadNow} 条未读始终清不空（已等 ${Math.round(blockedMs / 1000)}s），强制换新会话`);
            retireSession(key);
            stRot.sessionTurns = 0;
            stRot.rotateBlockedSince = 0;
            saveSocialV2State();
          }
        } else {
          stRot.rotateBlockedSince = 0;
          log(`[SESSION-ROTATE] ${key} 本会话已跑 ${stRot.sessionTurns} 回合（阈值 ${maxTurns}），换新会话`);
          retireSession(key);
          stRot.sessionTurns = 0;
          saveSocialV2State();
        }
      }
    } catch (error) { log(`[SESSION-ROTATE] 轮换失败（忽略）: ${error?.message ?? error}`); }
    if (modeNow() !== 'reserved2' || socialV2.paused) return;
    // [PACE]+[WAIT-NEXT] 场景停顿 + 判断要不要等对方下一句（不占并发槽）
    try { await applyReplyPace(key, reason); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:188'); }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    // [MUTE-GATE] 禁言中的群不唤醒：她发不出去，醒来也只能撞 mute（白费回合、刷日志等解禁）
    if (String(key).startsWith('group:')) {
      try {
        const until = await groupMutedUntil(key.split(':')[1]);
        if (until > Date.now()) {
          const nowSkip = Date.now();
          if (nowSkip - (muteWakeSkipped.get(key) || 0) > 300000) {
            muteWakeSkipped.set(key, nowSkip);
            log(`[mute-gate] ${key} 禁言中（到 ${new Date(until).toLocaleString('zh-CN')}），跳过唤醒 ${reason}；解禁后由新消息自然唤醒`);
          }
          return;
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:205'); }
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      const { seq } = stashWakeReason(st, reason);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      logAction({ t: 'busy_stash', key, trigger: reason }); // [ACTION-LOG] 纯观察
      // [WAKE-RETRY] 高优先级唤醒（@/提问/关键词）再挂一层兜底：turn/end 补发在 watchdog 路径上会漏
      if (wakePriorityV2(reason) >= wakePriorityV2('nameMention')) armWakeRetryForPending(key, reason, seq, Date.now());
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      logAction({ t: 'wake_skip', key, trigger: reason, minute: recentMinute, hour: recentHour }); // [ACTION-LOG] 阀门拦了她：本次唤醒被限流跳过（理由已暂存，下个唤醒合并）
      // [RATE-SKIP-RETRY] 限流跳过不得静默丢理由：与 busy 路径对齐——暂存 + 高优先级挂兜底，
      // 否则高峰期她的 @/提问 反应会整段消失（消息还在 unread，但"该反应的来头"丢了）。
      const { seq } = stashWakeReason(st, reason);
      if (wakePriorityV2(reason) >= wakePriorityV2('nameMention')) armWakeRetryForPending(key, reason, seq, Date.now());
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    st.silentRef = Number(st.lastAiReplyAt) || 0; // [SILENT-GUARD] 本回合「她有没有开口」的判定基准（回合内工具发送会抬高 lastAiReplyAt）
    saveSocialV2State();
    // [AFFECT] 先算"对方这会儿像什么"，再拼提示（不占并发槽，失败静默降级）
    try { await prepareAffectHint(key, reason); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:267'); }
    // [PROMPT-BUDGET] 给大块注入设上限：私聊全量，群聊/恢复类收紧（压 token，不动语义）
    const budgetScene = String(key).startsWith('private:') ? 'private' : 'group';
    // [SCENE-BUDGET] 预算口径与 wake-prompt 的分层预算共用一份（prompt-budget.SCENE_BUDGETS）
    const sceneBudgets = SCENE_BUDGETS ?? { private: 14000, group: 9000 };
    const promptBudget = Number(sceneBudgets[budgetScene]) || sceneBudgets.private;
    const basePrompt = buildWakePromptV2(key, reason);
    let promptText = basePrompt;
    if (promptText.length > promptBudget) {
      // 只告警不截断：硬截断会砍掉尾部（当前消息/收尾指令），比超预算危险得多。
      log(`[prompt-size] ${key} 超预算 ${promptText.length} > ${promptBudget} 字（场景 ${budgetScene}，块级上限已生效）`);
    }
    // [PROMPT-SIZE] 可机检：唤醒提示多大（含所有注入层），用来判断 token 成本有没有失控
    try { log(`[prompt-size] ${key} 唤醒提示 ${promptText.length} 字（${reason}）`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:278'); }
  // [STYLE-PROFILE] 把每次测得的场合/自己/判定追加进 history，方便看长期趋势
  function saveStyleProfileV2(key, rec) {
    try {
      const file = stateDataPath('style-profile.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const d = new Date();
      fs.appendFileSync(file, JSON.stringify({
        at: d.toISOString(),
        day: d.toLocaleDateString('sv-SE'),
        key,
        ...rec,
      }) + '\n', 'utf8');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:291'); }
  }

    // [STYLE] 语域学习：此刻场合多长？我多长？
    try {
      if (cfg.socialV2?.style?.enabled !== false) {
        const rs = getSocialV2State(key).recentMessages ?? [];
        const others = rs.filter((m) => m && !m.isSelf && m.text).slice(-12).map((m) => m.plain || m.text);
        const myOwn = rs.filter((m) => m && m.isSelf && m.text).slice(-20).map((m) => m.plain || m.text);
        const sceneStats = computeStyleStats(others, cfg.socialV2?.style ?? {});
        const mineStats = computeStyleStats(myOwn, cfg.socialV2?.style ?? {});
        let target = targetFromScene(sceneStats, cfg.socialV2?.style ?? {});
        // [STYLE-FALLBACK] 冷群样本不足 4 条时 targetFromScene 直接返回 null（整段失效）。
        // 回退：门槛降到 2 条——慢节奏的群也值得一个（低的）节奏目标。
        if (!target && String(key).startsWith('group:') && sceneStats.n >= 2) {
          const fb = targetFromScene(sceneStats, { ...(cfg.socialV2?.style ?? {}), minSamples: 2 });
          if (fb) {
            fb.fromHabits = true;
            target = fb;
            log(`[style] ${key} 冷群回退目标：${fb.targetAvg} 字（样本 ${sceneStats.n} 条）`);
          }
        }
        const ev = evaluateStyle(mineStats, target, cfg.socialV2?.style ?? {});
        if (ev.ok || ev.verdict !== 'no_data') {
          log(`[style] ${key} ${describeStyle(sceneStats, mineStats, ev)}`);
        }
        // [NO-LENGTH-HINT] 不再把「你这话偏短/偏长」的句长提示塞进提示词：长度由她自己定。
        if (ev.ok) saveStyleProfileV2(key, { scene: sceneStats, mine: mineStats, target, verdict: ev.verdict, gap: ev.gap });
        // [STYLE-Q] 问句维度（2026-10-26 优化）：场合问得多、她几乎不问 → 递一句事实+许可。
        // 只上这一维（语气词/表情容易催成表演味，先不动）；同一会话 30 分钟内只递一次。
        try {
          if (String(key).startsWith('group:')) {
            const qh = questionHint(sceneStats, mineStats, target, cfg.socialV2?.style ?? {});
            const stQ = getSocialV2State(key);
            if (qh && Date.now() - Number(stQ.lastQuestionHintAt || 0) > 30 * 60000) {
              promptText = qh + '\n\n' + promptText;
              stQ.lastQuestionHintAt = Date.now();
              saveSocialV2State();
              log(`[style] ${key} 已注入问句提示（场合 ${Math.round(Number(target?.targetQuestion ?? 0) * 100)}% vs 我 ${Math.round(Number(mineStats?.questionRate ?? 0) * 100)}%）`);
            }
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:332'); }
      }
    } catch (error) {
      log(`[style] 语域评估失败（已忽略）: ${error?.message ?? error}`);
    }
    // [ABOUT-SELF] 明确告诉她"他们在说你"——否则她只当成普通消息，倾向潜水
    try {
      if (String(reason ?? '').startsWith('aboutSelf')) {
        promptText = '他们在说你。你可以自己开口，不用等人叫——想接就接一句；没什么想说的就看着，别硬凑。' + '\n\n' + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:342'); }
    // [SCOPE] 明确告诉她在哪个会话里——否则 memory_save 不带 scope，群里的记忆全落进私聊库
    try {
      if (String(key).startsWith('group:')) {
        const gid = String(key).slice('group:'.length);
        promptText = `现在在群里（群号 ${gid}）。QQ 工具（qq_send_message / qq_mark_read / qq_get_prompt 等）的 key 参数填 "${key}"。记群里的事时 memory_save / memory_recall 带上 scope="group:${gid}"。你在群里也能想起私聊里记的事（记忆是互通的）；只是要把他的私事说出口之前，先想一下他可能不想让群里人知道。` + '\n\n' + promptText;
      } else if (String(key).startsWith('private:')) {
        promptText = `现在是一对一私聊。QQ 工具（qq_send_message / qq_mark_read / qq_get_prompt 等）的 key 参数填 "${key}"。memory_save / memory_recall 的 scope 不用填（默认私聊）。` + '\n\n' + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:351'); }
    // [ADDRESSED-JUDGE] 理解层：先分清这轮是不是在说她（群聊才注入），再决定接不接。
    // 事故：别的 AI 报自己的余额/花销，她接到自己身上（2026-10-30 群 123456789）。
    try {
      const judge = addressedJudgmentLine(key);
      if (judge) promptText = judge + '\n\n' + promptText;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:357'); }
    // [INTAKE] 信息接收：他发来的链接先读进来，再谈回应。
    // 分两级：先直接 fetch；正文太短（SPA 空壳）就用无头 Edge 渲染一次。
    // 实测小黑盒这类站点直接抓只有 97 字符壳，必须渲染才拿得到正文。
    try {
      if (cfg.socialV2?.intake?.linkRead !== false) {
        const lastIn = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf);
        const rawText = String(lastIn?.text || lastIn?.plain || lastIn?.tail || '');
        const links = extractLinks(rawText, Number(cfg.socialV2?.intake?.maxLinks) || 2);
        if (links.length) {
          // 唤醒路径最多等 2.5 秒：超时就先不带摘要开口，预读继续在后台跑，下次命中缓存。
          const waitBudget = Number(cfg.socialV2?.intake?.wakeWaitMs) || 2500;
          const raceAll = Promise.all(links.map((url, i) => readPageForIntake(url, i === 0)));
          const pages = await Promise.race([raceAll, new Promise((resolve) => setTimeout(() => resolve(links.map(() => null)), waitBudget).unref?.())]);
          const digest = buildLinkDigest(links, pages);
          if (digest) {
            promptText = digest + '\n\n' + promptText;
            const okCount = pages.filter((p) => p && p.text && p.text.length > 200).length;
            log(`[intake] ${key} 读取链接 ${links.length} 个（有效正文 ${okCount} 个）`);
          }
        }
      }
    } catch (error) {
      log(`[intake] 链接读取失败（已忽略）: ${error?.message ?? error}`);
    }
    // [MEMORY-INJECT] 本地长期记忆的被动注入：拿最后一条对方消息做语义检索，
    // 取最相关的几条 + 最近 2 条（时间连续性），拼在唤醒 prompt 最前面。
    // 任何失败都不注入也不抛 —— 记忆是增强，不能因为它让唤醒失败。
    try {
      if (cfg.socialV2?.memoryInject?.enabled !== false) {
        // [MEM-QUERY] 回退链：unread（最近 2 条别人的）→ 最近消息里最后 2 条别人的 → 空。
        // 只看最后一条会被「好」「[图片]」「@某人」带偏；[RECALL-QUERY] 会顺手剥引用块/占位符。
        const othersFromUnread = [...(Array.isArray(st.unread) ? st.unread : [])]
          .filter((m) => m && !m.isSelf)
          .slice(-3)
          .map((m) => m.text || m.plain || m.tail || '');
        const othersFromRecent = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
          .filter((m) => m && !m.isSelf && (m.text || m.plain))
          .slice(-6)
          .map((m) => m.text || m.plain || '');
        // [SEM-LEX] 最近 3 条别人的话：unread 不够时用 recent 补，保证查询里有话题主语
        const queryTexts = [...othersFromUnread];
        for (let i = othersFromRecent.length - 1; i >= 0 && queryTexts.length < 3; i -= 1) {
          if (!queryTexts.includes(othersFromRecent[i])) queryTexts.push(othersFromRecent[i]);
        }
        // [TOPIC-STACK] 当前话题一起进 query：只用最近两三句，话题一漂检索就错位
        const topicHint = String(st?.topicStack?.[0]?.gist || '').slice(0, 40);
        const rawQuery = stripUrls(buildRecallQuery(topicHint ? [topicHint, ...queryTexts] : queryTexts, { maxLen: 160 }));
        // [MEM-CLEAN] 检索前洗掉占位符/CQ 码：原来「[图片][思考]」会原样当 query，
        // 语义检索必然空手（日志表现为「候选=1 过阈=0 bestSim=-」）。
        // 洗完没有有效字就传空串——recall 走「只给最近几条」，不浪费一次嵌入调用。
        const cleanedQuery = cleanText(rawQuery);
        const query = cleanedQuery.replace(/[\s，。！？、,.!?~～…—\-]/g, '').length >= 2 ? cleanedQuery : '';
        // [MEMORY-INJECT] 记忆分库但不隔离：群会话默认也读私聊库（条目标「私聊里的事」，说不说由她定；
        // 反向共享由 recall() 默认开启：私聊时她能想起群里发生过的事（shareGroup=false 可关）。
        // minSim 不设值时按 scope 自动：私 0.35 / 群 0.25（群 digest 是短句，阈值高了全不过）。
        const memScope = String(key).startsWith('group:') ? key : 'private';
        // [RERANK-ONDEMAND] 真要重排之前顺手确保 8792 在线：不 await——模型要 20~30s 才就绪，
        // 拉不起来这一轮就走原来的静默回退；服务端空闲 RERANK_IDLE_EXIT 秒后会自己退出。
        if (cfg.socialV2?.memoryRerank?.enabled === true) {
          void ensureRerank(log);
        }
        const block = await recallBlock(query, {
          scope: memScope,
          // [SHARE-PRIVATE-GROUP] 群聊想起私聊的事必须显式打开（与 memory-retrieve 的
          // 「群永远不读私聊，除非显式 sharePrivate」保持同一方向）；旧版默认 true 是漏口。
          ...(memScope !== 'private' && cfg.socialV2?.memoryInject?.sharePrivate === true ? { sharePrivate: true } : {}),
          // [RERANK-WIRE] 可选交叉重排（常驻 GPU 小模型，失败自动回退）
          ...(cfg.socialV2?.memoryRerank?.enabled === true ? {
            rerankUrl: String(cfg.socialV2.memoryRerank.url || 'http://127.0.0.1:8792/rerank'),
            rerankTopK: Number(cfg.socialV2.memoryRerank.topK) || 12,
            rerankTimeoutMs: Number(cfg.socialV2.memoryRerank.timeoutMs) || 800,
          } : {}),
          limit: Number(cfg.socialV2?.memoryInject?.limit) || 5,
          ...(Number(cfg.socialV2?.memoryInject?.minSim) ? { minSim: Number(cfg.socialV2.memoryInject.minSim) } : {}),
          ...(cfg.socialV2?.memoryInject?.shareGroup === false ? { shareGroup: false } : {}),
          ...(cfg.socialV2?.memoryInject?.searchArchive === false ? { searchArchive: false } : {}),
          ...(cfg.socialV2?.memoryInject?.dir ? { dir: String(cfg.socialV2.memoryInject.dir) } : {}),
        });
        if (block.text) {
          promptText = block.text + '\n\n' + promptText;
          log(`[memory-inject] ${key} 注入 ${block.count} 条（${block.mode}/${block.scope ?? memScope}）候选=${block.steps?.candidates ?? '-'} 过阈=${block.steps?.passed ?? '-'} bestSim=${block.steps?.bestSim ?? '-'} bestMom=${block.steps?.bestMomentum ?? '-'} query=${(query || '(空)').slice(0, 20)}`);
        } else {
          log(`[memory-inject] ${key} 无可注入记忆（${block.mode}）`);
        }
      }
    } catch (error) {
      log(`[memory-inject] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [COGNITION] 她攒下的认知：按当前话题挑最多 3 条，对不上就不给。
    try {
      if (cfg.socialV2?.cognitionInject?.enabled !== false) {
        const lastIn = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf);
        const cq = cleanText(String(lastIn?.text || lastIn?.plain || ''));
        // [COG-SCOPE] 认知按场合过滤：群聊只注入「关于群/关于世界」，不注「怎么对他」那类私密关系话术。
        // 那 5 条认知全是「嘴硬别拆台阶」「被说认知不够别接话头」，在群里对陌生人照用会把人惹恼。
        const isGroupKey = String(key).startsWith('group:');
        const cogItems = cognition.load().filter((x) => !isGroupKey
          || ['about-group', 'about-world', 'general'].includes(String(x?.kind || 'general')));
        const cogOut = typeof cognition.render === 'function'
          ? cognition.render(cogItems, cq.replace(/\s+/g, '').length >= 2 ? cq : '')
          : { text: cognition.renderLine(cogItems, cq.replace(/\s+/g, '').length >= 2 ? cq : ''), ids: [] };
        const cogBlock = cogOut.text || '';
        if (cogBlock) {
          promptText = cogBlock + promptText;
          log(`[cognition] ${key} 注入认知 ${(cogBlock.match(/^- /gm) || []).length} 条`);
          // [COG-V2] 回填"这条被注入过"：只加 usedCount，不改判定。
          if (Array.isArray(cogOut.ids) && cogOut.ids.length && typeof cognition.markUsed === 'function') {
            try {
              cognition.transact((items) => ({ ok: true, items: cognition.markUsed(items, cogOut.ids) }));
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:467'); }
          }
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:471'); }
    // [KNOWLEDGE-CANDIDATES] 从查到记：只私聊注入（她在这里有 key/token，真的写得下去）；
    // 群聊不塞这种元信息。候选出现条件见 inori-knowledge.mjs（同一问题查过 ≥2 次且没记过）。
    if (!String(key).startsWith('group:') && typeof renderKnowledgeCandidates === 'function') {
      try {
        const kb = renderKnowledgeCandidates();
        if (kb) {
          promptText = kb + '\n\n' + promptText;
          log(`[knowledge] ${key} 注入「查过没记」候选 ${(kb.match(/^- /gm) || []).length} 条`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:481'); }
    }
    // [FOCUS] 重点段：反思轮昨晚压出的四槽位，拼在 prompt 最前（和记忆注入同级）。
    // 过期/缺失就什么都不拼——没有重点时不强塞空块。
    try {
      if (cfg.socialV2?.focusInject?.enabled !== false) {
        const focus = loadFocus();
        const focusBlock = renderFocusBlock(focus);
        if (focusBlock) {
          promptText = focusBlock + '\n\n' + promptText;
          log(`[focus] 注入重点段（${FOCUS_SLOTS.filter((s) => focus[s]).length} 槽）`);
        }
      }
    } catch (error) { log(`[focus] 注入失败（已忽略）: ${error?.message ?? error}`); }
    // [MOOD] 状态 × 话题 → 一段状态描述，放在 prompt 最前。
    // 只描述状态与倾向，不写台词 —— 回不回、怎么回由她决定（角色卡里也说「不想回也可以不回」）。
    try {
      if (cfg.socialV2?.mood?.enabled !== false) {
        const mst = loadMoodState(cfg.socialV2?.mood?.file);
        tickMood(mst, Date.now());
        saveMoodState(mst, cfg.socialV2?.mood?.file);
        // [MOOD-PERKEY] 对这个会话的温度（体质 45% + 这个会话 55%），不是全局一个值
        const mstK = stateWithKey ? stateWithKey(mst, key) : mst;
        const probe = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf);
        const moodQuery = stripUrls(probe?.text || probe?.plain || probe?.tail || '');
        const topic = classifyTopic(moodQuery);
        const val = appraiseValence(moodQuery);
        const d = decideMood(mstK, topic, val);
        const line = moodLine(mstK, d);
        if (line) {
          promptText = line + '\n\n' + promptText;
          log(`[mood] ${key} 话题=${topic.type} 温度=${mstK.warmth.toFixed(2)}（全局 ${mst.warmth.toFixed(2)}）精力=${mstK.energy.toFixed(2)} 回复概率=${d.replyProb.toFixed(2)} 单条上限=${d.maxChars} ｜ ${d.reason}`);
        }
      }
    } catch (error) {
      log(`[mood] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [OUTBOX] 上次没发出去的话（断线时记下的）：只在这个会话的唤醒里说，让她自己决定补不补。
    try {
      const und = typeof listUndelivered === 'function' ? listUndelivered({ file: undeliveredFile }) : [];
      const undLine = typeof renderUndeliveredLine === 'function' ? renderUndeliveredLine(und) : null;
      if (undLine) {
        promptText = undLine + '\n\n' + promptText;
        log(`[outbox] ${key} 注入 ${und.length} 条没发出去的话`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:526'); }
    // [DEVICE-GUARD] 刚才那回合连着 3 次手机失败：说一句事实，让她别把下一轮也花在手机上。
    try {
      const dl = typeof takeDeviceBlockedLine === 'function' ? takeDeviceBlockedLine() : '';
      if (dl) promptText = dl + promptText;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:531'); }
    // [GOALS] 她手上的事：注入进行中的目标，让"独处时间"能接着上次往下推进，
    // 而不是每次醒来都从零开始（这是 agent 与 chatbot 的分界之一）。
    // 只在有进行中的事时注入；顺手做过期清理（14 天没动自动放下）。
    try {
      if (cfg.socialV2?.goals?.enabled !== false) {
        const gfile = cfg.socialV2?.goals?.file;
        const gAll = loadGoals(gfile);
        const dropped = expireGoals(gAll, Number(cfg.socialV2?.goals?.expireDays) || 14);
        if (dropped > 0) { saveGoals(gAll, gfile); log(`[goals] 过期放下 ${dropped} 件（超过 14 天没动）`); }
        const gLine = renderGoals(gAll);
        if (gLine) {
          promptText = gLine + '\n\n' + promptText;
          const act = gAll.filter((x) => x.status === 'active').length;
          log(`[goals] ${key} 注入 ${act} 件进行中的事`);
        } else if (['own-life', 'reflection', 'reflection-retry', 'proactiveCheck'].includes(reason)) {
          // [GOALS] 空的时候也要说一声：原来 renderGoals 为空就什么都不注入，
          // 她连"我现在手上没任何事"都看不到，自然不会 goal_add（实测 goals.json 长期为空）。
          promptText = '【手头的事】你现在手上没有任何事。想到什么要做的，就用 goal_add 记一条（最多 5 件）。\n\n' + promptText;
          log(`[goals] ${key} 手头为空，已提示她可以 goal_add（reason=` + reason + '）');
        }
      }
    } catch (error) {
      log(`[goals] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [SELF-MODEL] 她最近的样子：从话风/追人/做事/经验里确定性地算出来（不靠她自己记）。
    // 放在经验之前注入——先知道自己是什么样，再看经验。
    try {
      const stm = getSocialV2State(key);
      const rs = stm.recentMessages ?? [];
      const others = rs.filter((m) => m && !m.isSelf && m.text).slice(-12).map((m) => m.plain || m.text);
      const myOwn = rs.filter((m) => m && m.isSelf && m.text).slice(-20).map((m) => m.plain || m.text);
      const sceneStats = computeStyleStats(others, cfg.socialV2?.style ?? {});
      const mineStats = computeStyleStats(myOwn, cfg.socialV2?.style ?? {});
      const day = new Date().toLocaleDateString('sv-SE');
      // [SELF-MODEL-FIX] 轨迹实际写在 data/state/traces/（inori-activity.js 的 TRACE_DIR），
      // 这里原来读 data/traces/ → 永远空 → 「做事」层恒 0，自我模型瞎了一层
      let tracesToday = [];
      try { tracesToday = readJsonlSafe(path.join(stateDataPath('traces'), day + '.jsonl')); } catch { tracesToday = []; }
      const model = buildSelfModel({
        styleEntry: { mine: mineStats, scene: sceneStats },
        chase: chaseState(stm),
        adapt: { maxPerDay: chaseAdaptMax || 3 },
        traces: tracesToday,
        lessons: loadLessons(cfg.socialV2?.lessons?.file),
      });
      try {
        const evoFile = stateDataPath('evolution.jsonl');
        const dayKey = new Date().toLocaleDateString('sv-SE');
        let already = false;
        try {
          const rows = fs.readFileSync(evoFile, 'utf8').split('\n').filter(Boolean);
          // [SELF-MODEL-DAY] 按本地日期比，且只回扫最近 300 行：
          // at 是 UTC ISO、dayKey 是本地日期，直接 startsWith 在本地 0–8 点永远不成立，
          // 结果一天写几百条快照（2000 行里 1604 条是这个）。日志已经很长，不必整文件读。
          already = rows.slice(-300).some((l) => {
            try {
              const r = JSON.parse(l);
              return r.kind === 'self_model_snapshot' && isSameLocalDay(r.at, dayKey);
            } catch { return false; }
          });
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:592'); }
        if (!already) {
          fs.mkdirSync(STATE_DATA_DIR, { recursive: true });
          fs.appendFileSync(evoFile, JSON.stringify({
            at: new Date().toISOString(), kind: 'self_model_snapshot',
            voice: model.voice, chase: model.chase, work: model.work, lessonCount: model.lessonCount,
          }) + '\n', 'utf8');
          log('[evolution] 已记录今日自我快照');
        }
      } catch (error) { log(`[evolution] 快照失败（已忽略）: ${error?.message ?? error}`); }
      const selfText = renderSelfModel(model);
      // [SELF-PROFILE] 自我档案：我会什么/攒了多少经验/最近改过自己/手头几件事
      const profileText = renderSelfProfile(model);
      // [GROUP-TRIM] 群聊不注入纯自述统计（自述/趋势/学习写入/最近做过的事）：
      // 这些块每轮重贴、和「这句在说什么」无关，44 块的告警就是这么来的；
      // 私聊保留（一对一没有群聊的上下文噪音，自我连续性更像人）。
      const isGroupChat = String(key).startsWith('group:');
      // [SELF-SNAPSHOT] 先收集各块，最后一次按旧顺序拼；不要在这里直接 prepend，
      // 否则 composeSelfSnapshot 收不到 trend/learning/behavior。
      let trendText = '';
      let learningText = '';
      let behaviorText = '';
      // [SELF-TREND] 自我认知趋势：近 7 天 vs 上一周（风格/主动/经验），有数据才注入
      try {
        if (isGroupChat) throw new Error('group-skip');
        const trend = summarizeSelfTrend({
          styleRows: readJsonlSafe(stateDataPath('style-profile.jsonl')),
          actionRows: readJsonlSafe(stateDataPath('action-log.jsonl')),
          lessonsRows: readJsonlSafe(cfg.socialV2?.lessons?.file || stateDataPath('lessons.jsonl')),
        });
        const trendLine = renderSelfTrend(trend);
        if (trendLine) {
          trendText = trendLine;
          log('[self-trend] 注入自我趋势');
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:627'); }
      // [SELF-WRITES] learning-trend 的读端：近 7 天她往自己本子里写了什么（只报事实与次数）
      try {
        if (isGroupChat) throw new Error('group-skip');
        const lw = summarizeLearningWrites(readJsonlSafe(stateDataPath('learning-trend.jsonl')), { days: Number(cfg.socialV2?.selfModel?.learningDays) || 7 });
        const lwLine = renderLearningWritesLine(lw);
        if (lwLine) { learningText = lwLine; log(`[self-trend] 学习写入 ${lw.total} 次（${Object.entries(lw.byBucket).map(([k, v]) => k + ' ' + v).join('、')}）`); }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:634'); }
      // [BEHAVIOR-LIVE] 她最近做过的事：每次唤醒都现算（不再 30 分钟节流），并带上时间戳。
      // [GROUP-LINE] 群聊只留一句 ≤90 字的「今天做过（HH:MM）」——自述/趋势仍跳过，
      // 但"我都干了什么"必须在，而且要是**这一分钟**的账，不是半小时前的旧账。
      try {
        const nowB = Date.now();
        const nowD = new Date(nowB);
        const hhmm = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
        let ledger = '';
        try { ledger = renderBehaviorLedger({ day: nowD.toLocaleDateString('sv-SE'), now: nowD }); } catch { ledger = ''; }
        const ledgerBody = String(ledger).replace(/^【[^】]*】\s*/, '').replace(/^\d{4}-\d{2}-\d{2}[：:]\s*/, '').trim();
        if (isGroupChat) {
          const compact = ledgerBody.slice(0, 90);
          if (compact) {
            behaviorText = `今天做过（${hhmm}）：${compact}`;
            log(`[behavior-log] ${key} 群聊实时注入（${hhmm}，${compact.length} 字）`);
          }
        } else if (ledgerBody) {
          behaviorText = `我最近做过的（截至 ${hhmm}）：${ledgerBody.slice(0, 240)}`;
          log(`[behavior-log] ${key} 私聊实时注入（${hhmm}，${ledgerBody.length} 字）`);
        }
        // 每天一条 digest（同一天同会话只写一次；群/私都记，给行为账留底）
        try {
          const bf = stateDataPath('behavior-log.jsonl');
          const dayKey = nowD.toLocaleDateString('sv-SE');
          const exists = readJsonlSafe(bf).some((r) => r && r.day === dayKey && String(r.key) === String(key));
          if (!exists) {
            const statsB = summarizeBehavior(readJsonlSafe(toolCallLogFile).slice(-4000), { key, days: 1, now: nowB });
            fs.appendFileSync(bf, JSON.stringify(behaviorDigestRow(statsB, { key, now: nowB })) + '\n', 'utf8');
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:664'); }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:665'); }
      // [SELF-NARRATIVE] 她自己写的自述（state/self-notes.md，qq_self_note / self_edit 写入）。
      // 以前这个文件只写不读——没有任何地方注入，写了没人看见；这里接上读侧。
      let narrativeText = '';
      try {
        if (isGroupChat) throw new Error('group-skip');
        const notes = fs.readFileSync(path.join(STATE_DATA_DIR, 'self-notes.md'), 'utf8').trim();
        if (notes) narrativeText = `【你现在怎么看自己（你自己写的，随时能改）】\n${notes}`;
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:673'); }
      const mergedSelf = typeof composeSelfSnapshot === 'function'
        ? composeSelfSnapshot({
          narrative: narrativeText,
          profile: profileText,
          model: selfText,
          behavior: behaviorText,
          learning: learningText,
          trend: trendText,
        }).text
        : [narrativeText, profileText, selfText, behaviorText, learningText, trendText].filter(Boolean).join('\n\n');
      if (mergedSelf) {
        promptText = mergedSelf + '\n\n' + promptText;
        log(`[self-model] ${key} 注入（话风=${model.voice?.verdict ?? '-'} 追人=${model.chase?.count ?? 0}/${model.chase?.maxPerDay ?? 3} 做事=${model.work?.total ?? 0} 经验=${model.lessonCount} 档案=${profileText ? '有' : '无'}）`);
      }
    } catch (error) {
      log(`[self-model] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [THOUGHTS] 她最近在想的：让"想法"跨会话延续
    try {
      const th = renderThoughts(3);
      if (th) promptText = th + '\n\n' + promptText;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:695'); }
    // [QUOTE-CONTEXT] 有人引用了她那条 → 递回她发那条之前群里在说什么。
    // 以前只有引用句柄（[引用 她：那你就别叫。]），她答「不记得了」——那条上下文只活在上一个回合。
    try {
      const qc = typeof renderQuoteContext === 'function' ? renderQuoteContext(key) : '';
      if (qc) {
        promptText = qc + '\n\n' + promptText;
        log(`[quote-context] ${key} 注入引用上下文`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:704'); }
    // [SELF-RECENT] 她自己在别的会话里说过/做过的事——防止同一件事在群里和私聊两种说法
    try {
      const sr = typeof renderSelfRecentBlock === 'function' ? renderSelfRecentBlock(key) : '';
      if (sr) {
        promptText = sr + '\n\n' + promptText;
        log(`[self-recent] ${key} 注入跨会话自述`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:712'); }
    // [LESSON-CANDIDATE] 思考链里抽出来的、她自己想到但还没定成经验的那几句（7 天过期）
    try {
      const rows = fs.readFileSync(path.join(STATE_DATA_DIR, 'lesson-candidates.jsonl'), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => r && r.text && Date.now() - Date.parse(String(r.at ?? '')) < 7 * 86400000);
      if (rows.length) {
        const lines = rows.slice(-2).map((r) => `- ${String(r.text).slice(0, 120)}`);
        promptText = `【我自己想到的、还没定成经验】\n${lines.join('\n')}\n（觉得对就 lesson_write 记下来；觉得没用就别管，7 天后自己过期。）\n\n` + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:723'); }
    // [TASK-LEDGER] 手头在跑的事（只管私聊，别把主人的活漏到群里）
    try {
      if (String(key).startsWith('private:')) {
        const lg = renderLedger();
        if (lg) promptText = lg + '\n\n' + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:730'); }
    // [WORKS] 她手上的活：分身进度（只给私聊——工作台是她自己的事，不下群）
    try {
      if (String(key).startsWith('private:')) {
        const wl = renderWorksLine(worksStore);
        if (wl) promptText = wl + '\n\n' + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:737'); }
    // [GOAL-IDEA] 反复想的事：提醒她可以排进手头的事
    try {
      if (String(key).startsWith('private:')) {
        const gi = renderGoalIdeas(2);
        if (gi) promptText = gi + '\n\n' + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:744'); }
    // [ACTIVITY] 她上次在手机里怎么做的：注入最近 2 条成功/卡住轨迹，
    // 让她照着能走通的路径做，而不是每次从零摸索（ExpeL 的"相似经验检索"简化版）。
    try {
      const recentTraces = [];
      for (const app of activityTracker.recentApps?.(3) ?? []) {
        recentTraces.push(...activityTracker.lookup(app, 1));
      }
      const hint = renderTraceHint(recentTraces.slice(0, 2));
      if (hint) {
        promptText = hint + '\n\n' + promptText;
        log(`[activity] ${key} 注入 ${recentTraces.slice(0, 2).length} 条历史轨迹`);
      }
      // [INSIGHT-REUSE] 洞见闭环：她以前"卡住/走通"的判断，在做事时刻喂回去（ExpeL 读端，之前 0 注入）
      try {
        const insightHint = renderInsightHints(activityTracker.recentApps?.(3) ?? []);
        if (insightHint) {
          promptText = insightHint + '\n\n' + promptText;
          log(`[activity] ${key} 注入洞见复用提示`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:764'); }
    } catch (error) {
      log(`[activity] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [FACTS] 关于他的长期事实：私聊常驻最近 8 条，避免被“最近 5 条”挤掉
    try {
      if (String(key) === `private:${String(cfg.ownerQQ || '')}`) {
        const cf = renderCoreFacts();
        if (cf) promptText = cf + '\n\n' + promptText;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:774'); }
    // [GROUP-HABITS] 群习惯：每群 10 分钟统计一次，注入一句节奏提示
    try {
      if (String(key).startsWith('group:')) {
        const stG = getSocialV2State(key);
        const nowG = Date.now();
        if (!stG.groupHabits || nowG - Number(stG.groupHabitsAt || 0) > 10 * 60 * 1000) {
          const h = computeGroupHabits(stG.recentMessages || [], { now: nowG });
          stG.groupHabits = renderGroupHabits(h);
          stG.groupHabitsAt = nowG;
          saveSocialV2State();
          log(`[group-habits] ${key} 更新（样本 ${h.others} 条，复读率 ${h.repeatRate}，间隔 ${h.avgGapSec}s）`);
        }
        if (stG.groupHabits) {
          promptText = stG.groupHabits + '\n\n' + promptText;
          log(`[group-habits] ${key} 注入`);
        }
        // [GROUP-FEEDBACK] 这个群最近回应她多少：回应低就少说两句（24h 窗口口径，与 proactivity 共用）
        const gfRate = groupFeedbackRate(stG);
        if (gfRate != null) {
          const gf = stG.groupFeedback;
          const rate = Math.round(gfRate * 100);
          promptText = `【这个群最近回应你 ${rate}%（近24小时 ${gf.replied}/${gf.sent}）】${rate < 40 ? '回应低，少说两句、别刷屏。' : '回应还行，正常接。'}\n\n` + promptText;
          log(`[group-feedback] ${key} 注入回应率 ${rate}%（24h 窗口）`);
        }
        // [GROUP-MEMBERS] 这个群里的人：认人，别对谁都一个熟络度
        {
          // [PEER-BOT] 名单里的「人」其实是另一个 AI：它的客套不是社交对象，别一问一答地互相捧。
          // 2026-10-29 00:07 群里她和另一个 bot 互相「正式打个招呼」「别嫌我烦」→ 群里喊「人机互吹」。
          try {
            const botIds = cfg.socialV2?.knownBots ?? [];
            const peers = pickTalkingPeers(botIds, [...(stG.unread ?? []), ...(stG.recentMessages ?? [])]);
            const peerLine = renderPeerBotLine(peers);
            if (peerLine) {
              promptText = peerLine + '\n\n' + promptText;
              log(`[peer-bot] ${key} 注入同类提示（${peers.map((p) => p.name).join('、')}）`);
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:811'); }
          // [ON-DEMAND] 只认这一轮在说话的人：最近 12 条非本人消息的 userId，按"最近→较早"排。
          // 谁最后在跟她说话，谁排第一（认人优先给他）；上限放宽到 4 人，减少"第 4 个人没档案"。
          const focusIds = [...new Set((stG.recentMessages ?? [])
            .filter((m) => m && !m.isSelf && m.userId)
            .slice(-12)
            .reverse()
            .map((m) => String(m.userId)))];
          const membersText = renderMembers(key, 4, cfg.ownerQQ, { focusIds, botIds: cfg.socialV2?.knownBots ?? [] });
          if (membersText) {
            promptText = membersText + '\n\n' + promptText;
            log(`[group-members] ${key} 注入成员档案（本轮 ${focusIds.length} 人）`);
          }
        }
        // [SOCIAL-GRAPH] 谁跟谁常来常往（他人↔他人关系）：有数据才注入
        try {
          const graphText = renderGraphLine(socialGraph, key);
          if (graphText) {
            promptText = graphText + '\n\n' + promptText;
            log(`[social-graph] ${key} 注入群内关系图谱`);
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:832'); }
        // [PROACTIVITY] 水群适应度：热闹 + 她最近说得多 + 被接率高 + 有精神 → 更主动
        const pro = computeProactivity(stG);
        stG.proactivity = pro;
        try { saveSocialV2State(); } catch (error) { log(`[wake] 保存 proactivity 失败（不挡唤醒）: ${error?.message ?? error}`); }
        {
          const mood = pro >= 0.15 ? '这个群正热闹、你还没怎么说话——想说就插一两句，说完给别人留位置，别连着发。'
            : pro >= 0.08 ? '一般般，想接就接一句，不想接就看着。'
              : '偏冷清，少说话、别硬凑。';
          promptText = `【水群适应度 ${pro}】${mood}\n\n` + promptText;
          log(`[proactivity] ${key} 适应度 ${pro}`);
        }
      }
    } catch (error) { log(`[group-habits] 失败（忽略）: ${error?.message ?? error}`); }
    // [NO-SEND] 上一轮只写了文字没发出去：提醒她这次先发再收尾
    try {
      const stNS = getSocialV2State(key);
      if (stNS.noSendHint) {
        const hintAge = Date.now() - Number(stNS.noSendHint.at || 0);
        if (hintAge < 10 * 60 * 1000) {
          promptText = `【上一轮只写了字、没发出去】上一轮你写了一句「${String(stNS.noSendHint.text || '').slice(0, 60)}」就收尾了，没调用 qq_send_message，所以群里没看到这句。如果那句本来是想发出去的，这次先调用发送工具再收尾；如果本来就是自己想的、只是记录，就不用管。\n\n` + promptText;
          log(`[no-send] ${key} 注入补发提醒`);
          delete stNS.noSendHint;
          saveSocialV2State();
        } else {
          // [UNSENT] 过期沉底（2026-10-25 a 方案）：潜水模式下「10 分钟内下次唤醒」可能永远不来，
          // 旧代码过期即遗忘——现在沉到底部容器 unsent.json，own-life/自唤醒带一行给她，
          // 送不送她定（系统不催不发，14 天沉没）。
          sinkUnsentHint(stNS.noSendHint.text, stNS.noSendHint.at, key);
          log(`[unsent] ${key} 挂心事沉底（${String(stNS.noSendHint.text || '').length} 字）`);
          delete stNS.noSendHint;
          saveSocialV2State();
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:866'); }
    // [ECHO] 群里在复读/加一：提示她可以跟着接一句（只提示，接不接她自己定）
    try {
      const est = getSocialV2State(key);
      const es = est.echoState;
      if (es && es.ready && Date.now() - Number(es.at || 0) < 120000) {
        promptText = `【群里在复读】${String(es.text || '').slice(0, 30)} 已经 ${es.count} 个人跟了。想接就接一句一样的（加一/复读都行），只接一次；不想接就不说。\n\n` + promptText;
        log(`[echo] ${key} 注入复读提示（${es.count} 人）`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:875'); }
    // [LESSONS] 她的经验：常驻注入最近几条。
    // 为什么常驻而不是检索：经验数量少（≤30）、长期有效，按需检索反而会漏掉该记起的那条。
    try {
      if (cfg.socialV2?.lessons?.enabled !== false) {
        const lfile = cfg.socialV2?.lessons?.file;
        const lAll = loadLessons(lfile);
        if (lAll.length) {
          const { kept, dropped } = expireLessons(lAll, Number(cfg.socialV2?.lessons?.expireDays) || 60);
          if (dropped > 0) { rewriteLessons(kept, lfile); log(`[lessons] 过期放下 ${dropped} 条经验（60 天没用到）`); }
          // [TRACK-SPLIT] 两条轨分开挑：判断轨（读人/关系/审美）常态注入；操作轨只在真的在操作/任务里才注入。
          // 以前两轨混在一起按相关度排，手机操作笔记会在几乎所有上下文里排前面，把判断挤掉。
          const lCtx = (getSocialV2State(key)?.recentMessages ?? []).slice(-8).map((m) => m?.text || '').join('\n');
          const reading = selectLessonsForContext(kept, lCtx, { rotate: true, minRel: 0.15, tracks: ['reading'], injectRecent: 3 });
          const opCtx = String(key).startsWith('task:')
            || /手机|adb|截图|点击|坐标|画世界|笔刷|部署|方舟|游戏|工具|命令|接口|安装|下载|文件|路径|进程|重启|qq_|phone_|skill/i.test(lCtx);
          const doing = opCtx
            ? selectLessonsForContext(kept, lCtx, { rotate: true, minRel: 0.15, tracks: ['doing'], injectRecent: 2 })
            : { selected: [], text: '', matched: false };
          const selected = [...(reading.selected ?? []), ...(doing.selected ?? [])];
          const picked = { selected, matched: reading.matched || doing.matched };
          // [TRIGGER] 空 trigger 的经验：用这次命中的上下文词补一条「当…时」（下次更容易被想起）
          try {
            const trigFill = picked.matched ? inferLessonTrigger(lCtx) : '';
            if (trigFill) {
              let trigChanged = false;
              for (const l of picked.selected) {
                if (l && !l.trigger) { l.trigger = trigFill; trigChanged = true; }
              }
              if (trigChanged) rewriteLessons(kept, lfile);
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:898'); }
          const lLine = selected.length ? renderLessons(selected, { injectRecent: 5 }) : '';
          if (lLine) {
            promptText = lLine + '\n\n' + promptText;
            for (const lesson of picked.selected) touchLesson(kept, lesson.id);
            try { lessonPendingByKey.set(key, picked.selected.map((l) => l.id).slice(0, 5)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:903'); }
            rewriteLessons(kept, lfile);
            log(`[lessons] ${key} 注入 ${selected.length} 条经验（判断 ${(reading.selected ?? []).length} / 做法 ${(doing.selected ?? []).length}，共 ${kept.length} 条）`);
          }
        }
      }
    } catch (error) {
      log(`[lessons] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [SKILLS] 她学过的做法：按当前这句话检索技能库，命中才注入。
    // 与 goals/lessons 不同：技能库可能很长，必须按需检索而不是常驻，
    // 否则又会变成"塞一堆用不上的文本"（正是 Fame Fades 那种稀释）。
    try {
      if (cfg.socialV2?.skills?.enabled !== false) {
        const sfile = cfg.socialV2?.skills?.file;
        const store = loadSkills(sfile);
        const probe = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf);
        const skillQuery = stripUrls(probe?.text || probe?.plain || probe?.tail || '');
        const hits = skillQuery ? findSkills(store, skillQuery, 3) : [];
        if (hits.length) {
          const lines = hits.map((h) => {
            const s = h.skill;
            return `- ${s.name}：${s.desc || '（没写说明）'}｜步骤：${(s.steps || []).join(' → ')}｜成功判据：${s.verify || '没写'}`
              + (s.nextDrill ? `｜下一步练：${s.nextDrill}` : '')
              + `｜掌握 ${Number(s.mastery ?? 0)}`;
          });
          promptText = `你学过这些做法（能对上就照做，也可以改）：\n${lines.join('\n')}\n（有判据的先 skill_verify，验过才在 skill_record 记 ok=true；没判据只记一次尝试。）\n\n` + promptText;
          log(`[skills] ${key} 命中 ${hits.length} 条（query=${skillQuery.slice(0, 16)}｜best=${hits[0].score}）`);
          // [KNOWING-DOING-WAKE] 唤醒里注入的技能也记账：谁的注入次数 + 供 [TOOL-LEARN] 结算成败。
          try {
            st.$skillIds = hits.map((h) => h?.skill?.id).filter(Boolean);
            for (const h of hits) noteSkillInjected(store, h?.skill?.id);
            saveSkills(store, sfile);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:936'); }
        }
      }
    } catch (error) {
      log(`[skills] 注入失败（已忽略）: ${error?.message ?? error}`);
    }
    // [SKILL-CANDIDATE] 只递“同类成功做过多次”的候选；不自动建技能/草稿。
    try {
      const candidateLine = typeof renderSkillCandidateLine === 'function' ? renderSkillCandidateLine(key) : '';
      if (candidateLine) promptText = candidateLine + '\n\n' + promptText;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:946'); }
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      // [WAKE-RETRY] lastPromptSeq 不在这里写：要等 buildWakeSnapshotV2 真的装完消息，
      // 由 deliverPromptNow 用 packet.readThroughSeq 写。旧写法写 lastUnreadSeq 会把
      // 「预算没带上的 @」误判成已展示，兜底补发因此漏掉。
      // [WAKE-INJ-FIX] 注入层随唤醒原因一起交给 deliverPrompt：
      // deliverPromptNow 为了「会话创建后刷新令牌/快照」会用 buildWakePromptV2 重建裸基底，
      // 旧代码把这里拼好的 15+ 注入层（记忆/经验/目标/自我模型/念头/洞见…）整个丢掉——
      // 她写进 state 的东西从未真正回到她的对话唤醒上下文（审计 2026-10-25 实证：
      // 注入日志在打印后随 promptText 被覆盖，live 会话 prompt 里六类注入全部缺席）。
      let wakeInjections = promptText === basePrompt ? ''
        : (promptText.endsWith(basePrompt) ? promptText.slice(0, promptText.length - basePrompt.length) : promptText);
      // [BLOCK-MERGE] 同类块合并（学记忆模块 unifyEntries：同一件事的多个视图只占一个块）。
      // 必须放在注入层切出来之后：先按原样判断 endsWith(basePrompt)，再只合并注入层，
      // 否则切分判定失效会把基底整份再拼一遍（实测块数 38→60、角色卡 1538→3076）。
      try { wakeInjections = mergeBlocks(wakeInjections); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:969'); }
      // [PROMPT-DIET] 对注入层做一次**只削背景长尾**的瘦身：合并后的分组不变，按
      // SAFE_INJECTION_CAPS 截断群像/旧对话/自我笔记这类"多一点少一点不影响事实"的块。
      // 人设（当前角色/你自己）、消息快照、收尾、工具协议都不在白名单里——2026-10-28 的
      // 教训是"把人设截了"会让发言变差，这里绝不能重演。
      try {
        // [LOOKUP] 截断处挂入口：能查回来的块不让她以为"就这些了"
        const diet = compactInjection(wakeInjections, { caps: SAFE_INJECTION_CAPS, mergeGroups: [], hintFor: lookupHintFor });
        if (diet.trimmed.length) {
          log(`[prompt-diet] ${key} 注入层 ${diet.before}→${diet.after} 字（截 ${diet.trimmed.join('/')}；已挂追回入口）`);
          wakeInjections = diet.text;
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:980'); }
      // [PROMPT-HARD-CAP] 最终硬预算：基底（当前消息/人设/收尾）不动，只按优先级丢注入层长尾。
      // 以前只告警，实测会到 14k+；现在超过 budget 就丢块，宁可少一条背景，不让她看错消息。
      try {
        const available = Math.max(0, promptBudget - basePrompt.length);
        if (wakeInjections.length > available && typeof enforceInjectionBudget === 'function') {
          const fit = enforceInjectionBudget(wakeInjections, available, { placeholderFor: lookupHintFor });
          if (fit.dropped.length || fit.over) {
            const kept = Array.isArray(fit.placeholders) && fit.placeholders.length ? `；留指针 ${fit.placeholders.join('/')}` : '';
            log(`[prompt-cap] ${key} 注入层 ${fit.before}→${fit.after} 字（可用 ${available}；丢 ${fit.dropped.join('/') || '无'}${kept}${fit.over ? '；仍超保护块' : ''}）`);
          }
          wakeInjections = fit.text;
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:992'); }
      // [PROMPT-BUDGET] 分块计量：这里量的是最终投递文本（注入层 + 刷新后的基底），
      // 回答"这 9000 字是谁吃的"，而不是只记一个总数。
      try {
        const finalText = wakeInjections ? `${wakeInjections}\n\n${basePrompt}` : basePrompt;
        // 计量按**投递时**的形态算：deliverPromptNow 会再做一次 mergeBlocks，
        // 这里先合并一次，告警里的块数与实际投递一致（否则永远显示合并前的 40+ 块）。
        let measured = finalText;
        try { measured = mergeBlocks(measured); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:1000'); }
        const summary = summarizePrompt(measured, { top: 12 });
        log(`[prompt-budget] ${key} ${formatBudgetLine(summary)}（${reason}）`);
        // [BUDGET-TRACE] 全量块清单（一行可机检）：合并到底省了哪几块、还剩哪些小碎块，靠这行看
        try {
          const all = (summary.blocks || []).map((b) => `${b.label}:${b.chars}`).join(' ');
          log(`[prompt-budget] blocks ${key} ${summary.blockCount} 个 ｜ ${all}`);
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:1007'); }
        for (const w of budgetWarnings(summary, { maxTotal: promptBudget, maxBlock: budgetScene === 'private' ? 3000 : 2000, maxBlocks: 30 })) {
          log(`[prompt-budget] ⚠️ ${key} ${w}`);
        }
        // [ROLE-SHARE] 角色卡占场景预算的比例（SillyTavern 的经验红线：角色定义别超过上下文一半）。
        // 块级告警只看单块绝对字数，看不出"卡把预算吃光了"这种比例关系；这里单独量一次。
        try {
          const roleBlock = (summary.blocks || []).find((b) => String(b.label || '').includes('当前角色'));
          if (roleBlock && promptBudget > 0) {
            const share = roleBlock.chars / promptBudget;
            if (share > 0.5) {
              log(`[prompt-budget] ⚠️ ${key} 角色卡 ${roleBlock.chars} 字占场景预算 ${promptBudget} 的 ${Math.round(share * 100)}%（>50%：留给消息/记忆/关系的余地不足）`);
            }
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:role-share'); }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-sender.mjs:1011'); }
      const result = await deliverPrompt(key, promptText, { wakeReason: reason, wakeInjections });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  return {
    sendWakePromptV2,
  };
}
