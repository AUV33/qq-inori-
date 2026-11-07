// 文本发送服务：自动转发、分条发送、发送前观察、禁言跳过。
//
// 从 app.mjs 的 main() 搬出（P3-RW-7，2026-10-31）。发送策略（拆条/间隔/记账）集中在这里，
// 底层 OneBot 传输走 onebot-transport.mjs；本模块不持有队列，队列由调用方注入。
/**
 * @param {object} ctx
 * @param {object} ctx.cfg
 * @param {(...args:any[])=>void} ctx.log
 * @param {Set<string>} ctx.knownAgentTokens
 * @param {(key:string)=>Function|null} ctx.captureSendGuard
 * @param {(s:string)=>string} ctx.stripSelfQuoting
 * @param {object} ctx.sendLedger
 * @param {(text:string,max:number)=>string[]} ctx.splitForQQ
 * @param {()=>object} ctx.getOutgoing
 * @param {(p:Promise<any>,ms:number,label:string)=>Promise<any>} ctx.withTimeout
 * @param {()=>object} ctx.getBot
 * @param {(text:string)=>string} ctx.escapeCqText
 * @param {(s:any)=>any} ctx.text
 * @param {(entry:object)=>void} ctx.appendUndelivered
 * @param {string} ctx.undeliveredFile
 * @param {(ms:number)=>Promise<void>} ctx.sleep
 * @param {(key:string)=>object} ctx.getSocialV2State
 * @param {(key:string)=>void} ctx.autoAckAfterSend
 * @param {(text:string,recent:string[])=>Promise<any>} ctx.relevanceCos
 * @param {()=>Function} ctx.getSetInputStatus
 * @param {(min:number,max:number)=>number} ctx.randInt
 */
