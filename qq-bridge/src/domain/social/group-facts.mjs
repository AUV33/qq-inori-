// 群事实/群话题：零 LLM 话题提取 + 本地 3B/flash 事实抽取。
//
// 从 app.mjs 的 main() 搬出（P3-RW-20，2026-10-31）。抽取队列状态留在本模块；
// groupFactSessions/Waiters 仍由 app 持有（mux/console 共用），注入同一实例。
import { unwrap } from '../leaves/dsh-envelope.mjs'; // [WIRING-FIX] 抽离时漏了：unwrap 未定义，群事实抽取一跑就 ReferenceError
/**
 * @param {object} ctx
 */
export function createGroupFacts(ctx) {
  const {
    cfg, getSocialV2State, saveSocialV2State, log, MEM_DIR, filesForScope, loadEntries,
    appendJsonl, extractTopics, renderGroupTopics, ensureIsolatedSession, acquireTurnSlot,
    bindTurnGrant, releaseTurnGrant, groupFactSessions, groupFactWaiters, api,
    submitPromptWithTurnSlot, parseFactsJson, completeLocal3b,
  } = ctx;
  let groupFactQueue = Promise.resolve();
  function appendGroupTopicsV2(key) {
    try {
      if (!String(key).startsWith('group:')) return;
      if (cfg.socialV2?.memory?.groupTopics?.enabled === false) return;
      const minGap = Number(cfg.socialV2?.memory?.groupTopics?.minGapMs) || 6 * 3600000;
      const st = getSocialV2State(key);
      const now = Date.now();
      if (now - Number(st.groupTopicsAt || 0) < minGap) return;
      const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, key);
      const rows = loadEntries(P.file);
      const cutoff = now - 24 * 3600000;
      const digests = [];
      for (const r of rows) {
        if (r?.kind !== 'group-digest') continue;
        const ts = Date.parse(String(r.time || '').replace(' ', 'T'));
        if (Number.isFinite(ts) && ts >= cutoff) digests.push(String(r.text ?? ''));
      }
      if (digests.length < 4) return;
      const topics = extractTopics(digests, { limit: 8, minDf: 2 });
      const text = renderGroupTopics(topics, { min: 3 });
      if (!text) return;
      const last = [...rows].reverse().find((r) => r?.kind === 'group-fact' && String(r.text || '').startsWith('近 24h 群里常聊'));
      if (last && last.text === text) { st.groupTopicsAt = now; saveSocialV2State(); return; }
      const d = new Date(now);
      const day = d.toLocaleDateString('sv-SE');
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      appendJsonl(P.file, { day, time: `${day} ${hm}`, kind: 'group-fact', text, theme: '群话题', scope: P.scope, importance: 3 }, { source: 'bridge/group-topics' });
      st.groupTopicsAt = now;
      saveSocialV2State();
      log(`[group-topics] ${key} 记了一条群话题（${[...text].length} 字）：${text.slice(0, 50)}`);
    } catch (error) {
      log(`[group-topics] 写群话题失败（已忽略）: ${error?.message ?? error}`);
    }
  }

  // [GROUP-FACTS-LLM] 用 flash 从近 24h 群摘要里抽「带谓词/指代的具体事实」（零依赖、只要 JSON）。
  // [GROUP-FACTS-LLM] 云端口（flash 会话）：本地 3B 不可用/抽不出时才走这里
  async function askGroupFactsFlash(texts, { timeoutMs = 60000, max = 5 } = {}) {
    let waiter = null;
    let sessionId = null;
    let turnGrant = null;
    try {
      sessionId = await ensureIsolatedSession('groupfact');
      turnGrant = await acquireTurnSlot('isolated:groupfact', { kind: 'background' });
      bindTurnGrant(turnGrant, sessionId);
      groupFactSessions.add(sessionId);
      try { api.events.follow(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'group-facts.mjs:10055'); }
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('群事实抽取超时')), timeoutMs);
        waiter = { resolve, reject, timer };
        const list = groupFactWaiters.get(sessionId) ?? [];
        list.push(waiter);
        groupFactWaiters.set(sessionId, list);
      });
      const input = texts.slice(-10).map((x) => String(x).slice(0, 180)).join('\n');
      const prompt = `从下面群聊摘要里提取具体事实：谁答应/喜欢/打算/买了/发生了什么。\n规则：每条一句、不超过 60 字；只输出 JSON 数组（字符串数组），没有就给 []，不要任何解释。\n\n摘要：\n${input}`;
      unwrap(await submitPromptWithTurnSlot({
        sessionId,
        label: 'isolated:groupfact',
        kind: 'background',
        content: [{ type: 'text', text: prompt }],
        turnGrant,
      }), 'groupfact.prompt');
      const raw = await answer;
      return parseFactsJson(raw, { max });
    } catch (error) {
      releaseTurnGrant(turnGrant);
      log(`[group-facts-llm] 抽取失败（已忽略）: ${error?.message ?? error}`);
      return [];
    } finally {
      if (waiter) clearTimeout(waiter.timer);
      if (sessionId) {
        const list = (groupFactWaiters.get(sessionId) ?? []).filter((w) => w !== waiter);
        if (list.length) groupFactWaiters.set(sessionId, list); else groupFactWaiters.delete(sessionId);
        groupFactSessions.delete(sessionId);
      }
    }
  }

  // [GROUP-FACTS-LLM] 先把能交给本地 3B 的交给它（免费、不排队、不花云），失败再回退 flash
  async function askGroupFactsLlm(texts, opts = {}) {
    const { max = 5 } = opts;
    try {
      const a = cfg.socialV2?.local3b ?? {};
      if (a.enabled !== false && a.groupFacts !== false) {
        const input = texts.slice(-10).map((x) => String(x).slice(0, 180)).join('\n');
        const prompt = `从下面群聊摘要里提取具体事实：谁答应/喜欢/打算/买了/发生了什么。\n规则：每条一句、不超过 60 字；只输出 JSON 数组（字符串数组），没有就给 []，不要任何解释。\n\n摘要：\n${input}`;
        const t0 = Date.now();
        const raw = await completeLocal3b(cfg, { prompt, maxTokens: 320, timeoutMs: Math.min(20000, Number(a.groupFactsTimeoutMs) || 15000), log });
        const facts = raw ? parseFactsJson(raw, { max }) : [];
        if (facts.length) { log(`[group-facts] 本地 3B 抽出 ${facts.length} 条（${Date.now() - t0}ms，省一次云端调用）`); return facts; }
        log('[group-facts] 本地 3B 没抽出有效事实，回退 flash');
      }
    } catch (error) { log(`[group-facts] 本地 3B 失败，回退 flash: ${error?.message ?? error}`); }
    return askGroupFactsFlash(texts, opts);
  }
  async function appendGroupFactsLlmNow(key) {
    try {
      if (!String(key).startsWith('group:')) return;
      if (cfg.socialV2?.memory?.groupFactsLlm?.enabled === false) return;
      const minGap = Number(cfg.socialV2?.memory?.groupFactsLlm?.minGapMs) || 6 * 3600000;
      const st = getSocialV2State(key);
      const now = Date.now();
      if (now - Number(st.groupFactsLlmAt || 0) < minGap) return;
      st.groupFactsLlmAt = now; // 先占位，失败也不轰炸
      saveSocialV2State();
      const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, key);
      const rows = loadEntries(P.file);
      const cutoff = now - 24 * 3600000;
      const digests = [];
      for (const r of rows) {
        if (r?.kind !== 'group-digest') continue;
        const ts = Date.parse(String(r.time || '').replace(' ', 'T'));
        if (Number.isFinite(ts) && ts >= cutoff) digests.push(String(r.text ?? ''));
      }
      if (digests.length < 4) return;
      const facts = await askGroupFactsLlm(digests, { max: Number(cfg.socialV2?.memory?.groupFactsLlm?.max) || 5 });
      if (!facts.length) { log(`[group-facts-llm] ${key} 本轮没抽出事实`); return; }
      const d = new Date(now);
      const day = d.toLocaleDateString('sv-SE');
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const seen = new Set(rows.map((r) => String(r.text ?? '')));
      let written = 0;
      for (const fact of facts) {
        if (seen.has(fact)) continue;
        appendJsonl(P.file, { day, time: `${day} ${hm}`, kind: 'group-fact', text: fact, theme: '群事实', scope: P.scope, importance: 3 }, { source: 'bridge/group-facts-llm' });
        seen.add(fact); written += 1;
      }
      log(`[group-facts-llm] ${key} 抽出 ${facts.length} 条，写入 ${written} 条：${facts.slice(0, 2).join(' / ').slice(0, 80)}`);
    } catch (error) {
      log(`[group-facts-llm] 写入失败（已忽略）: ${error?.message ?? error}`);
    }
  }

  function appendGroupFactsLlm(key) {
    const job = groupFactQueue.then(
      () => appendGroupFactsLlmNow(key),
      () => appendGroupFactsLlmNow(key),
    );
    groupFactQueue = job.catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/group-facts.mjs:156'));
    return job;
  }

  return { appendGroupTopicsV2, askGroupFactsFlash, askGroupFactsLlm, appendGroupFactsLlmNow, appendGroupFactsLlm };
}
