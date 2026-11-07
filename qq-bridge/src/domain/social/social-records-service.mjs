// 原文/主张/自我媒体/发言记录：她收到和说出的内容落记忆层。
//
// 从 app.mjs 的 main() 搬出（P3-RW-37，2026-11-01）。recentClaimTexts 去重状态留在本模块；
// slangEntries 用 getter 取当前数组（会被 replace）。
/**
 * @param {object} ctx
 */
export function createSocialRecords(ctx) {
  const {
    cfg, MEM_DIR, path, log, appendRaw, extractClaims, canonScope, filesForScope,
    claimToMemoryRow, appendJsonl, getSocialV2State, saveSocialV2State,
    writeGroupMemoryDigestV2, addRumination, redactKnownTokensOnly, recordSlangUsage,
    getSlangEntries, appendUtterance,
  } = ctx;
  const recentClaimTexts = new Set();
  function recordRawAndClaims(key, msg) {
    try {
      const memDir = cfg.socialV2?.memoryInject?.dir || MEM_DIR;
      const rawDir = path.join(memDir, '..', 'raw');
      const body = msg.text || msg.plain || '';
      appendRaw(rawDir, {
        key, at: msg.time, sender: msg.sender, userId: msg.userId,
        text: body, seq: msg.seq, isSelf: false, quoteTargetIsSelf: msg.quoteTargetIsSelf,
      });
      for (const claim of extractClaims([{ text: body, time: msg.time, seq: msg.seq, sender: msg.sender, isSelf: false }])) {
        const scope = canonScope(key);
        const file = filesForScope(memDir, scope).file;
        const row = claimToMemoryRow(claim, { scope });
        if (recentClaimTexts.has(row.text)) continue;
        recentClaimTexts.add(row.text);
        if (recentClaimTexts.size > 200) {
          const first = recentClaimTexts.values().next().value;
          recentClaimTexts.delete(first);
        }
        appendJsonl(file, row, { source: 'bridge/claim' });
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10337'); }
  }

  // [SELF-MEDIA] 表情/图片发送也要留痕：她发过一张图，群里引用它时才有据可查。
  // 2026-10-30：群友引用「她：[图片]」，但记录里既没有 media 消息也没有 send_image 调用，
  // 她只能编。这里补一条「我：[表情]」进 recentMessages + 原文层（不写 utterance，避免污染记忆）。
  function recordSelfMediaMessage(key, label = '[表情]') {
    try {
      const st = getSocialV2State(key);
      const now = Date.now();
      st.recentMessages.push({
        sender: '我', text: label, plain: label,
        quoteTargetIsSelf: false, isOwner: false, ownerLabel: '我',
        isSelf: true, hasMedia: true, media: [{ kind: 'sticker' }], time: now,
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      try {
        appendRaw(path.join(cfg.socialV2?.memoryInject?.dir || MEM_DIR, '..', 'raw'), {
          key, at: now, sender: '我', text: label, isSelf: true,
        });
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10358'); }
      saveSocialV2State();
      return true;
    } catch { return false; }
  }

  function recordSentMessagesV2(key, messages) {
    // [GROUP-MEMO] 她在这轮说完之后，把这轮群聊要点落进群记忆库（节流 10 分钟）
    writeGroupMemoryDigestV2(key);
    const st = getSocialV2State(key);
    const now = Date.now();
    // [GROUP-FEEDBACK] 群级反馈：记下这次发言，等 5 分钟内有人接 → replied+1。
    // 只看别人对她的反应（结果反馈），不把她的发言当学习语料。
    if (String(key).startsWith('group:')) {
      try {
        let gf = st.groupFeedback || { sent: 0, replied: 0 };
        // [GROUP-FB-WINDOW] 24h 滚动窗：过窗清零重计（累计值不许稀释近期行为）
        if (Date.now() - Number(gf.windowStart || 0) > 24 * 3600000) {
          gf = { sent: 0, replied: 0, windowStart: now };
        }
        gf.sent = Number(gf.sent || 0) + (Array.isArray(messages) ? messages.length : 0);
        gf.pendingAt = now;
        gf.at = now;
        // [RUMINATE-COLD] 连着说、一直没人接 → 留一条「没人接」的余温（6 小时最多一条）
        try {
          if (Number(gf.replied || 0) === 0 && gf.sent >= 3 && now - Number(gf.lastIgnoredAt || 0) > 6 * 3600000) {
            addRumination({ core: '我说了几句，群里没人接', intensity: 0.5, source: 'ignored', key });
            gf.lastIgnoredAt = now;
            log(`[ruminate] ${key} 说了 ${gf.sent} 条没人接 → 留一条余温`);
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10388'); }
        st.groupFeedback = gf;
        saveSocialV2State();
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10391'); }
    }
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      // [LEARN-LOOP] 被动采用检测：她说出口的文本里命中已确认黑话就记一笔（只观察，不改行为）
      try { recordSlangUsage(getSlangEntries(), key, text, now + i * 1000); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10398'); }
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: false, // 同上：自己的发言不是主人
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    // [UTTERANCE] 她说过的话进记忆库：可检索、不参与学习。
    // 连「发它的时候前一条别人在说什么」一起存，有人引用她时才答得出「这句是回哪条」。
    try {
      const memDir = cfg.socialV2?.memoryInject?.dir || MEM_DIR;
      let ctx = [];
      try {
        const lastIn = [...st.recentMessages].reverse().find((mm) => mm && !mm.isSelf);
        if (lastIn) ctx = [{ seq: lastIn.seq, sender: lastIn.sender, text: lastIn.text }];
      } catch { ctx = []; }
      for (let i = 0; i < list.length; i += 1) {
        const said = redactKnownTokensOnly(String(list[i] ?? ''));
        if (!said) continue;
        appendUtterance({ dir: memDir, key, text: said, ctx, at: now + i * 1000 });
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10424'); }
    // [RAW] 她自己的发言也进原文层（isSelf=true），供「我说过什么/回的是哪」检索
    try {
      const rawDir = path.join(cfg.socialV2?.memoryInject?.dir || MEM_DIR, '..', 'raw');
      for (let i = 0; i < list.length; i += 1) {
        const said = redactKnownTokensOnly(String(list[i] ?? ''));
        if (!said) continue;
        appendRaw(rawDir, { key, at: now + i * 1000, sender: '我', text: said, isSelf: true });
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-records-service.mjs:10433'); }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，收尾前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  return { recordRawAndClaims, recordSelfMediaMessage, recordSentMessagesV2 };
}
