// wake-schedule.mjs · 从 app.mjs 的 main() 搬出的调度层（2026-10-28 M-1）
//
// 为什么单独成模块：
//   scheduleWakeV2 / armWakeRetryForPending / scheduleProactiveCheckV2 是"什么时候叫她、等多久、什么时候重试"的决策层。
//   以前它们和发送/状态/调度器混在 main() 的闭包里，改一个间隔只能靠线上日志验证；
//   搬出来之后，入参（依赖）和出参（计划/定时器）都是显式的。
//
// 依赖注入 + 懒构造：
//   调用方（app.mjs）在**第一次调用**时才构造本模块的实例并传入依赖快照，避免 main() 里
//   那些后声明的 const（TDZ）在构造期被提前求值。依赖对象被闭包持有；cfg/socialV2 这类
//   可变对象是原地修改，所以不会陈旧。
//
// [FLOOR] 例外：turn-taking.js 是纯函数叶子模块（零 IO、零状态、无项目内依赖），
//   直接 import 不会引入循环，也不需要走注入清单（2026-10-28 轮次判断接入）。
import { decideFloor, shouldWake, applyAdaptiveGuard, othersRepliedSoon } from './turn-taking.js';
import { stashWakeReason } from './wake-stash.mjs';
//
// 纪律：
//   · 本模块不 import 项目内任何东西（只可能用到全局定时器/日志函数，且也是注入的）。
//   · 新增依赖必须同时更新 app.mjs 的 deps 清单，否则这里会 ReferenceError。
export function createWakeScheduler(deps) {
  const {
    armAtSplit,
    cancelReplyCheckV2,
    cfg,
    computeProactivity,
    currentMode,
    getCurrentMode,
    getFreedomPolicy,
    ensureWakeableV2,
    getSocialV2State,
    getTuning,
    isConversationBusyV2,
    isSessionAllowedInCurrentMode,
    judgeWakeIntent,
    getLifeState,
    loadMoodState,
    log,
    logAction,
    paceBatchMs,
    recordFloor,
    sedimentGroupMemoryIfStale,
    sendWakePromptV2,
    socialV2,
    stampReplyPace,
    wakePriorityV2,
    wakeRetryCounts,
    wakeRetryTimers,
  } = deps;

  // [MODE-CONTEXT] 不冻结构造时的 currentMode；见 message-intake 同名说明。
  const modeNow = () => (typeof getCurrentMode === 'function' ? getCurrentMode() : currentMode);

function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // [MOTIVE] 没有由头的唤醒（概率/恢复）交回她自己的状态：睡着、很累就别叫。
    // 有人直接叫她（@/引用/点名）不经过这里，不受影响。
    try {
      const root = String(reason || '').split(':')[0];
      if ((root === 'probability' || root === 'recovery') && String(key).startsWith('group:')) {
        const mst = loadMoodState(cfg.socialV2?.mood?.file);
        const lifeNow = typeof getLifeState === 'function' ? getLifeState() : null;
        const energy = Number(mst?.energy);
        const debt = Number(lifeNow?.debt);
        const sleeping = String(lifeNow?.state || '') === 'sleep';
        if (sleeping || (Number.isFinite(energy) && energy < 0.15) || (Number.isFinite(debt) && debt > 0.8)) {
          log(`[motive] ${key} 跳过 ${root} 唤醒：状态=睡/累（energy=${Number.isFinite(energy) ? energy.toFixed(2) : '?'} debt=${Number.isFinite(debt) ? debt.toFixed(2) : '?'}）`);
          return;
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:75'); }
    // [PACE] 先算这一唤醒的节奏（合批窗口 + 开口前停顿都跟着它）
    const pace = stampReplyPace(key, reason, st);
    // [FLOOR] 运行时轮次判断（替代人设卡里的节奏死规矩）：
    //   这句冲谁说 / 她刚说过多少 / 对方在不在连发 / 现在轮不轮到她。
    //   判断为「不该接」时这轮不唤醒——消息留在未读里，下一次机会还会带上；被点名永远放行。
    // [JUDGE-WAKE] 判定改为异步：弱指向消息先问本地 3B（target=你→唤醒、别人/无/自己→静默），
    // 命中才叫醒；本地 3B 不可用或置信不足时回退下方原有地板+概率。scheduleWakeV2 对外仍同步。
    void (async () => {
    try {
      const nowFloor = Date.now();
      const recentMsgs = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      let lastIn = null;
      for (let i = recentMsgs.length - 1; i >= 0; i -= 1) { if (recentMsgs[i] && !recentMsgs[i].isSelf) { lastIn = recentMsgs[i]; break; } }
      const lastSender = String(lastIn?.sender || '');
      const burst = lastIn
        ? recentMsgs.filter((m) => m && !m.isSelf && String(m.sender || '') === lastSender && nowFloor - Number(m.time || 0) < 30000).length
        : 0;
      const sendTimes = (Array.isArray(st.sendTimes) ? st.sendTimes : []).map(Number).filter(Number.isFinite);
      const herRecentSends = sendTimes.filter((t) => nowFloor - t < 180000).length;
      const sinceHerSendMs = sendTimes.length ? nowFloor - Math.max(...sendTimes) : Infinity;
      const groupRatePerMin = recentMsgs.filter((m) => m && !m.isSelf && nowFloor - Number(m.time || 0) < 600000).length / 10;
      // [FLOOR-STRUCT] 结构信号（MPH 2024：addressee 靠结构、不靠文本）：
      //   ① 最新这条是否直接回她（quoteTargetIsSelf）；② 她上次说完后有没有别人接；
      //   ③ 用「她说完 → 下一条别人消息」的实际间隔分位，替代 45s/120s 拍脑袋常数；
      //   ④ 最近开口被接住（<=2min）的比例，给自适应阈值用。
      //   都只基于手里已有的 recentMessages/sendTimes，不额外读文件。
      const incomingTimes = recentMsgs
        .filter((m) => m && !m.isSelf && Number.isFinite(Number(m.time)))
        .map((m) => Number(m.time))
        .sort((a, b) => a - b);
      const sortedSends = [...sendTimes].sort((a, b) => a - b);
      const repliesAfter = [];
      for (const t of sortedSends) {
        const next = incomingTimes.find((x) => x > t);
        if (next != null) repliesAfter.push(next - t);
      }
      const pct = (arr, p) => {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
      };
      const lastSendAt = sortedSends.length ? sortedSends[sortedSends.length - 1] : null;
      // [SELF-TUNE] 她自己调的参数（self-tune 白名单写入 data/state/tuning.json）：
      //   floor.minReply 覆盖自适应/默认；floor.holdScale 缩放开口停顿；floor.adaptive 关掉自动微调。
      let tuning = {};
      try { tuning = getTuning?.() || {}; } catch { tuning = {}; }
      // [FLOOR-ADAPT] 自适应阈值用**长期 metrics**（social-v2 的 pickedUp/sends），
      //   不再用缓冲窗口的短估计；config.floor.adaptive=false 一键退回固定阈值；
      //   命中率与上次相比 >20pp 只记录不采纳（防一次异常流量把阈值甩飞）。
      const ltMetrics = st.metrics || {};
      const ltSends = Number(ltMetrics.sends) || 0;
      const ltPicked = Number(ltMetrics.pickedUp) || 0;
      const adapt = applyAdaptiveGuard({
        prevRate: st.floorAdaptive?.rate,
        prevSamples: st.floorAdaptive?.n,
        newRate: ltSends > 0 ? ltPicked / ltSends : null,
        samples: ltSends,
        enabled: tuning['floor.adaptive'] !== false && cfg?.floor?.adaptive !== false,
      });
      if (adapt.blocked && adapt.reason === 'jump') {
        log(`[floor] ${key} 命中率突变 ${(adapt.from * 100).toFixed(0)}% → ${(adapt.to * 100).toFixed(0)}%，本轮先按旧值`);
      }
      if (adapt.rate != null) st.floorAdaptive = { rate: adapt.rate, n: adapt.n, at: nowFloor };
      const floor = decideFloor({
        kind: String(key).startsWith('private:') ? 'private' : 'group',
        reason,
        sameSenderBurst: burst,
        herRecentSends,
        sinceHerSendMs,
        othersReplied: othersRepliedSoon(incomingTimes, lastSendAt),
        replyToHer: lastIn?.quoteTargetIsSelf === true,
        gapP50Ms: pct(repliesAfter, 0.5) ?? undefined,
        gapP75Ms: pct(repliesAfter, 0.75) ?? undefined,
        hitRate: adapt.rate ?? undefined,
        hitSamples: adapt.n,
        minReplyOverride: tuning['floor.minReply'],
        holdScale: tuning['floor.holdScale'],
        groupRatePerMin,
        hour: new Date().getHours(),
        // [MOOD-WIRE] 情绪真源：stampReplyPace 从 inori_state 算出的 moodReply（以前 st.mood 从未被写，floor 拿不到情绪）。
        moodReply: Number(st.lastPace?.moodReply) || undefined,
        asleep: String((typeof getLifeState === 'function' ? getLifeState()?.state : '') || '') === 'sleep',
      });
      // [MOOD-WIRE] 情绪参与「接不接」：decide().replyProb（0.95 基线）折算 0.4~1.1 系数。
      //   被点名不降（她叫到就得应）；系数作用在 floor 之后，审计日志里能看到。
      const moodProb = Number(st.lastPace?.moodReply);
      if (Number.isFinite(moodProb) && !floor.directed) {
        const f = Math.max(0.4, Math.min(1.1, moodProb / 0.95));
        if (Math.abs(f - 1) > 0.03) {
          floor.reply = Math.max(0, Math.min(0.95, floor.reply * f));
          floor.why = `${floor.why}，情绪×${f.toFixed(2)}`;
        }
      }
      st.lastFloor = { ...floor, at: nowFloor, reason };
      let verdict = shouldWake(floor);
      // [JUDGE-WAKE] 弱指向消息用本地 3B 的意图信号决定（替代 Math.random 掷骰）：
      // 仅对规则判不出的弱指向原因咨询；强指向（@/名字/aboutSelf/提问…）已由 decideFloor 确定性唤醒，跳过。
      // target=你 且置信够高 → 确定性唤醒；target=别人/无/自己 且够高 → 静默；否则回退原概率。
      const rootR = String(reason || '').split(':')[0];
      const STRONG_REASONS = new Set(['atMention', 'nameMention', 'poke', 'question', 'keyword', 'aboutSelf', 'topicMention', 'atSplit']);
      const JUDGE_REASONS = new Set(['anyMessage', 'continueChat', 'joinTopic', 'speaker', 'replyCheck']);
      if (!STRONG_REASONS.has(rootR) && JUDGE_REASONS.has(rootR) && typeof judgeWakeIntent === 'function') {
        const jtext = String(lastIn?.plain ?? lastIn?.text ?? '');
        try {
          const j = await judgeWakeIntent(jtext);
          const jconf = Number(cfg?.floor?.judgeWakeConf ?? 0.5);
          if (j && Number(j.confidence) >= jconf) {
            verdict = j.aboutHer
              ? { wake: true, why: `local-3b 关于她(${j.target})` }
              : { wake: false, why: `local-3b 无关(${j.target})` };
          }
        } catch (e) { /* 判读异常 → 保留原 shouldWake 结果 */ globalThis.__ignoredCatch?.(e, 'wake-schedule.mjs:judge'); }
      }
      // [FLOOR-LOG] 每次判定落一行（含不开口），供 24h 后按 reason/时段/群算开口率与被接住率。
      try {
        recordFloor?.({
          at: new Date(nowFloor).toISOString(),
          key,
          reason,
          group: !String(key).startsWith('private:'),
          reply: Number(floor.reply.toFixed(3)),
          minReply: floor.minReply,
          holdMs: floor.holdMs,
          directed: floor.directed,
          wake: verdict.wake,
          why: verdict.why,
          floorWhy: floor.why,
          hitRate: adapt.rate,
          hitSamples: adapt.n,
          adaptBlocked: adapt.blocked ? adapt.reason : null,
          bufferSends: sortedSends.length,
          gapP50: pct(repliesAfter, 0.5),
          gapP75: pct(repliesAfter, 0.75),
          burst,
          herSends: herRecentSends,
          sinceSendMs: Number.isFinite(sinceHerSendMs) ? Math.round(sinceHerSendMs) : null,
          hour: new Date(nowFloor).getHours(),
          // [SEQ] 供后续度量区分“新消息”与“已看过的消息”：floor 短时重复刷新时 seq 不变。
          seq: Number(st.lastUnreadSeq) || 0,
          promptSeq: Number(st.lastPromptSeq) || 0,
        });
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:193'); }
      if (!verdict.wake) {
        log(`[floor] ${key} 本轮不开口（${verdict.why}｜${floor.why}）`);
        return;
      }
      log(`[floor] ${key} 开口（reply=${floor.reply.toFixed(2)} hold=${floor.holdMs}ms｜${floor.why}）`);
      // 非点名时把 floor 的停顿并进节奏（被点名不拖）
      if (!floor.directed && st.lastPace) {
        st.lastPace = { ...st.lastPace, holdMs: Math.max(Number(st.lastPace.holdMs) || 0, floor.holdMs) };
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:203'); }
    // [AT-SPLIT] 多条 @ 拆条：首条正常唤醒，其余进队列由回合结束逐个派
    try { armAtSplit(key, st, reason); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:205'); }
    // ★ 合批定时器改成"可重置"（debounce）：用户常常把一句话分几段发，
    //   旧实现是一次性 setTimeout，第一段就唤醒、后两段要等下一次唤醒——正是踩过的 bug。
    //   现在每来一条新消息就重新计时，但总等待不超过 maxDebounceMs，避免被无限拖延。
    const armPendingWake = (ms) => {
      st.pendingWakeTimer = setTimeout(() => {
        st.pendingWakeTimer = null;
        st.pendingWakeFirstAt = 0;
        const finalReason = st.pendingWakeReason || reason;
        st.pendingWakeReason = null;
        void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
      }, ms);
      st.pendingWakeTimer.unref?.();
    };
    const nowMs = Date.now();
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      // [DEBOUNCE] 窗口内又来消息 → 重新计时（把这一串话合到同一次唤醒里）
      const firstAt = Number(st.pendingWakeFirstAt || nowMs);
      const batchNow = paceBatchMs(Number(st.wakeConfig?.batchWindowMs) || 3000, pace, key);
      const maxWait = Math.max(4000, Number(st.wakeConfig?.maxDebounceMs) || 20000);
      if (nowMs - firstAt + batchNow <= maxWait) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeFirstAt = firstAt;
        armPendingWake(batchNow);
        log(`[reserved2] 窗口内又来消息，重新计时 ${key}（${Math.round(batchNow / 1000)}s，已等 ${Math.round((nowMs - firstAt) / 1000)}s / 上限 ${Math.round(maxWait / 1000)}s）`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      const { seq } = stashWakeReason(st, reason);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      logAction({ t: 'busy_stash', key, trigger: reason }); // [ACTION-LOG] 纯观察
      // [WAKE-RETRY] 高优先级唤醒（@/提问/关键词）再挂一层兜底：turn/end 补发在 watchdog 路径上会漏
      // [JOIN] 软性自发唤醒（插话/接着聊）不挂兜底：它们不是"错过就丢"的关键唤醒
      // （下一条群消息会重新判定），却在繁忙群里把 20s 兜底循环打成噪音。
      const softReason = ['joinTopic', 'continueChat'].includes(String(reason).split(':')[0]);
      if (!softReason && wakePriorityV2(reason) >= wakePriorityV2('nameMention')) armWakeRetryForPending(key, reason, seq, Date.now());
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = paceBatchMs(Number(st.wakeConfig?.batchWindowMs) || 3000, pace, key);
    st.pendingWakeFirstAt = nowMs;
    armPendingWake(batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  })();
  }

function armWakeRetryForPending(key, reason, seq, atMs = Date.now()) {
    try {
      // [RETRY-MULTISLOT] 兜底槽按 (key, seq) 建，而不是按会话建。旧实现一条会话只挂
      // 一个 timer：繁忙群里她跑长回合时，第二条 @ 根本挂不上自己的兜底，只能寄望
      // pendingWakeReasons 的残值；12 次（≈40 分钟）后还会整会话放弃。
      const retryId = `${key}\u0000${seq}`;
      if (wakeRetryTimers.has(retryId)) return;
      const n = (wakeRetryCounts.get(retryId) || 0) + 1;
      if (n > 12) {
        wakeRetryCounts.delete(retryId);
        log(`[wake-retry] ${key} 这条兜底重试 ${n - 1} 次仍未派发（本地 busy 可能卡死），放弃本次兜底（${reason}@seq${seq}）`);
        return;
      }
      wakeRetryCounts.set(retryId, n);
      // [BACKOFF] 指数退避：base → 2x → 4x …，封顶 5 分钟，重试不再死磕同一间隔
      const base = Math.max(10000, Number(cfg.socialV2?.wake?.pendingRetryMs) || 20 * 1000);
      const delay = Math.min(5 * 60 * 1000, base * Math.pow(2, Math.min(5, n - 1)));
      const timer = setTimeout(() => {
        wakeRetryTimers.delete(retryId);
        try {
          const cur = getSocialV2State(key);
          // 精确判断：这条 @/提问 有没有出现在"她看过的那次提示词"里。
          // （旧判断是"她之后开口过就跳过"，但她可能回了别的话、压根没看到后到的 @。）
          const shown = Number(seq) <= Number(cur.lastPromptSeq || 0);
          if (shown) {
            log(`[wake-retry] ${key} 兜底检查：该条已在上次提示词里出现，跳过补发（${reason}@seq${seq} ≤ 提示词 seq${cur.lastPromptSeq || 0}）`);
            return;
          }
          const alive = Array.isArray(cur.unread) && cur.unread.some((m) => m && Number(m.seq) >= Number(seq));
          if (!alive) { wakeRetryCounts.delete(retryId); return; }                               // 已经处理过
          if (isConversationBusyV2(key, cur)) {                 // 还忙，再等一轮
            armWakeRetryForPending(key, reason, seq, atMs);
            return;
          }
          const items = Array.isArray(cur.pendingWakeReasons) ? cur.pendingWakeReasons.splice(0) : [];
          const best = [reason, ...items.map((i) => i?.reason)].filter(Boolean)
            .reduce((a, b) => (wakePriorityV2(b) > wakePriorityV2(a) ? b : a), reason);
          wakeRetryCounts.delete(retryId);
          // [QUEUE-LAT] 从最早一条暂存到真正派发等了多久（优化前后对比用）
          try {
            const times = items.map((x) => Number(x.at)).filter(Number.isFinite);
            if (Number.isFinite(Number(atMs))) times.push(Number(atMs));
            const waited = Math.max(0, Math.round((Date.now() - Math.min(...times)) / 1000));
            log(`[queue-lat] ${key} 暂存 ${items.length} 条 → 派发，等了 ${waited} 秒`);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:308'); }
          log(`[wake-retry] ${key} 暂存唤醒兜底派发（${best}，清掉暂存 ${items.length} 条）`);
          scheduleWakeV2(key, best);
        } catch (error) { log(`[wake-retry] 兜底派发失败（已忽略）: ${error?.message ?? error}`); }
      }, delay);
      timer.unref?.();
      wakeRetryTimers.set(retryId, timer);
      log(`[wake-retry] ${key} 已挂兜底（${reason}@seq${seq}，${Math.round(delay / 1000)} 秒后检查）`);
    } catch (error) { log(`[wake-retry] 挂兜底失败（已忽略）: ${error?.message ?? error}`); }
  }

function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || modeNow() !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    // [FREEDOM-ENFORCE] 主动预算耗尽时不再排新的主动检查；消息唤醒不受影响。
    try {
      const fp = typeof getFreedomPolicy === 'function'
        ? getFreedomPolicy(key)
        : null;
      if (fp && fp.initiate && fp.initiate.can === false) {
        log(`[freedom] ${key} 跳过主动检查：${fp.initiate.reason || 'budget-exhausted'}`);
        return;
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:334'); }
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      // [SILENT-DEPOSIT] 顺手把「她还没说、但群里聊过」的话题沉淀进群记忆（不依赖是否叫醒她）
      try { sedimentGroupMemoryIfStale(key); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:343'); }
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      // [THREAD] 反应弧：挂起 3h+ 的"待追问" → 再提概率（那个"该惦记了"的冲动），每话题只推一次
      try {
        const staleQ = (Array.isArray(st.activeTopics) ? st.activeTopics : []).some((t) => t?.pendingQuestion && t.pendingSince && !t.pendingReminded && Date.now() - Number(t.pendingSince) > 3 * 3600000);
        if (staleQ) prob = Math.min(1, prob * 1.6);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:354'); }
      // [PROACTIVITY] 水群适应度：群里别人越活跃、她最近说得越多、被接率越高、情绪越有劲 → 主动开口概率越高
      try {
        if (String(key).startsWith('group:')) {
          const pro = computeProactivity(st);
          st.proactivity = pro;
          prob = Math.min(1, prob * (0.6 + pro * 2.2)); // 冷清群 ×0.7 左右，热闹且她活跃 ×1.2+
          log(`[proactivity] ${key} 主动检查：适应度 ${pro}，概率 ${prob.toFixed(3)}，已安静 ${Math.round(idle / 60000)}min / 门槛 ${Math.round(idleThreshold / 60000)}min`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:363'); }
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      // [PROACTIVE-OBS] 记下这次为什么开口/没开口（此前只记"检查了"，看不出门槛拦了多少）
      // [PROACTIVE-ACTIVE] 活跃群里也给她一次主动机会（2026-10-26 用户拍板 A3）：
      // 旧逻辑死等「群安静 idleThreshold」——活跃群整晚在聊，主动入口结构性永不触发。
      // 新逻辑：群刚有动静时，看「她自己安静了多久 + 水群适应度」，够了就递一次机会（接不接她定）。
      const isGroupKey = String(key).startsWith('group:');
      const herQuietMs = Date.now() - (Number(st.lastAiReplyAt) || 0);
      const activeQuietMinMs = Math.max(5 * 60 * 1000, Number(p.activeQuietMinMs) || 20 * 60 * 1000);
      const activeMinFitness = Number(p.activeMinFitness) || 0.15;
      const activeOk = isGroupKey && idle < idleThreshold && herQuietMs >= activeQuietMinMs
        && (Number(st.proactivity) || 0) >= activeMinFitness;
      const quietOk = idle >= idleThreshold;
      if (!quietOk && !activeOk) {
        log(`[proactivity] ${key} 主动检查跳过：群里刚有过动静（安静 ${Math.round(idle / 60000)}min < 门槛 ${Math.round(idleThreshold / 60000)}min）${isGroupKey ? `；她自己安静 ${Math.round(herQuietMs / 60000)}min（活跃群门槛 ${Math.round(activeQuietMinMs / 60000)}min，适应度 ${st.proactivity ?? '?'}）` : ''}`);
        logAction({ t: 'proactive_check', key, decided: 'skip-idle', idleMin: Math.round(idle / 60000) });
      } else if (isConversationBusyV2(key, st)) {
        log(`[proactivity] ${key} 主动检查跳过：会话正忙`);
        logAction({ t: 'proactive_check', key, decided: 'skip-busy', idleMin: Math.round(idle / 60000) });
      }
      if ((quietOk || activeOk) && Math.random() < prob && !isConversationBusyV2(key, st)) {
        if (activeOk) {
          st.proactiveActiveAt = Date.now();
          log(`[proactivity] ${key} 活跃群主动机会（群热闹但你自己安静了 ${Math.round(herQuietMs / 60000)}min，适应度 ${st.proactivity}）`);
          logAction({ t: 'proactive_check', key, decided: 'active-group', idleMin: Math.round(idle / 60000), herQuietMin: Math.round(herQuietMs / 60000) });
        }
        // [THREAD] 把她叫醒接待追问的同时标记"已提醒过"（同一话题不再反复加码）
        try { for (const t of Array.isArray(st.activeTopics) ? st.activeTopics : []) { if (t?.pendingQuestion && t.pendingSince && !t.pendingReminded && Date.now() - Number(t.pendingSince) > 3 * 3600000) t.pendingReminded = true; } } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-schedule.mjs:395'); }
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
        logAction({ t: 'proactive_check', key, prob: Number(prob.toFixed(3)), idleMin: Math.round(idle / 60000), thoughts: pendingThoughts }); // [ACTION-LOG] 系统定时器推了她一把（她是否开口看回合日志）
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  return {
    scheduleWakeV2,
    armWakeRetryForPending,
    scheduleProactiveCheckV2,
  };
}
