// 群记忆沉淀：群 digest、群像、本地 3B 抽取、静默沉淀。
//
// 从 app.mjs 的 main() 搬出（P3-RW-19，2026-10-31）。所有记忆读写/模型调用经 deps 注入；
// 本模块只改传入的 st 与记忆文件。
/**
 * @param {object} ctx
 */
export function createGroupMemory(ctx) {
  const {
    cfg, getSocialV2State, saveSocialV2State, log, fs, path, MEM_DIR, filesForScope,
    loadEntries, appendJsonl, buildGroupDigest, sanitizeFact, withWindow, loadMoodState,
    appendGroupTopicsV2, appendGroupFactsLlm,
    summarizeGroupSpeakers, DEFAULT_EXTRACT, shouldExtractMemory, local3bAlive, ensureLocal3b,
    extractMemoryFacts, completeLocal3b,
  } = ctx;
  function writeGroupMemoryDigestV2(key) {
    try {
      if (!String(key).startsWith('group:')) return;
      if (cfg.socialV2?.groupMemory?.enabled === false) return;
      const st = getSocialV2State(key);
      const minGap = Number(cfg.socialV2?.groupMemory?.minGapMs) || 10 * 60 * 1000;
      const now = Date.now();
      if (now - Number(st.groupMemoAt || 0) < minGap) return;
      const recent = (st.recentMessages ?? []).filter((m) => m && m.text).slice(-12);
      // [MEM-CLEAN] 清洗 + 合并 + 去重 + 限长（原来是把原始消息硬截 36 字拼起来，
      // 会把 [表情277]、控制字符、纯占位和单人刷屏一起写进记忆库，检索时全是噪声）
      const digest = buildGroupDigest(recent, { maxPerPerson: 2, perLineChars: 30, totalChars: 240 });
      if (!digest.text) return;
      const d = new Date(now);
      const day = d.toLocaleDateString('sv-SE');
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const text = sanitizeFact(withWindow(`群里在聊：${digest.text}`, Number(recent[0]?.time) || now, now));
      const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, key);
      fs.mkdirSync(path.dirname(P.file), { recursive: true });
      // [MEM-DIM] 记忆补两个维度：这轮主要在跟谁聊（sender）、她当时什么情绪（mood=温度/精力）。
      // 以前条目只有 day/time/kind/text/theme/scope/importance，回读时"谁、什么心情"全丢。
      let dominantSender = '';
      try {
        const counts = new Map();
        for (const m of recent) {
          const s = String(m?.sender || '');
          if (!m || m.isSelf || !s) continue;
          counts.set(s, (counts.get(s) || 0) + 1);
        }
        dominantSender = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      } catch { dominantSender = ''; }
      let moodNote = '';
      try {
        const mst = loadMoodState(cfg.socialV2?.mood?.file);
        moodNote = `${Number(mst.warmth).toFixed(2)}/${Number(mst.energy).toFixed(2)}`;
      } catch { moodNote = ''; }
      const entry = {
        day, time: `${day} ${hm}`, kind: 'group-digest', text, theme: '群聊', scope: P.scope, importance: 2,
        ...(dominantSender ? { sender: dominantSender } : {}),
        ...(moodNote ? { mood: moodNote } : {}),
      };
      appendJsonl(P.file, entry, { source: 'bridge/group-memo' });
      appendGroupFactIfChangedV2(key);
      appendGroupTopicsV2(key);
      void appendGroupFactsLlm(key);
      st.groupMemoAt = now;
      st.groupMemoAnchor = Number(recent[recent.length - 1]?.time) || now; // [SILENT-DEPOSIT] 锚点：之后只有比这条新的消息才算「新沉淀」，同批内容不重复录入
      saveSocialV2State();
      // [MEM-EXTRACT] 群 digest 落库后顺手用本地 3B 抽事实（异步，不挡 digest）
      void runMemoryExtractV2(key, recent).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/group-memory.mjs:65'));
      log(`[group-memo] ${key} 记了一条群记忆（${[...text].length} 字，保留 ${digest.kept} 段/丢弃 ${digest.dropped} 条）：${text.slice(0, 40)}…`);
    } catch (error) {
      log(`[group-memo] 写群记忆失败（已忽略）: ${error?.message ?? error}`);
    }
  }

  // [MEM-EXTRACT] 本地 3B 确定性记忆抽取：群 digest 后 / 唤醒时跑一轮，
  // 把「谁答应/喜欢/打算/发生了什么」抽成短事实写进对应 scope 的记忆库。
  // 与云端 group-facts-llm 不冲突：那边是 6h 一轮的摘要抽取，这里是本地零 token 的即时沉淀。
  async function runMemoryExtractV2(key, messages) {
    try {
      const conf = cfg.socialV2?.memoryExtract ?? {};
      if (conf.enabled === false) return 0;
      const st = getSocialV2State(key);
      const now = Date.now();
      const pending = (Array.isArray(messages) ? messages : [])
        .filter((m) => m && String(m.text ?? '').trim() && !m.isSelf);
      if (!pending.length) return 0;
      const minGapMs = Math.max(60_000, Number(conf.minGapMs) || DEFAULT_EXTRACT.minGapMs);
      const minMessages = Math.max(1, Number(conf.minMessages) || DEFAULT_EXTRACT.minMessages);
      if (!shouldExtractMemory({ now, lastAt: st.memExtractAt, pendingCount: pending.length, minGapMs, minMessages })) return 0;
      if (!(await local3bAlive(cfg))) { void ensureLocal3b(cfg, log); return 0; }
      st.memExtractAt = now; // 先占位：抽不出来也不每轮重试
      saveSocialV2State();
      const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, key);
      const rows = loadEntries(P.file).slice(-600);
      const { facts, raw } = await extractMemoryFacts({
        messages: pending.slice(-16),
        existingTexts: rows.map((r) => String(r?.text ?? '')),
        max: Math.max(1, Number(conf.maxFacts) || DEFAULT_EXTRACT.maxFacts),
        complete: (prompt) => completeLocal3b(cfg, { prompt, maxTokens: 280, timeoutMs: 20000, log }),
      });
      if (!facts.length) {
        if (raw) log(`[mem-extract] ${key} 本轮没抽出可写事实`);
        return 0;
      }
      const d = new Date(now);
      const day = d.toLocaleDateString('sv-SE');
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      let written = 0;
      for (const fact of facts) {
        appendJsonl(P.file, {
          day, time: `${day} ${hm}`, kind: 'fact', text: fact, theme: '抽取', scope: P.scope, importance: 2,
        }, { source: 'bridge/3b-extract' });
        written += 1;
      }
      log(`[mem-extract] ${key} 写入 ${written} 条（${facts[0].slice(0, 30)}…）`);
      return written;
    } catch (error) {
      log(`[mem-extract] ${key} 抽取失败（已忽略）: ${error?.message ?? error}`);
      return 0;
    }
  }

  // [GROUP-FACT] ①群记忆「原料→认知」轻改造（2026-10-26 用户拍板）：
  // group-digest 是「谁在聊什么」的原料；每次写完 digest 后确定性聚合近 24h 发言者分布，
  // 有变化就追加一条 kind=group-fact（谁常来/说什么），让群库里有可检索的认知而不是只有原料。
  // 零 LLM；读端不需改动（recall 不按 kind 过滤）。
  function appendGroupFactIfChangedV2(key) {
    try {
      if (cfg.socialV2?.memory?.groupFact?.enabled === false) return;
      const P = filesForScope(cfg.socialV2?.memory?.dir || MEM_DIR, key);
      const rows = loadEntries(P.file);
      const cutoff = Date.now() - 24 * 3600000;
      const digests = [];
      for (const r of rows) {
        if (r?.kind !== 'group-digest') continue;
        const t = Date.parse(String(r.time || '').replace(' ', 'T'));
        if (Number.isFinite(t) && t >= cutoff) digests.push(String(r.text ?? ''));
      }
      if (digests.length < 2) return; // 样本太少不写认知
      const { speakers, total } = summarizeGroupSpeakers(digests, { limit: 3 });
      if (!speakers.length) return;
      const sig = speakers.map((s) => `${s.name}:${s.count}`).join(',');
      const facts = rows.filter((r) => r?.kind === 'group-fact');
      const last = facts.length ? facts[facts.length - 1] : null;
      const st = getSocialV2State(key);
      const minGap = Number(cfg.socialV2?.memory?.groupFact?.minGapMs) || 30 * 60 * 1000;
      if (last && last.sig === sig) return; // 群像没变不重复写
      if (Date.now() - Number(st.groupFactAt || 0) < minGap) return; // 30 分钟节流
      const d = new Date();
      const day = d.toLocaleDateString('sv-SE');
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const text = `近24h群像：发言最多 ${speakers.map((s) => `${s.name}（${s.count} 条）`).join('、')}；共 ${total} 条 / ${digests.length} 段摘要`;
      appendJsonl(P.file, { day, time: `${day} ${hm}`, kind: 'group-fact', text, theme: '群聊', scope: P.scope, sig, sample: digests.length, importance: 4 }, { source: 'bridge/group-fact' });
      st.groupFactAt = Date.now();
      saveSocialV2State();
      log(`[group-fact] ${key} 群像更新：${text}`);
    } catch (error) {
      log(`[group-fact] 写入失败（已忽略）: ${error?.message ?? error}`);
    }
  }

  // [SILENT-DEPOSIT] 用户拍板（2026-10-25）：她整场没说话时，群里别人的话题也沉淀进群记忆（联想素材），
  // 而不是只在她说完后写。与说完轮共用 writeGroupMemoryDigestV2 的锚点与 10min 节流：
  //  - 锚点 groupMemoAnchor 只在「真的写了一条」时前进 → 说完轮写过的内容，静默轮不会重复录入
  //  - 新「别人的」消息 < 3 条就不动手（不值得单独成条，避免碎片噪声）
  function sedimentGroupMemoryIfStale(key) {
    try {
      if (!String(key).startsWith('group:')) return;
      if (cfg.socialV2?.groupMemory?.enabled === false) return;
      const st = getSocialV2State(key);
      const anchor = Number(st.groupMemoAnchor || 0);
      const newOthers = (st.recentMessages ?? []).filter((m) => m && !m.isSelf && m.text && Number(m.time || 0) > anchor).length;
      if (newOthers < 3) return;
      const minGap = Number(cfg.socialV2?.groupMemory?.minGapMs) || 10 * 60 * 1000;
      if (Date.now() - Number(st.groupMemoAt || 0) < minGap) return; // 节流与说完轮共用：刚写过就不重复
      writeGroupMemoryDigestV2(key);
      log(`[group-memo] ${key} 静默轮沉淀了一条群记忆（${newOthers} 条新别人消息，她还没开口）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'group-memory.mjs:10311'); }
  }

  // [RAW] 原文层：每条入站消息落 data/raw/<scope>.jsonl；结构化主张另写 kind=claim 进记忆库。
  // 这是「按需检索」的地基——语义查不到的承诺/冲突/原话，靠这层字面命中兜底。

  return { writeGroupMemoryDigestV2, runMemoryExtractV2, appendGroupFactIfChangedV2, sedimentGroupMemoryIfStale };
}
