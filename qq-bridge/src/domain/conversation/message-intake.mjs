// message-intake.mjs · 从 app.mjs 的 main() 搬出的调度层（2026-10-28 M-1）
//
// 为什么单独成模块：
//   handleIncoming 是"什么时候叫她、等多久、什么时候重试"的决策层。
//   以前它们和发送/状态/调度器混在 main() 的闭包里，改一个间隔只能靠线上日志验证；
//   搬出来之后，入参（依赖）和出参（计划/定时器）都是显式的。
//
// 依赖注入 + 懒构造：
//   调用方（app.mjs）在**第一次调用**时才构造本模块的实例并传入依赖快照，避免 main() 里
//   那些后声明的 const（TDZ）在构造期被提前求值。依赖对象被闭包持有；cfg/socialV2 这类
//   可变对象是原地修改，所以不会陈旧。
//
// 纪律：
//   · 本模块不 import 项目内任何东西（只可能用到全局定时器/日志函数，且也是注入的）。
//   · 新增依赖必须同时更新 app.mjs 的 deps 清单，否则这里会 ReferenceError。
export function createMessageIntake(deps) {
  const {
    DIRECTION_HINT,
    MAX_MEDIA_STORE_PER_KEY,
    QUEUE_HINT_COOLDOWN_MS,
    QUEUE_MAX,
    ROOT,
    SENSITIVE_RE,
    SILENT_MARKER,
    SPACE_SPLIT_HINT,
    allowed,
    api,
    appendActivity,
    appendRecentMessage,
    appendSocialV2Message,
    appendSummary,
    auditAndSend,
    bot,
    buildContextBlock,
    bumpSessionEpoch,
    classifyPragmaticFrame,
    createDiscourseState,
    updateDiscourseState,
    applyEmotionCalibration,
    detectEmotionCorrection,
    recordEmotionFeedback,
    cancelPendingEntry,
    cancelSocialTimers,
    cleanMemberName,
    clearSocialV2Timers,
    collectors,
    convKey,
    currentMode,
    getCurrentMode,
    getDshReady,
    currentRoleHint,
    deliverPrompt,
    drainPromptQueue,
    dshReady,
    enqueueForRetry,
    ensureSession,
    ensureChatModel,
    chatEffortFor,
    enterActive,
    evaluateWakeTriggerV2,
    extractForwardIds,
    extractLinks,
    extractMediaFromSegments,
    feedSlangWindow,
    firstReplyId,
    forgetAgentToken,
    formatForwardResponse,
    fs,
    getSocialV2State,
    handlePendingAnswer,
    isCurrentSession,
    isDirectAddress,
    isQuoteTargetOwner,
    isQuoteTargetSelf,
    isSessionAllowedInCurrentMode,
    isSocialEnabled,
    lifeNote,
    getLifeState,
    touchLifeInterest,
    log,
    markReadCalledKeys,
    maybeJoinOrContinue,
    mdToPlain,
    mediaHintFor,
    messageAtsSelf,
    messageMediaStore,
    modeAllowed,
    modelAppliedSessions,
    noteEdge,
    noteCorrection,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    polarityOf,
    queued,
    queuedHintAt,
    readPageForIntake,
    readRoleState,
    recordStickerCandidate,
    resolveGroupMemberName,
    resolveMediaList,
    resolveReplyInfo,
    reverse,
    sanitizeRoleName,
    saveSocialGraphSoon,
    saveSocialV2State,
    saveState,
    scheduleSocialReply,
    scheduleWakeV2,
    secretaryJudge,
    secretaryAllows,
    seedCuriosityFromChat,
    seenForwardIds,
    segmentsToText,
    selfNickname,
    sendNotice,
    sendToQQ,
    sendToolSucceededSessions,
    sessionPromises,
    shouldAuditKey,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialGraph,
    socialState,
    socialV2,
    state,
    submitPromptWithTurnSlot,
    toolCallNames,
    triggerActiveDurationExit,
    turnDispatch,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    withSlangContext,
    writeRoleState,
  } = deps;

  // [MODE-CONTEXT] currentMode/dshReady 是 app.mjs 的可变局部量。模块构造时传值会把
  // 启动那一刻的布尔值/字符串冻结在这里，之后控制台切模式、DSH 掉线恢复都看不到。
  // 优先用调用方注入的 getter；旧测试/旧调用仍可退回快照值。
  const modeNow = () => (typeof getCurrentMode === 'function' ? getCurrentMode() : currentMode);
  const dshReadyNow = () => (typeof getDshReady === 'function' ? getDshReady() : dshReady);

async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    // [LIFE] 他/群里的消息把她叫醒：sleep → 45 分钟清醒窗口（mizuse 设计）
    // [SLEEP-SPEC] 睡实了=真休眠：只有「私聊」或「群里@她」才叫醒；群里的闲话不吵醒她
    try {
      const canWake = kind === 'private' || (kind === 'group' && messageAtsSelf(event));
      // [LIFE-FRESH] 取现值，不拿构造时快照；写盘交回 app（touchLifeInterest），
      // 否则这里会把旧 lifeState 整个回写，覆盖掉 slept/债/physTick 的推进。
      const lifeNow = typeof getLifeState === 'function' ? getLifeState() : null;
      if (lifeNow?.state === 'sleep' && canWake) lifeNote({ type: 'incoming', fromSleep: true }, { log: `${key} ${kind === 'private' ? '（私聊）' : '（群@）'}把她叫醒了` });
      if (typeof touchLifeInterest === 'function') touchLifeInterest(); // 有人找她 = 有意思的事，无聊度归零锚点
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:159'); }
    if (!modeAllowed(key, kind, id, cfg, modeNow())) {
      log(`[allow] 丢弃 ${key}（不在名单，来自 ${event.user_id}）—— 不进入后端`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    let textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    // [ASR] 收到的语音：QQ 侧对"别人发来的语音"有转写，拉回来补进文本。
    // 不加这一步她只看到「[语音]」，等于听不见。转写不可用时静默跳过，不影响正常收信。
    try {
      const segs = Array.isArray(event.message) ? event.message : [];
      const hasRecord = segs.some((s) => s && s.type === 'record');
      const mid = event.message_id ?? event.msg_id ?? null;
      if (hasRecord && mid != null && cfg.socialV2?.asr?.enabled !== false) {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(mid) }),
          signal: AbortSignal.timeout(20000)
        });
        const rb = await res.json().catch(() => ({}));
        const said = rb?.data?.text;
        if (res.ok && rb.status === 'ok' && rb.retcode === 0 && said) {
          // 按码点截断：slice() 数的是 UTF-16 码元，emoji 跨在 300 边界会截出孤立代理项。
          const saidText = [...String(said)].slice(0, 300).join('');
          const note = `（语音转文字：${saidText}）`;
          textContent = textContent.replace('[语音]', '[语音] ') + ' ' + note;
          log(`[asr] ${key} 语音已转文字（${saidText.length} 字）`);
        } else {
          log(`[asr] ${key} 语音转写不可用（retcode=${rb.retcode ?? '?'}）`);
        }
      }
    } catch (error) {
      log(`[asr] 转写失败（已忽略）: ${error?.message ?? error}`);
    }
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    // [FORWARD] 合并转发预读：转发卡片进来时自动拉回原文（bot.raw get_forward_msg 与 MCP 端点同一 API），
    // 她直接读到内容；此前只见「[转发消息 id=…]」占位符，内容实际丢失。
    // 工具 qq_get_forward_msg 保留给她深读；这里只补前 N 条 + 截断标注。
    // 转发记录里的图片段一并提取（fwdMedia），在下方 mediaByRef 处并入同一附件链（现有 fetch→像素检查→base64→mediaType）。
    let fwdMedia = [];
    try {
      if (cfg.socialV2?.forward?.enabled !== false) {
        const fwdIds = extractForwardIds(Array.isArray(event.message) ? event.message : []);
        if (fwdIds.length) {
          const cap = Number(cfg.socialV2?.forward?.maxChars) || 1200;
          const parts = [];
          for (const fid of fwdIds.slice(0, 3)) {
            let fwdTimer = null;
            try {
              // 超时计时器必须自己清：以前每条卡片留一个 5s 未清除的 setTimeout，
              // 一条消息最多 3 张卡，事件循环被白拖 5 秒（测试进程也一样）。
              const data = await Promise.race([
                bot.raw('get_forward_msg', { id: fid }),
                new Promise((_, rej) => { fwdTimer = setTimeout(() => rej(new Error('timeout')), 5000); }),
              ]);
              const f = formatForwardResponse(data);
              if (f.messages.length) {
                let body2 = f.messages.map((m) => {
                  const imgs = (m.media ?? []).filter((x) => x?.kind === 'image');
                  const thumbs = (m.media ?? []).filter((x) => x?.kind === 'video-thumb');
                  const visParts = [
                    imgs.length ? `${imgs.length} 张图` : '',
                    thumbs.length ? `${thumbs.length} 个视频封面` : ''
                  ].filter(Boolean).join('、');
                  const suffix = [];
                  if (m.nestedForwardIds?.length) suffix.push('（内含另一张转发卡片，工具可再读）');
                  if (visParts) suffix.push(`（${m.sender || '对方'}附了 ${visParts}）`);
                  return `${(m.sender || '?')}：${m.text}${suffix.join('')}`;
                }).join('\n');
                const head = `【转发的聊天记录，${f.total} 条${f.truncated ? '（已截断）' : ''}——这是别处的对话，不是本群说的话】`;
                if ([...body2].length > cap) body2 = body2.slice(0, cap) + '……（更长内容用 qq_get_forward_msg 工具读）';
                parts.push(`${head}\n${body2}`);
                // 提取转发节点里的图片段（node.message / node.data.message / node.data.content），
                // 交给下方 mediaByRef 合并——图片字节获取走的就是正常消息那条现成链路。
                if (cfg.socialV2?.forward?.images !== false) {
                  for (const node of (Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []))) {
                    const arr = Array.isArray(node?.message) ? node.message
                      : Array.isArray(node?.data?.message) ? node.data.message
                      : Array.isArray(node?.data?.content) ? node.data.content
                      : Array.isArray(node?.content) ? node.content : null;
                    if (arr) fwdMedia = fwdMedia.concat(extractMediaFromSegments(arr));
                  }
                }
              }
            } catch (e2) {
              log(`[forward] ${key} 卡片 ${fid.slice(0, 12)} 预读失败（可用工具重试）: ${e2?.message ?? e2}`);
            } finally {
              if (fwdTimer) clearTimeout(fwdTimer);
            }
          }
          if (parts.length) {
            textContent = (textContent ? textContent + '\n' : '') + parts.join('\n');
            log(`[forward] ${key} 预读 ${fwdIds.length} 张转发卡片（图 ${fwdMedia.length} 张待并入附件）`);
          }
        }
      }
    } catch (error) {
      log(`[forward] 预读异常（已忽略）: ${error?.message ?? error}`);
    }
    // [FORWARD] 粘贴型聊天记录检测：≥3 个「人名：内容」独立行 → 标注为"转述材料"，
    // 防止她把别处的对话当成"本群正在说的话"（确定性判定，误报代价只是一行提示）。
    try {
      const pasteTurns = plainContent.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[^\n:：]{1,12}[:：]/.test(l) && l.length > 4).length;
      if (pasteTurns >= 3) {
        textContent = (textContent ? textContent + '\n' : '') + '【提示：上面的文字像是别人粘贴/转述的聊天记录，不是本群此刻说的话——按材料读，别当成大家在这说的话】';
        log(`[forward] ${key} 检测到粘贴型聊天记录（${pasteTurns} 个对话行），已标注`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:273'); }
    // [INTAKE] 收消息即预读链接：合批窗口（约 8 秒）正好用来渲染，
    // 这样唤醒路径读到的通常是缓存，等待接近 0（渲染一个 SPA 约 4~9 秒）。
    try {
      if (cfg.socialV2?.intake?.linkRead !== false) {
        const earlyLinks = extractLinks(textContent, Number(cfg.socialV2?.intake?.maxLinks) || 2);
        if (earlyLinks.length) {
          void readPageForIntake(earlyLinks[0], true);
          log(`[intake] 预读链接（收消息即开始）: ${earlyLinks[0].slice(0, 60)}`);
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:284'); }
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // [FORWARD] 转发记录里的图片并入同一 media store：
    // 图片段的 url/file 元数据已由 extractMediaFromSegments 提取，
    // 取字节、像素检查、base64、mediaType 注入全部走正常消息那条现成链路（零重复实现）。
    if (refsToStore.length > 0 && fwdMedia.length) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) {
        const base = mediaByRef.get(ref) ?? [];
        const merged = base.concat(fwdMedia);
        mediaByRef.set(ref, merged.length > 8 ? merged.slice(0, 8) : merged); // 总附件数封顶，防 prompt 膨胀
      }
      log(`[forward] ${key} 转发记录图片 ${fwdMedia.length} 张已并入附件存储`);
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    const quoteTargetIsOwner = await isQuoteTargetOwner(event.message ?? [], kind, id, cfg.ownerQQ).catch(() => false);
    if (!isSessionAllowedInCurrentMode(key)) return;
    // 纯媒体（只发图/表情、无文字、非引用）：群聊仍丢弃，避免对每个表情都回话；
    // 私聊放行 —— 「只发一张图」本身就是在对她说，prompt 里由 mediaHintFor 带上
    // 媒体提示（reserved2 下附 qq_get_message_images 的读取方式），她能看再决定回不回。
    const privateMediaOnly = kind === 'private' && Array.isArray(mediaList) && mediaList.length > 0;
    if (!plainContent && !quoteTargetIsSelf && !privateMediaOnly) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    // [RESET] 例外：管理员的 /reset、/new 是命令，不能被挂起的提问当回答吃掉
    // （否则 /reset 内的 pending 清理永远不可达，挂起时重置失效）。
    const isResetCommand = isOwner && (plainContent === '/reset' || plainContent === '/new');
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner) && !isResetCommand) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          bumpSessionEpoch();
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/message-intake.mjs:386'));
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:402'); }
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (modeNow() === 'reserved2') {
      // [NAME-CLEAN] 彩色昵称的控制码/配色码在入口洗掉，图谱/记忆/摘要都不再带乱码
      const sender = kind === 'group' ? cleanMemberName(event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      // [SOCIAL-GRAPH] 记「谁接谁的话 / 谁和谁搭话」的成对边（只记群；失败不影响消息）
      try {
        if (kind === 'group') {
          const pol = polarityOf(plainContent);
          const replyId = firstReplyId(event.message ?? []);
          if (replyId != null) {
            const quoted = await resolveReplyInfo('group', id, String(replyId), event.self_id ?? null);
            if (quoted && quoted.sender && (!quoted.senderUserId || String(quoted.senderUserId) !== String(event.self_id))) {
              if (noteEdge(socialGraph, key, sender, quoted.sender, 'reply', Date.now(), { polarity: pol, fromId: event.user_id, toId: quoted.senderUserId })) saveSocialGraphSoon();
            }
          }
          const prev = (getSocialV2State(key).recentMessages ?? []).slice(-1)[0];
          if (prev && prev.sender && prev.sender !== sender) {
            if (noteEdge(socialGraph, key, sender, prev.sender, 'adjacent', Date.now(), { polarity: pol, fromId: event.user_id, toId: prev.userId })) saveSocialGraphSoon();
          }
          // @ 提及边：消息里 at 了谁（跳过她自己和 @all）
          try {
            for (const seg of Array.isArray(event.message) ? event.message : []) {
              if (seg?.type !== 'at' || seg.data?.qq == null) continue;
              const atQq = String(seg.data.qq);
              if (atQq === 'all' || (event.self_id != null && atQq === String(event.self_id))) continue;
              let atName = atQq;
              // [GRAPH-FIX] resolveGroupMemberName 是 async：漏 await 会把 "[object Promise]" 写进图谱
              try { atName = (await resolveGroupMemberName(id, atQq)) || atQq; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:468'); }
              if (atName && noteEdge(socialGraph, key, sender, atName, 'mention', Date.now(), { fromId: event.user_id, toId: atQq })) saveSocialGraphSoon();
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:471'); }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:473'); }
      appendSocialV2Message(
        key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner,
        event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []),
        { selfId: event.self_id, mentionedIds: (Array.isArray(event.message) ? event.message : []).filter((seg) => seg?.type === 'at' && seg.data?.qq != null).map((seg) => String(seg.data.qq)) },
      );
      // [LIVE-LEARN] 主人纠正一进来就写进 session-notes，不等下一次唤醒再扫。
      try { noteCorrection?.(key, plainContent, isOwner); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:476'); }
      // [PRAGMATICS-STREAM] 每一条真人消息都更新会话语境，而不是只在唤醒时看最后一句。
      try {
        const stMsg = getSocialV2State(key);
        const recentTexts = (Array.isArray(stMsg.recentMessages) ? stMsg.recentMessages : []).slice(-6).map((m) => (m && !m.isSelf ? String(m.text || '') : '')).filter(Boolean);
        const frame = typeof classifyPragmaticFrame === 'function'
          ? classifyPragmaticFrame(plainContent, { key, recent: recentTexts })
          : null;
        if (frame) {
          // [EMOTION-CALIBRATION] 只有明确的“没有啦/只是忙/你想多了”才算纠正；
          // 沉默/短回复不更新，避免把冷淡误学成“猜错了”。
          if (stMsg.lastEmotionGuess && typeof detectEmotionCorrection === 'function'
              && detectEmotionCorrection(plainContent)) {
            stMsg.emotionCalibration = recordEmotionFeedback(stMsg.emotionCalibration, {
              key, label: stMsg.lastEmotionGuess.label, corrected: true,
            });
          }
          if (typeof applyEmotionCalibration === 'function') {
            frame.emotion = applyEmotionCalibration(frame.emotion, stMsg.emotionCalibration, key);
          }
          stMsg.lastPragmaticFrame = { ...frame, seq: stMsg.lastUnreadSeq, text: plainContent };
          if (frame.emotion && frame.emotion.label !== 'unknown' && Number(frame.emotion.confidence) >= 0.4) {
            stMsg.lastEmotionGuess = { label: frame.emotion.label, confidence: frame.emotion.confidence, at: Date.now() };
          }
          stMsg.discourse = updateDiscourseState(stMsg.discourse || createDiscourseState(), frame, {
            text: plainContent,
            speaker: sender,
            now: Date.now(),
          });
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:506'); }
      // [STICKER-POOL] 群里的图/表情先进候选池（她决定收不收，不自动入库）
      try { recordStickerCandidate(key, mediaList, sender, event.message_id ?? event.msg_id ?? null); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:508'); }
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        try { seedCuriosityFromChat(key, st); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:521'); } // [CURIOSITY-SEED]
        // [ALIAS-COOLDOWN] 「议论她」同一个人 10 分钟内只叫醒一次：
        // 否则一个爱提她名字的人会把整场对话都变成「他们在说你」，她就反复醒来接错话题。
        const aliasSenderId = String(event?.user_id ?? event?.sender?.user_id ?? '');
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf, {
          cfg,
          selfNickname,
          aboutSelfAllowed: (senderId) => {
            const last = st.lastAboutSelf;
            return !(last && String(last.senderId ?? '') === String(senderId)
              && Date.now() - Number(last.at || 0) < 10 * 60 * 1000);
          },
        });
        // [SECRETARY] 非定向唤醒先过一道语义门：问一句「这条是在跟她说吗/她此刻接合不合适」。
        // 判不了（模型没起/超时/坏输出）一律放行；只有模型明确 should_reply=false 才不派回合（addressed 只进日志）。
        let verdict = null;
        try {
          if (reason && typeof secretaryJudge === 'function') {
            verdict = await secretaryJudge({ key, st, reason, sender, text: plainContent });
          }
        } catch { verdict = null; }
        const secretaryOk = typeof secretaryAllows === 'function' ? secretaryAllows(verdict) : true;
        if (reason && secretaryOk) {
          if (reason.startsWith('aboutSelf')) {
            st.lastAboutSelf = { senderId: aliasSenderId, at: Date.now() };
            saveSocialV2State();
          }
          scheduleWakeV2(key, reason);
        } else if (reason) {
          // 秘书拦下：不派回合，消息留在未读里（下次有机会再判）
          try {
            log(`[secretary] ${key} 拦下唤醒 ${reason} → ${verdict?.addressed || '?'}/${verdict?.why || ''}`);
            appendActivity(`${key} [secretary] 拦下 ${reason}（${verdict?.addressed || '?'}）`);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'message-intake.mjs:554'); }
        } else if (kind === 'group') {
          // [JOIN] 没人叫她、但群在聊 / 她在跟人聊着：看看要不要给她一次接话机会
          maybeJoinOrContinue(key, st);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【他】' : '')
      + (quoteTargetIsOwner ? '【接的是他的话】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      // [NAME-CLEAN] 同上：入站名字统一在这里洗一次
      const sender = kind === 'group' ? cleanMemberName(event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【他】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      // [TDZ] 这里曾经又写了一次 `const roleHint`，与外层 :570 同名：块内 TDZ 让上面
      // 「活跃私聊即时投递」分支引用 roleHint 时直接 ReferenceError（私聊在活跃期永不回）。
      // 外层值就是本次消息的同一个快照，直接复用。
      const currentLine = (isOwner && kind === 'private') ? `【他】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReadyNow()) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendNotice(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    // [SCENE-EFFORT] 私聊用更低的思考档换速度；群/任务仍按全局（max）。失败不挡投递。
    if (typeof ensureChatModel === 'function') {
      try { await ensureChatModel(sessionId, typeof chatEffortFor === 'function' ? chatEffortFor(key) : null); } catch { /* best-effort */ }
    }
    const accepted = await submitPromptWithTurnSlot({
      sessionId,
      label: key,
      kind: 'chat',
      content,
      useSlot: !turnDispatch.isActive(sessionId),
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendNotice(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && modeNow() !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  return {
    handleIncoming,
  };
}
