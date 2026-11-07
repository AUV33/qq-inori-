// 社交节奏：回复节奏、睡眠定时、好奇心种子、插话/续聊、prompt 队列清理。
//
// 从 app.mjs 的 main() 搬出（P3-RW-34，2026-11-01）。只改传入的 st/socialV2 与队列，
// 发送/唤醒经 sendWakePromptV2/scheduleWakeWithSecretary 注入。
// [ATOMIC-RETRY] 2026-11-03：curiosity.json 的 tmp→正式 rename 走带 EPERM/EBUSY 重试的实现。
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';
import { loadEmotionVector, emotionBias as emotionBiasFor } from '../leaves/inori-emotion-vector.js';
import { gateProactive } from '../mind/intention-gate.mjs';
/**
 * @param {object} ctx
 */
export function createSocialTiming(ctx) {
  const {
    cfg, log, logAction, fs, path, stateDataPath, sleep, reverse, socialV2, promptQueues,
    getSocialV2State, saveSocialV2State, appraiseValence, classifyTopic, computePace,
    decideMood, decideContinue, decideJoin, getLifeState, loadGoals, loadMoodState,
    // [C6] 内在状态（SelfState）影响插话概率；缺省不影响
    getSelfState = null,
    stateWithKey, tickMood, isDirectedAtAi, loadSlang, findUnknownTerms, loadLessons,
    loadInterestEncounters, saveInterestEncounters, recordCuriosity, recordEncounter,
    markCuriosityStimulus, computeProactivity, sendWakePromptV2, scheduleWakeWithSecretary,
    isConversationBusyV2, isSessionAllowedInCurrentMode, cancelReplyCheckV2,
    assumeMoreComing, pendingWakeKeys, wakeConfigUpdatedKeys, markReadCalledKeys,
    wakeConfigMissCount, messageMediaStore, stateHub = null,
    // [WIRING-FIX] 这几个原来是 app.mjs main() 的局部量，搬出后成了未声明引用（好奇种子/插话路径一跑就炸）
    SLANG_FILE, STATE_DIR, getSelfNickname, getCurrentMode,
    // [WIRING-FIX] 好奇刺激后要落盘生活状态；裸引用被 try/catch 吞成静默失败
    saveLifeFile,
  } = ctx;
  function replyPaceContext(key, reason) {
    try {
      const stP = getSocialV2State(key);
      const kind = String(key).startsWith('private:') ? 'private' : 'group';
      let rate = 0;
      if (kind === 'group') {
        const recent = Array.isArray(stP.recentMessages) ? stP.recentMessages : [];
        const cutoff = Date.now() - 10 * 60 * 1000;
        rate = recent.filter((m) => m && !m.isSelf && Number(m.time) >= cutoff).length / 10;
      }
      const sendTimes = Array.isArray(stP.sendTimes) ? stP.sendTimes.map(Number).filter(Number.isFinite) : [];
      const nowPace = Date.now();
      const recentSendCount = sendTimes.filter((t) => nowPace - t < 180000).length;
      const lastSendAgoMs = sendTimes.length ? nowPace - Math.max(...sendTimes) : Infinity;
      // [MOOD-WIRE] 情绪唯一真源是 inori_state.json（warmth/energy）。以前这里读 stP.mood.energy，
      // 而 st.mood 全仓库没有写入点 → 恒为 0.5；proactivity 的 temperature 同理恒 0.4。
      // 现在在节奏上下文里现算一次情绪，并把 decide() 的 replyProb/tone 一并带出去给 floor 用。
      let moodEnergy = 0.5;
      let moodWarmth = 0.5;
      let moodReply = null;
      let moodTone = '';
      try {
        const mstT = loadMoodState(cfg.socialV2?.mood?.file);
        tickMood(mstT, Date.now());
        // [MOOD-PERKEY] 判定用的是「对这个会话的温度」，不是全局一个值
        const mstTK = stateWithKey(mstT, key);
        if (Number.isFinite(Number(mstTK?.energy))) moodEnergy = Number(mstTK.energy);
        if (Number.isFinite(Number(mstTK?.warmth))) moodWarmth = Number(mstTK.warmth);
        const pool = (Array.isArray(stP.unread) && stP.unread.length) ? stP.unread : (Array.isArray(stP.recentMessages) ? stP.recentMessages : []);
        const probe = [...pool].reverse().find((m) => m && !m.isSelf);
        const q = String(probe?.plain || probe?.text || '');
        const d = decideMood(mstTK, classifyTopic(q), appraiseValence(q));
        moodReply = Number.isFinite(Number(d?.replyProb)) ? Number(d.replyProb) : null;
        moodTone = String(d?.tone || '');
        // [STATE-HUB] 优先统一状态层的宽带宽语气（±0.12）；缺失时回退旧 ±0.08 偏置。
        try {
          const tone = stateHub && typeof stateHub.replyTone === 'function' ? stateHub.replyTone(key) : null;
          const bias = tone
            ? { delta: Math.max(-0.12, Math.min(0.12, (tone.warmth - 0.5) * 0.24)) }
            : emotionBiasFor(loadEmotionVector(), key);
          if (moodReply != null && Math.abs(bias.delta) >= 0.005) {
            moodReply = Math.max(0.05, Math.min(0.95, moodReply + bias.delta));
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:emotion-bias'); }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11640'); }
      return {
        kind, reason,
        asleep: String(getLifeState()?.state || '') === 'sleep',
        energy: moodEnergy,
        warmth: moodWarmth,
        moodReply,
        moodTone,
        emotionBias: (() => { try { return emotionBiasFor(loadEmotionVector(), key); } catch { return null; } })(),
        replyTone: (() => { try { return stateHub && typeof stateHub.replyTone === 'function' ? stateHub.replyTone(key) : null; } catch { return null; } })(),
        groupRatePerMin: rate,
        hour: new Date().getHours(),
        recentSendCount,
        lastSendAgoMs,
      };
    } catch { return { kind: 'group', reason, hour: new Date().getHours() }; }
  }
  /** 算一次节奏并记到 st.lastPace（发唤醒时直接用，避免两处算法漂移） */
  function stampReplyPace(key, reason, stP) {
    try {
      const ctx = replyPaceContext(key, reason);
      const pace = computePace(ctx);
      // mood 字段单独挂在 lastPace 上：computePace 只认节奏字段，会丢掉它们。
      stP.lastPace = { ...pace, moodReply: ctx.moodReply ?? null, moodTone: ctx.moodTone ?? '', at: Date.now(), reason };
      return stP.lastPace;
    } catch { return null; }
  }
  // ── [WAIT-NEXT] 要不要等对方下一句再回 ────────────────────────────────
  // 句子像没说完 / 对方在连发 → 等一句；问句、严肃话题、群里 → 立刻回。
  // 等待期间每 300ms 看一眼有没有新消息，来了就提前开口；等满就照常回。
  function lastIncomingV2(stP) {
    const list = (Array.isArray(stP.unread) && stP.unread.length) ? stP.unread : (Array.isArray(stP.recentMessages) ? stP.recentMessages : []);
    for (let i = list.length - 1; i >= 0; i--) if (list[i] && !list[i].isSelf) return list[i];
    return null;
  }
  function waitNextDecision(key, stP) {
    try {
      const last = lastIncomingV2(stP);
      const kind = String(key).startsWith('private:') ? 'private' : 'group';
      const list = (Array.isArray(stP.unread) && stP.unread.length) ? stP.unread : (Array.isArray(stP.recentMessages) ? stP.recentMessages : []);
      const sender = String(last?.sender || '');
      const cutoff = Date.now() - 15000;
      const sameSender = list.filter((m) => m && !m.isSelf && String(m.sender || '') === sender && Number(m.time || 0) >= cutoff).length;
      const text = String(last?.plain || last?.text || '');
      return assumeMoreComing({ kind, text, topic: stP.mood?.topic, senderRecent15s: sameSender, directed: isDirectedAtAi(text) });
    } catch { return { wait: false, waitMs: 0, why: '判定失败' }; }
  }
  /** 开口前的整体节奏：场景停顿 + 要不要等下一句 */
  async function applyReplyPace(key, reason) {
    const stP = getSocialV2State(key);
    const fresh = stP.lastPace && Date.now() - Number(stP.lastPace.at || 0) < 5 * 60 * 1000;
    const pace = fresh ? stP.lastPace : stampReplyPace(key, reason, stP);
    const hold = Math.max(0, Math.min(9000, Number(pace?.holdMs) || 0));
    if (hold > 0) {
      log(`[pace] ${key} 开口前停顿 ${hold}ms（${pace.scene}，${pace.why}）`);
      await sleep(hold);
    }
    const d = waitNextDecision(key, stP);
    if (!d.wait || d.waitMs <= 0) { log(`[wait-next] ${key} 不等下一句（${d.why}）`); return; }
    const baseSeq = Number(stP.lastUnreadSeq) || 0;
    const deadline = Date.now() + d.waitMs;
    log(`[wait-next] ${key} 等下一句最多 ${d.waitMs}ms（${d.why}）`);
    while (Date.now() < deadline) {
      await sleep(300);
      const cur = getSocialV2State(key);
      if ((Number(cur.lastUnreadSeq) || 0) > baseSeq) {
        log(`[wait-next] ${key} 等到下一句（seq ${baseSeq}→${cur.lastUnreadSeq}），提前开口`);
        await sleep(500); // 让对方把这句话打完
        return;
      }
    }
    log(`[wait-next] ${key} 等满 ${d.waitMs}ms 没有下一句，先回`);
  }
  function paceBatchMs(baseMs, pace, label) {
    const base = Math.max(800, Number(baseMs) || 3000);
    const factor = Number(pace?.factor) || 1;
    const ms = Math.max(800, Math.min(20000, Math.round(base * factor)));
    log(`[pace] ${label} 合批 ${Math.round(base)}ms → ${ms}ms（场景=${pace?.scene ?? '?'} 因子=${factor}）`);
    return ms;
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }


  // [JOIN] 两条"她自己开口"的时机（2026-10-25 用户拍板）：
  //   ① 活跃群里插话：群正热闹、她安静够久、适应度够 → 给一次 joinTopic 唤醒（她决定接不接）；
  //   ② 会话延续：她刚说过话、别人接着说 → continueChat 唤醒，一直延续到没人再接她的话。
  // 判定全在 inori-join.js（纯函数）；这里只收集事实 + 节流 + 派发。
  // [CURIOSITY-SEED] 好奇别只由她自己的探索动作充电（那是自我封闭环：不探索→好奇 0→更不探索）。
  // 群里冒出她没见过的词，也让她"心里痒一下"——这是被动来源，和"聊到什么"绑定，不看她动不动手。
  function seedCuriosityFromChat(key, st) {
    try {
      if (!st || !String(key).startsWith('group:')) return;
      const now = Date.now();
      if (now - Number(st.lastCuriositySeedAt || 0) < 10 * 60000) return;
      let known = '';
      try { known = loadLessons(cfg.socialV2?.lessons?.file).map((x) => x.text).join('\n'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11770'); }
      try {
        const slang = loadSlang(SLANG_FILE).filter((e) => e.content);
        if (slang.length) known += '\n' + slang.map((e) => `${e.content} ${e.meaning ?? ''}`).join('\n');
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11774'); }
      const rawUnk = findUnknownTerms(Array.isArray(st.recentMessages) ? st.recentMessages : [], known, { minMessages: 2, limit: 6 });
      // 排掉她自己的名字/别名（分词会把「小满/满子」切碎当生词，那不是她的好奇）
      let selfNames = [];
      try { selfNames = [String(getSelfNickname() ?? ''), ...(cfg.socialV2?.aboutSelf?.aliases ?? [])].map((x) => String(x).toLowerCase()).filter(Boolean); } catch { selfNames = []; }
      const PLACEHOLDERS = ['图片', '表情', '链接', '视频', '语音', '转发', '引用', '拍一拍'];
      // 群友昵称/名片也会被分词当生词（「超自」「达克」），一并排掉
      const senderNames = (Array.isArray(st.recentMessages) ? st.recentMessages : []).map((m) => String(m?.sender ?? '').toLowerCase()).filter(Boolean);
      const unk = rawUnk.filter((x) => {
        const t = String(x?.term ?? '').toLowerCase();
        if (!t) return false;
        if (/^[\x00-\x7f]+$/.test(t)) return false;      // 纯 ASCII（aaa/xcwds/url/id）不是中文生词
        if (PLACEHOLDERS.includes(t)) return false;         // 消息占位符
        if (senderNames.some((n) => n.includes(t) || t.includes(n))) return false;
        return !selfNames.some((n) => n.includes(t) || t.includes(n));
      }).slice(0, 4);
      if (!unk.length) return;
      st.lastCuriositySeedAt = now;
      // [WIRING-FIX] lifeState 原来是 app.mjs main() 的局部量：这里读不到，好奇刺激那一步
      // 每次都 ReferenceError（生词好奇心一直没落过盘）。改成读注入的 getLifeState()。
      const lifeStateNow = markCuriosityStimulus(getLifeState(), 0.2, now);
      saveLifeFile(lifeStateNow);
      saveSocialV2State();
      // [INTEREST] 遇到不认识的东西 → 好奇（记成事实，下次有动静时递给她）
      try {
        let enc = loadInterestEncounters();
        for (const x of unk) enc = recordEncounter(enc, { kind: 'unknown', what: x.term, src: '群聊' }, now);
        saveInterestEncounters(enc);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11800'); }
      // [CURIOSITY-WRITE] 生词同时落成「挂心的事」。以前 curiosity.json 全仓库没人写，
      // renderCuriosityLine 永远是 null（模块和注入都在，数据从不产生）。
      // 与进行中的目标去重：同一件事不要在两套存储里各挂一遍。
      try {
        let goalTitles = [];
        try {
          goalTitles = loadGoals(cfg.socialV2?.goals?.file)
            .filter((g) => g.status === 'active')
            .map((g) => String(g.title ?? g.text ?? '').toLowerCase())
            .filter(Boolean);
        } catch { goalTitles = []; }
        let cur = { loops: [] };
        try { cur = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'curiosity.json'), 'utf8')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11813'); }
        for (const x of unk) {
          const term = String(x.term || '').trim();
          const low = term.toLowerCase();
          if (!low) continue;
          if (goalTitles.some((g) => g.includes(low) || (low.length >= 2 && low.includes(g.slice(0, 4))))) continue;
          cur = recordCuriosity(cur, { text: `群里冒出来的「${term}」，到底什么意思还没搞清`, source: '群聊生词' }, now);
        }
        const cP = path.join(STATE_DIR, 'curiosity.json');
        // [AUDIT-FIX] 唯一 tmp：固定 `.tmp` 名会让两个并发 seed 互相覆盖同一个临时文件。
        const tmp = `${cP}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        fs.mkdirSync(path.dirname(cP), { recursive: true });
        try {
          fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
          renameWithRetry(tmp, cP);
        } finally {
          // [AUDIT-FIX] rename 失败时清理自己创建的 tmp；成功时 tmp 已消失，忽略 ENOENT。
          try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11826'); }
      log(`[curiosity-seed] ${key} 群里出现的生词让她心痒了一下：${unk.map((x) => x.term).join(',')}`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'social-timing-service.mjs:11828'); }
  }
  function maybeJoinOrContinue(key, st) {
    try {
      if (getCurrentMode() !== 'reserved2' || socialV2.paused) return;
      if (!String(key).startsWith('group:')) return;
      if (!st) return;
      const now = Date.now();
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const win = 10 * 60 * 1000;
      const inWindow = recent.filter((m) => m && String(m.text ?? "").trim() && now - (Number(m.time) || 0) < win);
      const othersRecent = inWindow.filter((m) => !m.isSelf).length;
      const lastSelfMsg = [...recent].reverse().find((m) => m && m.isSelf && now - (Number(m.time) || 0) < 60 * 60 * 1000);
      const lastSelfAt = Number(lastSelfMsg?.time) || Number(st.lastAiReplyAt) || 0;
      const newOthers = lastSelfMsg
        ? recent.filter((m) => m && !m.isSelf && Number(m.time || 0) > Number(lastSelfMsg.time || 0)).length
        : 0;
      // ① 会话延续（优先级更高：她正在聊）
      // [INTENTION-DRIVEN] 意志先于概率：累了/想整理时不硬接话。
      if (stateHub && typeof stateHub.selectIntention === 'function') {
        try {
          const hour = new Date(now).getHours();
          const night = hour >= 22 || hour < 7;
          const gate = gateProactive(stateHub.selectIntention({
            scene: 'group', directed: false, unreadCount: newOthers, now, night,
            idleMs: lastSelfAt ? now - lastSelfAt : 0,
          }), { scope: 'continue' });
          if (!gate.allow) {
            log(`[intent] ${key} 意志暂缓延续：${gate.reason}`);
            logAction({ t: 'proactive_check', key, decided: 'intent-block', scope: 'continue', reason: gate.reason, type: gate.type });
            return;
          }
        } catch { /* 意志门失败不阻塞旧路径 */ }
      }
      const cont = decideContinue({ now, lastSelfAt, newOthers, continueTimes: st.continueWakeTimes }, cfg.socialV2?.proactive?.engagement ?? {});
      if (cont.ok) {
        st.continueWakeTimes = [...(Array.isArray(st.continueWakeTimes) ? st.continueWakeTimes : []), now].filter((t) => now - Number(t || 0) < 3600 * 1000).slice(-30);
        saveSocialV2State();
        log(`[engage] ${key} 接着聊：你上一条之后又有 ${newOthers} 条新消息`);
        logAction({ t: 'proactive_check', key, decided: 'continue', newOthers });
        {
          const lastOther = [...recent].reverse().find((m) => m && !m.isSelf && String(m.text ?? '').trim());
          void scheduleWakeWithSecretary(key, 'continueChat', st, lastOther?.text || '', lastOther?.sender || '');
        }
        return;
      }
      // ② 活跃群插话机会
      if (!(Number(st.wakeConfig?.triggers?.probability) > 0)) return; // 她把概率设成 0 = 不想因闲聊被叫醒，尊重
      let adaptive = computeProactivity(st, now);
      // [C6] 关系/状态进主动性：想找人说话时更容易插话；很累/很紧时更收着。
      // 只做 ±25% 量级的缩放，不改变 decideJoin 的阈值与去重。
      try {
        if (typeof getSelfState === 'function') {
          const self = getSelfState();
          if (self) {
            const hunger = Math.max(0, Math.min(1, Number(self.socialHunger) || 0));
            const energy = Math.max(0, Math.min(1, Number(self.energy) || 0.6));
            const stress = Math.max(0, Math.min(1, Number(self.stress) || 0));
            const factor = 1 + 0.25 * Math.max(0, hunger - 0.5) - 0.3 * Math.max(0, 0.4 - energy) - 0.2 * Math.max(0, stress - 0.5);
            adaptive = Math.max(0, Math.min(1, adaptive * factor));
          }
        }
      } catch { /* 状态读不到就按旧值 */ }
      // [INTENTION-DRIVEN] 意志驱动插话：先问"她想不想现在开口"，再交给概率。
      if (stateHub && typeof stateHub.selectIntention === 'function') {
        try {
          const hour = new Date(now).getHours();
          const night = hour >= 22 || hour < 7;
          const gate = gateProactive(stateHub.selectIntention({
            scene: 'group', directed: false, unreadCount: 0, now, night,
            idleMs: lastSelfAt ? now - lastSelfAt : 0,
          }), { scope: 'join' });
          if (!gate.allow) {
            log(`[intent] ${key} 意志拦截插话：${gate.reason}`);
            logAction({ t: 'proactive_check', key, decided: 'intent-block', scope: 'join', reason: gate.reason, type: gate.type });
            return;
          }
          if (gate.boost !== 1) {
            adaptive = Math.max(0, Math.min(1, adaptive * gate.boost));
            log(`[intent] ${key} 意志放行插话（${gate.reason}）适应度 ×${gate.boost}`);
          }
        } catch { /* 意志门失败不阻塞旧路径 */ }
      }
      const join = decideJoin({
        now, othersRecent, lastSelfAt, adaptive,
        lastJoinAt: Number(st.lastJoinAt) || 0,
        joinTimes: st.joinWakeTimes,
      }, cfg.socialV2?.proactive?.join ?? {});
      const shouldLog = join.ok || !st.lastJoinLogAt || now - Number(st.lastJoinLogAt) > 60000;
      if (shouldLog) {
        log(`[join] ${key} 插话判定${join.ok ? '放行' : '跳过'}（${join.why}；别人 ${othersRecent} 条/10min，适应度 ${adaptive.toFixed(3)}${join.p != null ? `，概率 ${join.p.toFixed(2)}` : ''}）`);
        st.lastJoinLogAt = now;
      }
      if (!join.ok) return;
      if (isConversationBusyV2(key, st)) return;
      st.lastJoinAt = now;
      st.joinWakeTimes = [...(Array.isArray(st.joinWakeTimes) ? st.joinWakeTimes : []), now].filter((t) => now - Number(t || 0) < 3600 * 1000).slice(-30);
      saveSocialV2State();
      logAction({ t: 'proactive_check', key, decided: 'join', othersRecent, adaptive: Number(adaptive.toFixed(3)) });
      {
        const lastOther = [...recent].reverse().find((m) => m && !m.isSelf && String(m.text ?? '').trim());
        void scheduleWakeWithSecretary(key, 'joinTopic', st, lastOther?.text || '', lastOther?.sender || '');
      }
    } catch (error) { log(`[join] 判定失败（忽略）: ${error?.message ?? error}`); }
  }
  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // [M-1] 消息入口状态机已搬到 message-intake.mjs：懒构造，首次调用时才取依赖快照（避开 TDZ）。
  // （原 main() 里遗留的 bumpSessionEpoch / messageIntakeInst 两行已删除：本模块不用它们，
  //   其中 sessionEpoch 是未声明引用，留着只是给下一个读者挖坑。）

  return {
    replyPaceContext, stampReplyPace, lastIncomingV2, waitNextDecision, applyReplyPace,
    paceBatchMs, setupSleepTimerV2, seedCuriosityFromChat, maybeJoinOrContinue,
    clearSocialV2Timers, clearAllSocialV2Timers, drainPromptQueue, drainAllPromptQueues,
  };
}
