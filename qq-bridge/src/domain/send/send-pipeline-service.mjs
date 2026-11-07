import { SENSITIVE_RE } from '../shared/sensitive.js';
import { KNOWN_AGENT_TOKENS } from '../../bootstrap/agent-tokens.mjs';
// 出站发送流水线：媒体提示、引用查找、气泡拆分/间隔、发送前审计、发送后反馈。
//
// 从 app.mjs 的 main() 搬出（P3-RW-48，2026-11-01）。发送器/审计/情绪/兴趣全部注入；
// 本模块只决定「拆几条、隔多久、要不要拦、发完记什么」。
/**
 * @param {object} ctx
 */
export function createSendPipeline(ctx) {
  const {
    cfg, log, state, getSocialV2State, saveSocialV2State, isSessionAllowedInCurrentMode,
    // [WIRING-FIX] 生活状态/回合已读头都是 main() 的局部状态（原来裸引用 → 记账与 intake 分支会炸）
    getLifeState, getTurnSeenHeads,
    // [WIRING-FIX] saveLifeFile 之前只在正文里裸用（try/catch 吞成静默失败：兴趣记账永远不落盘）
    saveLifeFile,
    getCurrentMode, onebotSend, sendToQQ, sendNotice, sessionPolicy,
    splitClauses, stripSelfQuoting, createSendGuard, ackCeilForReply, autoAckAfterSend,
    maybeIntake, relevanceCos, sleep, randInt, loadMoodState, saveMoodState,
    noteMoodReply, effectiveWarmth, detectSleepClaim, detectLateSleepClaim, lifeNote,
    loadInterestEncounters, saveInterestEncounters, detectLikes, recordEncounter,
    markInterest, addRumination, detectRumination, scheduleChaseV2,
    setInputStatus, shouldBlockSilentReplyPure, groupMutedUntil, muteSkip,
    // [WIRING-FIX-2] 静默闸门要读角色状态；原来在这里裸引用 main() 的局部函数 → 每次发送都 ReferenceError
    readRoleState,
    appendActivity, outgoing, sendLedger, getMessageMediaStore, getSocialV2,
  } = ctx;
  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (getCurrentMode() === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (getCurrentMode() === 'reserved2' || getSocialV2().conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6018'); }
    }
    // 一代/普通模式：messageMediaStore
    const byRef = getMessageMediaStore().get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      // [HUMANLIKE] auto 模式改为「按字数算打字时长 + 抖动 + 长停顿」。
      // 原实现是纯随机 burstInterval[min,max]，与字数无关 —— 回「嗯」和回一段话一样快。
      // 这里用「下一条」的字数估算打字耗时（i→i+1 的间隔花在打第 i+1 条上），
      // 叠加 ±15% 抖动，并保留 longGapProbability 的长停顿。
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      const hBase = Math.max(0, Number(sendCfg.gapBaseMs) || 800);
      const hPerChar = Math.max(0, Number(sendCfg.gapPerCharMs) || 20);
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        if (useLong) {
          const lo = Math.max(100, Number(sendCfg.longGapMinMs) || 5000);
          const hi = Math.max(lo, Number(sendCfg.longGapMaxMs) || 10000);
          delays.push(clampGapV2(randInt(lo, hi), sendCfg));
          continue;
        }
        const nextChars = [...String(messages[i + 1] ?? '')].length;
        const typed = hBase + hPerChar * Math.max(1, nextChars);
        const jitter = typed * 0.15;
        delays.push(clampGapV2(randInt(Math.max(100, Math.round(typed - jitter)), Math.round(typed + jitter)), sendCfg));
      }
    }
    return delays;
  }

  async function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    // 先把"逗号长句"拆成多条气泡，再按拆后的条数补齐间隔。
    // [FORMAT-OWN] clauseSplit.enabled === false 时不做机械拆条：她自己决定分几条（提示词【怎么发】）。
    const sendCfgNow = cfg.socialV2?.send ?? {};
    messages = splitClauses(messages, sendCfgNow.clauseSplit ?? {});
    // [QUOTE-FIX] 实测量：「行，那我安静会儿」整条被「」包住 → 剥掉；剥成空的丢弃
    // [FORMAT-OWN] quoteFix === false 时同样跳过，交给她自己把握。
    if (cfg.socialV2?.send?.quoteFix !== false) {
      const beforeQ = messages.slice();
      messages = messages.map((m) => stripSelfQuoting(m)).filter(Boolean);
      const fixed = messages.filter((m, i) => m !== beforeQ[i]).length;
      if (fixed) log(`[quote-fix] ${key} 去掉自我括号 ${fixed} 条`);
      // [SEND-EMPTY] 不能 return undefined：调用方按数组取 .length，会抛 TypeError 并且
      // 在抛之前已经把"她开口了"记进状态。空内容当成一次明确的业务失败返回给她。
      if (!messages.length) {
        const err = new Error('没有可发送的内容（剥掉自我括号后为空）');
        err.code = 'SEND_EMPTY';
        err.sent = [];
        throw err;
      }
    }
    // [SEND-LEDGER] 跨重启幂等：重启后同一批文本被重发时挡掉（tool→tool 10 分钟窗口）。
    // 拦不住就照发——账本永远不能让她哑火。
    try {
      const beforeLedger = messages.length;
      messages = messages.filter((m) => !sendLedger.shouldSkip(key, m, 'tool'));
      if (messages.length < beforeLedger) log(`[dedupe] ${key} 跳过 ${beforeLedger - messages.length} 条重复（工具重发）`);
      // [SEND-DEDUPED] 旧实现这里 return undefined：调用方 `sentMessages.length` 抛
      // TypeError（消息其实没发），但 "lastAiReplyAt/noActionCount/silentStreak" 已被
      // 记成"她说话了"。改成显式失败，让调用方走 catch 回滚额度并如实告诉模型。
      if (!messages.length) {
        const err = new Error('这句话 10 分钟内已经发过（去重账本拦截），这次没有重复发送');
        err.code = 'SEND_DEDUPED';
        err.sent = [];
        throw err;
      }
    } catch (error) {
      // [AUDIT-FIX] SEND_DEDUPED 是上面 try 内主动抛出的业务失败，不能当"账本异常"吞掉：
      // 吞掉后 messages 为空却继续往下走，调用方会拿到"成功但一条没发"。
      if (error?.code === 'SEND_EMPTY' || error?.code === 'SEND_DEDUPED') throw error;
      log(`[dedupe] 账本检查失败（忽略）: ${error?.message ?? error}`);
    }
    // [SEND-ADVISORY] 群聊工具发送也只看一眼：接不上就记日志，不拦（用工具开口是她自己的明确选择）。
    if (String(key).startsWith('group:') && messages.length) {
      try {
        const stG = getSocialV2State(key);
        const recent = (Array.isArray(stG?.recentMessages) ? stG.recentMessages : [])
          .filter((m) => m && !m.isSelf && (m.text || m.plain))
          .slice(-6)
          .map((m) => String(m.text || m.plain));
        if (recent.length >= 2 && [...messages.join('。')].length >= 6) {
          const r = await relevanceCos(messages.join('。'), recent);
          if (r && r.cos < 0.40) log(`[send-advisory] ${key} 工具发送话题可能接不上｜cos=${r.cos.toFixed(2)}（只记录，不拦）`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6116'); }
    }
    if (messages.length > delays.length) {
      const pad = delays.length ? delays[delays.length - 1] : (Number(sendCfgNow.burstIntervalMinMs) || 800);
      while (delays.length < messages.length - 1) delays.push(pad);
    }
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // [HUMANLIKE] 私聊整批期间打开「正在输入」，结束后关掉。
    // 群聊没有这个接口（set_input_status 只收 user_id），所以只在 private 下调用。
    if (kind === 'private' && messages.length > 0) void setInputStatus(Number(id), true);
    const finishTyping = () => { if (kind === 'private') void setInputStatus(Number(id), false); };
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      outgoing.enqueue(async () => {
        try {
          assertSendAllowed();
          if (kind === 'group' && await groupMutedUntil(id)) { muteSkip(key); failed.push(new Error('禁言中，跳过投递')); return; }
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
          // [SEND-LEDGER] 记一笔「这句工具发出去了」，重启后自动转发靠它让路
          try { sendLedger.note(key, msg, 'tool'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6141'); }
        } catch (error) {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        }
      });
      if (i < delays.length) {
        const d = delays[i];
        outgoing.enqueue(() => sleep(d));
      }
    }
    return outgoing.whenIdle().then(() => {
      finishTyping();
      if (sent.length) autoAckAfterSend(key, ackCeilForReply(key, replyToMessageId));
      // [METRICS] 工具发送也算「她开口了」——否则指标只统计自动转发，误开口率永远算不出来
      try {
        if (sent.length && String(key).startsWith('group:')) {
          const stM = getSocialV2State(key);
          const m = stM.metrics = stM.metrics || { wakes: 0, wakesDirected: 0, sends: 0, sendsUndirected: 0, pickedUp: 0, missedDirected: 0 };
          m.sends += 1;
          if (!stM.pendingDirectedWake) m.sendsUndirected += 1;
          stM.sentAfterWake = true;
          stM.pendingDirectedWake = false;
          stM.awaitingPickup = true;
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6166'); }
      // [MOOD] 她说完话后更新自己的状态：短句降温、长句回暖但耗精力（见 inori-state.js）
      try {
        if (sent.length) {
          const mst = loadMoodState(cfg.socialV2?.mood?.file);
          for (const m of sent) noteMoodReply(mst, m, Date.now(), key);
          mst.lastTalkAt = Date.now();
          saveMoodState(mst, cfg.socialV2?.mood?.file);
          log(`[mood] 发出 ${sent.length} 条后：温度=${effectiveWarmth(mst, key).toFixed(2)}（全局 ${mst.warmth.toFixed(2)}）精力=${mst.energy.toFixed(2)} 连续短句=${mst.shortStreak}`);
        }
      } catch (error) {
        log(`[mood] 状态更新失败（已忽略）: ${error?.message ?? error}`);
      }
      // [LIFE] 她声明"睡了/睡晚"→ 状态账本生效：话语有代价（说睡了=真的停手）
      try {
        for (const m of sent) {
          const mt = String(m?.text ?? m ?? '');
          if (detectSleepClaim(mt)) {
            lifeNote({ type: 'sleep_claimed' }, { log: '她说她要睡了（睡着期间不发起自己的时间）' });
            break;
          }
          if (detectLateSleepClaim(mt)) {
            lifeNote({ type: 'late_sleep_claimed' }, { log: '她说今晚睡晚（债基线略抬）' });
          }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6191'); }
      // [INTEREST] 她说到喜欢/被戳中的东西 → 记成事实（遇到喜欢的 → 感兴趣）
      try {
        let enc = loadInterestEncounters();
        let changedLike = false;
        for (const m of sent) {
          const hit = detectLikes(String(m?.text ?? m ?? ''));
          if (!hit) continue;
          enc = recordEncounter(enc, { kind: 'like', what: hit.snippet, src: String(key || '') }, Date.now());
          changedLike = true;
        }
        if (changedLike) { saveInterestEncounters(enc); log(`[interest] 记下她喜欢的片段（${key}）`); }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6203'); }
      // [LIFE] 她说话 = 有意思的事发生 → 无聊度归零锚点（别刚聊完就"无聊轮"找事做）
      try { const lifeStateNow = getLifeState(); markInterest(lifeStateNow); saveLifeFile(lifeStateNow); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6205'); }
      // [RUMINATE] 强事件留下余温：自我批评/被纠正/任务失败 → 记一条反刍（每天≤4 条，衰减后不再注入）
      try {
        for (const m of sent) {
          const hit = detectRumination(String(m?.text ?? m ?? ''));
          if (hit) {
            const rr = addRumination({ ...hit, key: String(key ?? ''), at: Date.now() });
            if (rr) log(`[ruminate] 记下惦记：${String(rr.core).slice(0, 26)}（${hit.source}）`);
            break; // 一轮只记一条最扎心的
          }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6216'); }
      // [INTAKE] 每轮学习：拿这段交换去提炼。节流与新颖度由 inori-intake 决定，
      // 所以这里可以放心地在"每次说完话"都调一次。
      try {
        if (sent.length) {
          const sst = getSocialV2State(key);
          const lastIn = [...(Array.isArray(sst.unread) ? sst.unread : [])].reverse().find((m) => m && !m.isSelf);
          const userText = String(lastIn?.text || lastIn?.plain || lastIn?.tail || '');
          const seenNow = (getTurnSeenHeads().get(key) ?? []).splice(0);
          maybeIntake(key, userText, sent.join('\n'), seenNow.join('\n'));
        }
      } catch (error) {
        log(`[intake] 触发失败（已忽略）: ${error?.message ?? error}`);
      }
      // [CHASE] 她刚说过话：挂一个 5~10 分钟的追问计时（对方没回就追一句）
      // ★ 必须在 failed 判断之外：以前放在 if (failed.length > 0) 里面，
      //   等于只有发送失败才挂追问，正常说话永远不追 → chase 日志 0 条、
      //   自适应(adapt)永远没样本、进化链断在起点。
      try {
        if (sent.length) {
          scheduleChaseV2(key, Date.now());
          // [ECHO] 她接过了复读 → 清 ready，避免同一波复读反复提示
          try {
            const estEcho = getSocialV2State(key);
            if (estEcho.echoState && estEcho.echoState.ready) {
              estEcho.echoState.ready = false;
              saveSocialV2State();
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:6244'); }
        }
      } catch (error) { log(`[chase] 挂计时失败（忽略）: ${error?.message ?? error}`); }
      if (failed.length > 0) {
        // [MUTE-SKIP] 全部是「禁言跳过」时不算发送失败：消息本来就不该投递，
        // 不把错误抛回给她（她看不到"发送失败"，也不会误以为说漏了）。
        const allMuted = failed.every((e) => String(e?.message ?? '').includes('禁言中，跳过投递'));
        if (allMuted) {
          log(`[mute] ${key} 禁言中，本轮 ${failed.length} 条未投递（不报错）`);
          return sent;
        }
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (getCurrentMode() === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  // [S2-4] 发送权限快照与静默闸门的契约在 send-guard.mjs（有单测）
  function captureSendGuard(key) {
    return createSendGuard({
      key,
      policy: sessionPolicy(key),
      sessionId: state.sessions[key],
      isAllowed: (k) => isSessionAllowedInCurrentMode(k),
      policyNow: (k) => sessionPolicy(k),
      sessionNow: (k) => state.sessions[k],
    });
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  // 拿不到角色状态时按当前模式判（不因为一个读状态失败把整条发送路径炸掉）。
  function shouldBlockSilentReply(key) {
    let mode;
    try {
      const roleState = typeof readRoleState === 'function' ? readRoleState() : null;
      mode = roleState?.mode;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-pipeline-service.mjs:shouldBlockSilentReply'); }
    if (!mode) mode = getCurrentMode();
    return shouldBlockSilentReplyPure(key, { mode, ownerQQ: cfg.ownerQQ });
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendNotice(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  return { mediaHintFor, findMessageMedia, clampGapV2, computeGapsV2, sendMessagesV2, shouldAuditKey, captureSendGuard, shouldBlockSilentReply, auditAndSend };
}
