import { isDirectedAtAi as isDirectedAtAiPure } from '../leaves/inori-directed.js';
import { DshUpstreamDownError } from '../conversation/dsh-degraded.mjs';
// 社交核心：状态机、上下文块、活跃/退场提示、prompt 投递串行队列。
//
// 从 app.mjs 的 main() 搬出（P3-RW-25，2026-10-31）。social / socialV2 / promptQueues 仍是
// app 持有的同一实例；所有策略函数经 deps 注入。
/**
 * @param {object} ctx
 */
export function createSocialCore(ctx) {
  const {
    getCurrentMode, cfg, social, socialV2, selfNickname, truncateText, mediaHintFor, randInt,
    lifeTimePre, ruminationPre, DIRECTION_HINT, SPACE_SPLIT_HINT, SILENT_MARKER,
    currentRoleHint, getScheduleSocialReply, log, messageMediaStore, promptQueues,
    isSessionAllowedInCurrentMode, pendingWakeKeys, disarmPendingWakeLease, getDshReady,
    queued, QUEUE_MAX, ownerLaneFor, OWNER_LANE_SUFFIX, ensureSession, enqueueForRetry,
    buildFreedomPolicy, formatFreedomLog, recordFreedomPolicy, stateDataPath,
    renderFreedomPermission, renderAgencyBlock, renderPragmaticContext, buildWakePromptV2,
    buildWakeSnapshotV2, renderWakeSnapshotV2, getSocialV2State, mergeBlocks, withSlangContext,
    resolveMediaList, isCurrentSession, submitPromptWithTurnSlot, turnDispatch, shouldAuditKey,
    SENSITIVE_RE, sendNotice, canonicalV2Key, noteModelMessagesV2, auditAndSend, mdToPlain,
  } = ctx;
  function isSocialEnabled() {
    return getCurrentMode() === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：规则全在 inori-directed.js（纯函数，可单测）。
  // 2026-10-25 夜用群里 423 条真实消息回归修掉三处误判：裸「说话」当催促、
  // 引用里别人的正文被当本条内容、以及单字名误触发——细节见模块文件头。
  function isDirectedAtAi(textContent) { return isDirectedAtAiPure(textContent); }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【他】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lifeLine = lifeTimePre(); // [LIFE] 时间段 + 她的状态
    const lifePre = lifeLine ? lifeLine + '\n\n' : '';
    const rumLine = ruminationPre(key); // [RUMINATE] 她一直惦记的事
    const rumPre = rumLine ? rumLine + '\n\n' : '';
    const lines = newMsgs.map((m) => `${m.isOwner ? '【他】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `${lifePre}${rumPre}【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `${lifePre}${rumPre}【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    const lifePre = lifeTimePre() ? lifeTimePre() + '\n\n' : '';
    const rumLine = ruminationPre(key); // [RUMINATE] 冷场时最容易想起惦记的事
    const rumPre = rumLine ? rumLine + '\n\n' : '';
    return `${lifePre}${rumPre}【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    getScheduleSocialReply()(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    const lifeLine = lifeTimePre(); // [LIFE] 时间段 + 她的状态
    if (lifeLine) p += lifeLine + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (getCurrentMode() !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!getDshReady()) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    // [PERM-BY-PERSON] 群里 owner 刚说话 → 这轮投到 owner lane（admin 会话）；其余仍走主会话(v2)
    const laneKey = opts.wakeReason && ownerLaneFor(key) ? `${key}${OWNER_LANE_SUFFIX}` : key;
    try {
      sessionId = await ensureSession(laneKey);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    // [FREEDOM-OBSERVE] 记录她这轮有哪些选择；许可句只给选项，不下命令。
    let freedomLine = '';
    let agencyLine = '';
    let pragmaticLine = '';
    if (opts.wakeReason) {
      try {
        const policy = buildFreedomPolicy({
          key,
          mode: getCurrentMode(),
          ownerQQ: cfg.ownerQQ,
          cfg,
          state: getSocialV2State(key),
        });
        log(formatFreedomLog(policy));
        recordFreedomPolicy(policy, { file: stateDataPath('freedom-log.jsonl') });
        freedomLine = renderFreedomPermission(policy);
        agencyLine = renderAgencyBlock();
        pragmaticLine = renderPragmaticContext(key);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-core.mjs:7323'); }
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    // [WATERMARK-ACCEPT] 这个值只在 prompt 真正被 DSH 接受后才写进 lastPromptSeq；
    // 提前写会让“投递被拒/预算拒绝”的回合被补发逻辑误判成已展示。
    let promptReadThrough = 0;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      // 基底重算只刷新令牌/收尾提示；注入层由 sendWakePromptV2 通过 wakeInjections 携带
      // （[WAKE-INJ-FIX]：旧代码在这里把注入层整体丢弃，她的记忆/经验/目标从未进对话唤醒）。
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      if (typeof opts.wakeInjections === 'string' && opts.wakeInjections) {
        promptText = opts.wakeInjections + promptText;
      }
      if (freedomLine) promptText += `\n\n${freedomLine}`;
      if (agencyLine) promptText += `\n\n${agencyLine}`;
      if (pragmaticLine) promptText += `\n\n${pragmaticLine}`;
      wakeSnapshot = buildWakeSnapshotV2(key);
      // [WATERMARK-SSOT] 这一轮真正的「已展示水位」只认快照算出来的 readThroughSeq。
      // 旧实现给她的提示用的是 readThroughSeqV2(st)（没算本次新装的消息），
      // lastPromptSeq 又写成 lastUnreadSeq（整条未读队列），三处口径不同：
      // 她按提示 mark_read 会低报，按看到的 seq 传又会 400，补发判断还会把没展示的 @ 当已展示。
      promptReadThrough = wakeSnapshot
        ? Number(wakeSnapshot.readThroughSeq) || 0
        : Number(getSocialV2State(key).lastReadThroughSeq) || 0;
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${renderWakeSnapshotV2(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq —— **直接传这个数：${promptReadThrough}**（它是不超过"已展示连续消息"的最大值；不要用你看到的最大 seq，超过它会 400）；新到消息留待处理。`;
        if (wakeSnapshot.partial) promptText += `\n【未读没带完】未读共 ${wakeSnapshot.unreadCount} 条，这次带了 ${wakeSnapshot.includedUnreadCount} 条（从最早的开始），还有 ${wakeSnapshot.omitted} 条没展开${wakeSnapshot.trigger ? '；叫醒你的那条已单独放在 trigger' : ''}。需要时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读。`;
        // [IDLE-SNAPSHOT] 空闲唤醒（没有未读）里附带的 recent 是已读旧话：明确告诉她别重答。
        if (wakeSnapshot.readContext) promptText += '\n【recent 是已读旧话】上面 recent 里的消息已经读过、也回过了，不是这轮的新输入：不要把它们当成新消息再回一遍；没有新事要接就安静收尾（qq_mark_read 或 qq_set_wake_config），别为了说话而说话。';
      }
    }
    // [OWNER-LANE-NO-TOKEN] 群 owner lane 现在只保留独立上下文（preset = qq-chat-v2），
    // 不再注入 ownerAgentToken：否则群内容诱导它调 handoff-task 时，任务会被当成
    // “主人发起”而拿到 admin preset——那等于绕过“群会话不挂本地工具”的硬边界。
    // 主人的全权限只留在 owner 私聊和主人私聊派出的任务会话。

    // [BLOCK-CONSOLIDATE] 无损合并同类块：只把「同一件事的几个视图」收进一个标题下
    // （群里的人/群习惯/群倾向/水群适应度 → 群里的动静；开口时机/首回复节奏/先回话/
    // 唤醒 → 开口与节奏；自我类 → 你最近；表情三块 → 表情包；状态两块 → 现在的状态）。
    // 一个字都不删，只减少平铺标题——39~49 个块时模型分不清主次（prompt-budget 告警）。
    try { promptText = mergeBlocks(promptText); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-core.mjs:7370'); }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(laneKey, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await submitPromptWithTurnSlot({
        sessionId,
        label: key,
        kind: 'chat',
        content,
        useSlot: !turnDispatch.isActive(sessionId),
      });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      if (error instanceof DshUpstreamDownError) {
        // [DEGRADED] DSH 上游不可达：状态提示 + 优雅返回，不让用户看到崩溃或无限等待。
        // 未处理回合已在 submitPromptWithTurnSlot 内缓冲到 state/dsh-down-queue.jsonl，
        // 待 DSH 恢复后由控制台 /api/admin/dsh-replay（dshReplay）重投。
        // degradedMode.enabled 为 false 时不做降级，原样抛出（回到无降级行为）。
        if (cfg.dsh?.degradedMode?.enabled !== false) {
          const notice = cfg.dsh?.degradedMode?.notice
            ?? '⚠️ 上游大脑暂时连不上（DSH 不可达），你的消息已排队，恢复后我会补处理。';
          if (!opts.silent) { try { await sendNotice(key, notice); } catch { /* best-effort */ } }
          return { ok: false, degraded: true, error: 'dsh-upstream-down' };
        }
        throw error;
      }
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendNotice(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(laneKey, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    // [WATERMARK-ACCEPT] 只有真正被 DSH 接受的唤醒才推进补发判断水位；
    // 上面的 rejected/throw 路径不会走到这里，避免“没投出去却把 @ 标成已展示”。
    if (opts.wakeReason && wakeState && isCurrentSession(laneKey, sessionId)
        && wakeState.agentToken === wakeToken) {
      try { wakeState.lastPromptSeq = promptReadThrough; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-core.mjs:7410'); }
    }
    if (accepted.result.value.command?.text && !opts.silent && getCurrentMode() !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  return {
    isSocialEnabled, socialState, isDirectAddress, isDirectedAtAi, isMustReplyText,
    appendRecentMessage, appendSummary, buildContextBlock, enterActive, cancelSocialTimers,
    cancelAllSocialTimers, cleanupSocialForModeChange, leaveActive, buildBatchPrompt,
    buildProbePrompt, buildActiveExitPrompt, triggerActiveDurationExit, buildProactivePrompt,
    deliverPromptNow, deliverPrompt, processPromptQueue,
  };
}