export function createSendService({
  cfg,
  log,
  knownAgentTokens,
  captureSendGuard,
  stripSelfQuoting,
  sendLedger,
  splitForQQ,
  getOutgoing,
  withTimeout,
  getBot,
  escapeCqText,
  text,
  appendUndelivered,
  undeliveredFile,
  sleep,
  getSocialV2State,
  getAutoAckAfterSend,
  relevanceCos,
  getSetInputStatus,
  randInt,
  // [WIRING-FIX] 发送超时原来是 app.mjs 的顶层常量，搬出后成了未声明引用：每次发送都炸。
  SEND_TIMEOUT_MS = 15000,
}) {
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of knownAgentTokens) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。

  // [MUTE-SKIP] 被禁言的消息不再投递：发群消息前查一次禁言状态，禁言期间直接跳过，
  // 不再反复撞 result=120（那既刷日志、又白费她的回合）。解禁后自动恢复（缓存到期即重查）。
  const muteCache = new Map(); // groupId -> { until, checkedAt }
  const muteSkipLogged = new Map(); // key -> ts（10 分钟只记一次）
  const muteWakeSkipped = new Map(); // key -> ts（5 分钟只记一次）[MUTE-GATE]
  let selfIdCache = { id: 0, at: 0 };
  async function groupMutedUntil(groupId) {
    const gid = String(groupId);
    const now = Date.now();
    const hit = muteCache.get(gid);
    if (hit && hit.until > now) return hit.until;
    if (hit && now - hit.checkedAt < 60000) return 0;
    try {
      if (!selfIdCache.id || now - selfIdCache.at > 600000) {
        const login = await withTimeout(getBot().getLoginInfo(), 5000, 'getLoginInfo');
        selfIdCache = { id: Number(login?.user_id ?? 0), at: now };
      }
      if (!selfIdCache.id) return 0;
      const info = await withTimeout(getBot().getGroupMemberInfo(Number(gid), selfIdCache.id), 5000, 'getGroupMemberInfo');
      const until = Number(info?.shut_up_timestamp ?? 0) * 1000;
      muteCache.set(gid, { until, checkedAt: now });
      return until > now ? until : 0;
    } catch { return 0; }
  }
  function muteSkip(key) {
    const now = Date.now();
    if (now - (muteSkipLogged.get(key) || 0) < 600000) return;
    muteSkipLogged.set(key, now);
    const until = muteCache.get(String(key.split(':')[1]))?.until;
    log(`[mute] ${key} 被禁言到 ${until ? new Date(until).toLocaleString('zh-CN') : '未知'}：跳过投递（不再产生 result=120）`);
  }

  // [SEND-ADVISORY] 2026-10-28 用户拍板：这两条从「强制拦截」降级为「观察记录」。
  // 不再替她决定说不说——判断依据改成在唤醒 prompt 里给事实（【谁在对谁说】+【事实】这轮没人叫你），
  // 说不说由她自己定。这里只把「接不上」和「没被叫却想说」记进日志，供之后算误开口率。
  async function sendGuardCheckV2(key, text, st) {
    try {
      if (!String(key).startsWith('group:')) return { ok: true };
      if ([...String(text || '')].length < 6) return { ok: true };
      const root = String(st?.lastWakeReason || '').split(':')[0];
      const silentWake = root === 'probability' || root === 'recovery';
      const recent = (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
        .filter((m) => m && !m.isSelf && (m.text || m.plain))
        .slice(-6)
        .map((m) => String(m.text || m.plain));
      if (recent.length < 2) return { ok: true };
      const r = await relevanceCos(text, recent);
      if (r && (r.cos < 0.40 || silentWake)) {
        log(`[send-advisory] ${key} ${silentWake ? `这轮是 ${root} 唤醒（没人叫她）` : '话题可能接不上'}｜cos=${r.cos.toFixed(2)}（只记录，不拦）`);
      }
      return { ok: true };
    } catch { return { ok: true }; }
  }

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    // [QUOTE-FIX] 自动转发同样去掉自我括号（整条被「」包住/落单引号）。
    // [FORMAT-OWN] socialV2.send.quoteFix === false 时不做机械剥离：分条/引用/「」都交给她
    // 按提示词自己决定（见 wake-prompt 的【怎么发】块），不在发送侧替她改字。
    const rawMsg = redactKnownTokensOnly(msg);
    const safeMsg = cfg.socialV2?.send?.quoteFix === false ? rawMsg : stripSelfQuoting(rawMsg);
    if (!safeMsg) { log(`[quote-fix] ${key} 剥完为空，丢弃本次自动转发`); return Promise.resolve(); }
    // [SEND-LEDGER] 工具刚发过同一句（哪怕中间桥接重启过），自动转发就让路，别再说两遍。
    try {
      if (sendLedger.shouldSkip(key, safeMsg, 'auto')) {
        log(`[dedupe] ${key} 跳过自动转发：工具已发过同一句`);
        return Promise.resolve();
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.mjs:5093'); }
    const [kind, id] = key.split(':');
    // [SEND-CAP] 自动转发也必须遵守 socialV2.send.maxMessageChars；旧实现用 splitForQQ
    // 默认 4000，config 里写 500 只对工具发送生效，chat/reserved 仍可能发超长气泡。
    const maxChars = Math.max(1, Number(cfg.socialV2?.send?.maxMessageChars) || 500);
    const parts = splitForQQ(safeMsg, maxChars).filter((part) => {
      try { return !sendLedger.shouldSkip(key, part, 'auto'); } catch { return true; }
    });
    if (!parts.length) return Promise.resolve();
    getOutgoing().clearFailed(key);
    for (const part of parts) {
      getOutgoing().enqueue(async () => {
        try {
          assertSendAllowed();
          if (kind === 'group' && await groupMutedUntil(id)) { muteSkip(key); getOutgoing().markFailed(key); return; }
          if (kind === 'private') await withTimeout(getBot().sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(getBot().sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          // [SEND-LEDGER] 只有真的发出去了才记账；失败不能留下“已发”记录。
          try { sendLedger.note(key, part, 'auto'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.mjs:5111'); }
        } catch (error) {
          getOutgoing().markFailed(key);
          try { appendUndelivered({ file: undeliveredFile, key, text: part }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.mjs:5114'); }
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        }
        await sleep(cfg.sendDelayMs);
      });
    }
    // [METRICS] 「她开口了」计数：没被叫还要说 → sendsUndirected（供 report-group-precision 算误开口率）
    try {
      if (String(key).startsWith('group:')) {
        const stM = getSocialV2State(key);
        const m = stM.metrics = stM.metrics || { wakes: 0, wakesDirected: 0, sends: 0, sendsUndirected: 0, pickedUp: 0, missedDirected: 0 };
        m.sends += 1;
        if (!stM.pendingDirectedWake) m.sendsUndirected += 1;
        stM.sentAfterWake = true;
        stM.pendingDirectedWake = false;
        stM.awaitingPickup = true; // 等下一次唤醒看有没有人回她（被接住率的分子）
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.mjs:5131'); }
    return getOutgoing().whenIdle().then(() => { if (lastSendSucceeded(key)) getAutoAckAfterSend()(key); });
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  // [ERR-NO-GROUP] 报错/问题类提示不投递到群里：群里只该看到她真正想说的话，
  // 系统报错（agent 出错/消息未被接受/服务重启中/审批失败/超时）只记日志；私聊照发。
  function sendNotice(key, text) {
    const [kind] = String(key).split(':');
    if (kind === 'group') {
      log(`[notice-suppressed] ${key}: ${String(text).replace(/\s+/g, ' ').slice(0, 100)}`);
      return Promise.resolve();
    }
    return sendToQQ(key, text);
  }

  function lastSendSucceeded(key) {
    return getOutgoing().succeeded(key);
  }

  // 分条/整形规则已搬到 send-format.mjs（P3-RW-5）：singleLineForQQ / splitLongSegment / isCjkChar / splitByCjkSpaces / planSocialTimeline。

  // 分条发送：与 sendToQQ 共用同一发送队列，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      getOutgoing().enqueue(async () => {
        try {
          assertSendAllowed();
          if (kind === 'group' && await groupMutedUntil(id)) { muteSkip(key); getOutgoing().markFailed(key); return; }
          if (kind === 'private') await withTimeout(getBot().sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(getBot().sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        } catch (error) {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          try { appendUndelivered({ file: undeliveredFile, key, text: msg }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-service.mjs:5332'); }
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          getOutgoing().markFailed(key);
        }
      });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        getOutgoing().enqueue(() => sleep(delay));
      }
    }
    // [HUMANLIKE] 私聊整批前后切换「正在输入」；群聊没有这个接口，不动。
    if (kind === 'private') void getSetInputStatus()(Number(id), true);
    return getOutgoing().whenIdle().then(() => {
      if (kind === 'private') void getSetInputStatus()(Number(id), false);
      return sent;
    });
  }

  return {
    redactKnownTokensOnly,
    groupMutedUntil,
    muteSkip,
    sendGuardCheckV2,
    sendToQQ,
    sendNotice,
    lastSendSucceeded,
    sendBurstToQQ,
  };
}
