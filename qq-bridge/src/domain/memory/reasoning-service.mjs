// 思考链留存与学习候选/群反馈/复读检测。
//
// 从 app.mjs 的 main() 搬出（P3-RW-40，2026-11-01）。reasoningBuffers 状态留在本模块；
// 文件路径/日志/情绪状态注入。
import { reasoningTextOf, reasoningTailText, shouldKeepFull, candidateTextFrom } from '../leaves/inori-reasoning.js';

/**
 * @param {object} ctx
 */
export function createReasoningService(ctx) {
  const {
    cfg, log, fs, reverse, appendThought, readJsonlSafe, REASONING_LOG_FILE,
    LESSON_CANDIDATES_FILE, addRumination, loadMoodState,
  } = ctx;
  const reasoningBuffers = new Map();
  function captureReasoning(sessionId, event) {
    const sid = String(sessionId ?? '');
    if (!sid) return;
    if (event?.type === 'turn/start') { reasoningBuffers.delete(sid); return; }
    if (event?.type !== 'assistant/message') return;
    const t = reasoningTextOf(event);
    if (!t) return;
    const buf = reasoningBuffers.get(sid) ?? { parts: [], chars: 0 };
    buf.parts.push(t);
    buf.chars += t.length;
    // 首个片段记一行（验证事件真的带思考；后续片段不重复刷屏）
    if (buf.parts.length === 1) log(`[reasoning] 收到 ${t.length} 字思考（${sid.slice(0, 10)}）`);
    // 单回合最多留 30 段（防止超长 agent 回合把缓冲撑爆）
    if (buf.parts.length > 30) { buf.chars -= buf.parts[0].length; buf.parts.shift(); }
    reasoningBuffers.set(sid, buf);
  }

  /** 回合结束：A 摘要进 thoughts / B 长思考留全文 / C 失败回合留经验候选 */
  function flushReasoning(sessionId, { failed = false } = {}) {
    const sid = String(sessionId ?? '');
    const buf = reasoningBuffers.get(sid);
    if (!buf) { log(`[reasoning] 本轮没收到思考（${sid.slice(0, 10)}）`); return; }
    reasoningBuffers.delete(sid);
    const joined = buf.parts.join('\n').trim();
    if (joined.length < 40) { log(`[reasoning] 本轮 ${joined.length} 字，太短不记（${sid.slice(0, 10)}）`); return; } // 太短的不算"想过"
    const tail = reasoningTailText(joined);
    log(`[reasoning] 本轮 ${joined.length} 字${tail ? ` → 摘要「${tail.slice(0, 40)}」` : '（没抽到摘要）'}`);
    try { if (tail) appendThought('reasoning', tail); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reasoning-service.mjs:9715'); }
    try {
      if (shouldKeepFull(joined.length)) {
        let rows = readJsonlSafe(REASONING_LOG_FILE);
        rows.push({ at: new Date().toISOString(), sessionId: sid, chars: joined.length, failed: !!failed, text: joined.slice(-4000) });
        if (rows.length > 200) rows = rows.slice(-200);
        fs.writeFileSync(REASONING_LOG_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        log(`[reasoning] 留存 ${joined.length} 字${failed ? '（失败回合）' : ''}`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reasoning-service.mjs:9724'); }
    try {
      const cand = candidateTextFrom(joined, { failed });
      if (cand) {
        let rows = readJsonlSafe(LESSON_CANDIDATES_FILE);
        if (!rows.some((r) => String(r?.text ?? '') === cand)) {
          rows.push({ at: new Date().toISOString(), text: cand, sessionId: sid });
          if (rows.length > 100) rows = rows.slice(-100);
          fs.writeFileSync(LESSON_CANDIDATES_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
          log(`[reasoning] 失败回合留下经验候选：${cand.slice(0, 40)}`);
        }
      }
      // [RUMINATE-3] 失败回合也留一条「那件事没做成」的余温（以前反刍只有三种触发源，长期空转）
      if (failed && tail.length >= 8) {
        const keyOfTurn = reverse.get(sid) || '';
        addRumination({ core: tail, intensity: 0.6, source: 'task-failed', key: keyOfTurn });
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reasoning-service.mjs:9741'); }
  }

  /** 她自己想到、还没定成经验的候选（7 天过期，不催） */
  function renderLessonCandidates(max = 2) {
    try {
      const now = Date.now();
      const rows = readJsonlSafe(LESSON_CANDIDATES_FILE)
        .filter((r) => r && r.text && now - Date.parse(String(r.at ?? '')) < 7 * 86400000);
      if (!rows.length) return '';
      const lines = rows.slice(-max).map((r) => `- ${String(r.text).slice(0, 120)}`);
      return `【我自己想到的、还没定成经验】\n${lines.join('\n')}\n（觉得对就 lesson_write 记下来；觉得没用就别管，7 天后自己过期。）`;
    } catch { return ''; }
  }

  // [GROUP-FB] 群反馈率（被接率）：近 24h 滚动窗内 replied/sent。样本不足（<4）或过期
  // 返回 null——调用方各自决定兜底（proactivity 用 0.5 中性，注入层直接不出这句话）。
  // 统一取数：注入层与 proactivity 共用，两处口径永远一致（旧的各自读法一累计一窗口，
  // 同一份数据两个说法）。
  function groupFeedbackRate(st, now = Date.now()) {
    const gf = st?.groupFeedback;
    if (!gf) return null;
    const sent = Number(gf.sent) || 0;
    if (sent < 4) return null;
    if (now - Number(gf.windowStart || 0) > 24 * 3600000) return null; // 过期窗（过 24h 未再发言）
    return Number(gf.replied || 0) / sent;
  }

  // [PROACTIVITY] 水群适应度：群里别人越活跃 + 她自己最近说得越多 + 被接率越高 + 情绪越有劲 → 越主动
  function computeProactivity(st, now = Date.now()) {
    try {
      const rs = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const win = 15 * 60 * 1000;
      const others = rs.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < win).length;
      const mine = rs.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < win).length;
      const rate = groupFeedbackRate(st, now) ?? 0.5; // 无近期样本 → 中性
      // [MOOD-WIRE] 以前读 st.mood.temperature —— 那个字段从没被写过，恒 0.4。
      // 情绪真源在 inori_state.json（温度），读不到才用中性 0.4。
      let temp = 0.4;
      try {
        const mstP = loadMoodState(cfg.socialV2?.mood?.file);
        if (Number.isFinite(Number(mstP?.warmth))) temp = Number(mstP.warmth);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reasoning-service.mjs:9783'); }
      // 自我校准（2026-10-25 用户反馈「群聊过于活跃」）：mine 项取负——
      // 说得越多越该收一收（像人：话说多了自然冷却）。旧式 +0.20·mine 是
      // 正反馈环：刷屏→适应度更高→注入提示更活跃→继续刷屏，停不下来。
      const p = 0.05
        + 0.25 * Math.min(1, others / 20)
        - 0.20 * Math.min(1, mine / 10)
        + 0.15 * (rate - 0.5)
        + 0.10 * (temp - 0.4);
      return Math.max(0.01, Math.min(0.5, +p.toFixed(3)));
    } catch { return 0.05; }
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  // [ECHO] 复读/加一：群里连续有人发同一句、或一起刷「加一」，记一条状态；
  // 唤醒时提示她可以接一句（接不接由她定），并保证同一条复读只提示一次。
  const ECHO_WINDOW_MS = 90 * 1000;
  function echoNorm(t) {
    return String(t || '')
      .replace(/\[[^\]]{0,16}\]/g, '')
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .toLowerCase();
  }
  function isPlusOneText(t) {
    return /^(加一|加1|\+1|1|附议|同上)$/.test(t);
  }
  function detectEchoChain(key, st, msg) {
    try {
      if (!String(key).startsWith('group:')) return;
      const text = echoNorm(msg?.text || msg?.plain || '');
      if (!text) return;
      const now = Date.now();
      const plus = isPlusOneText(text);
      const prev = st.echoState && now - Number(st.echoState.at || 0) < ECHO_WINDOW_MS ? st.echoState : null;
      let count = 1;
      if (prev && (prev.text === text || (plus && prev.plus))) count = Number(prev.count || 1) + 1;
      st.echoState = { text, plus: plus || !!prev?.plus, count, at: now };
      if ((!plus && count >= 3) || (plus && count >= 2)) {
        st.echoState.ready = true;
        log(`[echo] ${key} 复读「${String(msg?.text || '').slice(0, 20)}」×${count}`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reasoning-service.mjs:9824'); }
  }


  return { captureReasoning, flushReasoning, renderLessonCandidates, groupFeedbackRate, computeProactivity, echoNorm, isPlusOneText, detectEchoChain };
}
