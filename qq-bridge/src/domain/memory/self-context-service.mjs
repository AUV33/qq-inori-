// 自我/关系/语用上下文：记忆事实、关系画像、自我叙事、语用帧、近况、引用。
//
// 从 app.mjs 的 main() 搬出（P3-RW-41，2026-11-01）。MEMORY_FILE/coreFactsCache 状态随模块；
// 记忆检索/情绪/关系/语言片段全部注入，模块只拼文本。
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} ctx
 */
import { UTTERANCE_KIND } from './memory-retrieve.js';
import {
  loadEmotionVector, saveEmotionVector, observeSelfEmotion,
  renderEmotionVector, recordSelfEmotion,
} from '../leaves/inori-emotion-vector.js';

export function createSelfContext(ctx) {
  const {
    cfg, log, MEM_DIR, STATE_DATA_DIR, appendJsonl, stateHub = null, applyEmotionCalibration, appraiseSelfEmotion,
    buildEmpathicStance, buildQuoteContext, canonScope, classifyPragmaticFrame,
    createDiscourseState, dedupeFacts, describeEdit, extractFacts, filesForScope,
    findLanguageEpisodesByContext, getSocialV2State, loadEntries, loadIntentions,
    loadMoodState, pickHerRecentEdit, readLanguageEpisodes, readOutcomes,
    renderDiscourseBlock, renderIntentionsBlock, renderLanguageEpisodeBlock,
    renderOutcomesBlock, renderPragmaticBlock, renderSelfEmotionBlock, renderSelfRecent,
    reverse, saveSocialV2State, stateDataPath, stateWithKey,
    updateDiscourseState, writeTextAtomic,
  } = ctx;
  // [FACTS] 主人私聊里自动提炼稳定事实（不靠她调 memory_save——历史 0 次）
  const MEMORY_FILE = MEM_DIR + '/memory.jsonl';
  let coreFactsCache = null;
  // [MEM-ROWS-CACHE] readMemoryRows 被 maybeExtractFacts 在**每条主人私聊消息**上调用，
  // 原来每次都全量 readFileSync + JSON.parse 整个 memory.jsonl。按 mtimeMs+size 缓存，
  // 文件没变就直接复用；写入/删除后主动失效。同一秒内 append 且 size 不变的概率极低，
  // 且 maybeExtractFacts 写完会显式清缓存，不会读到脏数据。
  let memoryRowsCache = null;
  function readMemoryRows() {
    try {
      let stamp = '';
      try {
        const s = fs.statSync(MEMORY_FILE);
        stamp = `${s.mtimeMs}:${s.size}`;
      } catch { memoryRowsCache = null; return []; }
      if (memoryRowsCache && memoryRowsCache.stamp === stamp) return memoryRowsCache.rows;
      const rows = fs.readFileSync(MEMORY_FILE, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      memoryRowsCache = { stamp, rows };
      return rows;
    } catch { return []; }
  }
  function maybeExtractFacts(key, msg) {
    try {
      const owner = String(cfg.ownerQQ || '');
      if (!owner || key !== `private:${owner}`) return;
      const text = String(msg?.text || msg?.plain || '');
      if (!text) return;
      const existing = readMemoryRows().map((r) => String(r.text || ''));
      const cands = dedupeFacts(extractFacts(text), existing);
      if (!cands.length) return;
      fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
      const now = new Date();
      const day = now.toLocaleDateString('sv-SE');
      const time = `${day} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const c of cands) {
        // 锁内追加（learning-store 的 appendJsonl）：memory.jsonl 同时被 DSH 侧 MCP 进程
        // 与脚本追加，裸 appendFileSync 会与其它写者交错
        const ar = appendJsonl(MEMORY_FILE, {
          day, time, kind: 'fact', text: c.text, src: 'auto', evidence: c.evidence, theme: c.kind, importance: 4,
        }, { source: 'bridge/facts' });
        if (!ar.ok) fs.appendFileSync(MEMORY_FILE, JSON.stringify({ day, time, kind: 'fact', text: c.text, src: 'auto', importance: 4, evidence: c.evidence, theme: c.kind }) + '\n', 'utf8');
      }
      coreFactsCache = null;
      memoryRowsCache = null; // 写入后主动失效，下一轮去重读到新事实
      log(`[facts] +${cands.length} 条：${cands.map((c) => c.text).join(' / ').slice(0, 120)}`);
    } catch (error) { log(`[facts] 提炼失败（忽略）: ${error?.message ?? error}`); }
  }
  function renderCoreFacts() {
    try {
      const s = fs.statSync(MEMORY_FILE);
      if (coreFactsCache && coreFactsCache.mtime === s.mtimeMs) return coreFactsCache.text;
      const rows = readMemoryRows().filter((r) => r.kind === 'fact');
      const picked = rows.slice(-8).map((r) => `- ${r.text}`);
      const text = picked.length ? `【关于他（长期事实，别记错）】\n${picked.join('\n')}` : '';
      coreFactsCache = { mtime: s.mtimeMs, text };
      return text;
    } catch { return ''; }
  }

  // [SELF-PROFILE] 自我档案：从技能库/经验数/进化记录/目标派生，不编造
  function renderSelfProfile(model) {
    try {
      const lines = [];
      let names = [];
      try {
        const sk = JSON.parse(fs.readFileSync(stateDataPath('skills.json'), 'utf8'));
        const arr = Array.isArray(sk) ? sk : (Array.isArray(sk?.skills) ? sk.skills : []);
        names = arr.map((s) => s && (s.name || s.title)).filter(Boolean).slice(0, 3);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9353'); }
      if (names.length) lines.push(`我会做的事：${names.join('、')}。`);
      if (model?.lessonCount) lines.push(`我攒了 ${model.lessonCount} 条经验。`);
      try {
        // [SELF-EDIT-LINE] 只认「她自己改的」（actor==='her'）。旧实现只看有没有 file 字段，
        // 而护栏把 owner 的搬迁也记成 code_edit → 她被注入"我最近改过自己：src/xxx"，
        // 其实不是她改的（审计 §8）。没有她的记录就整句不说，绝不拿别人的改动替她编成长。
        const evoAll = fs.readFileSync(stateDataPath('evolution.jsonl'), 'utf8').split('\n').filter(Boolean);
        const evoRows = [];
        for (const line of evoAll) {
          try { evoRows.push(JSON.parse(line)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9363'); }
        }
        const herEdit = pickHerRecentEdit(evoRows);
        if (herEdit) lines.push(`我最近改过自己：${describeEdit(herEdit)}。`);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9367'); }
      try {
        const g = JSON.parse(fs.readFileSync(stateDataPath('goals.json'), 'utf8'));
        const arr = Array.isArray(g) ? g : (Array.isArray(g?.goals) ? g.goals : []);
        const n = arr.filter((x) => x && !x.done && !x.completed).length;
        if (n) lines.push(`我手头有 ${n} 件事要做。`);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9373'); }
      // [NO-LENGTH-JUDGE] 不再把"说话偏短/偏长"写进自我档案：字数会变成自我要求。
      // [SELF-REVIEW] 自我评价：从数据里得出"我在改什么"，不是别人评价她
      const issues = [];
      if (model?.chase && Number(model.chase.count) > 0 && Number(model.chase.rate) < 50) issues.push(`追人回报 ${model.chase.rate}%`);
      if (model?.work && Number(model.work.failed) > 0) issues.push(`做事失败 ${model.work.failed} 次`);
      if (issues.length) lines.push(`我在改的地方：${issues.join('；')}。`);
      return lines.length ? `【自我档案】\n${lines.join('\n')}` : '';
    } catch { return ''; }
  }

  // ── [SELF-NARRATIVE] 她自己写的「我怎么看我自己」────────────────────────
  // 和 self_edit(target=selfnotes) 用的是同一个文件：state/self-notes.md（纯文本）。
  // 以前它只写不读——没有任何地方注入，等于写了没人看见；这里把读侧接上：
  // 聊天唤醒和自主时间都会带上。写入口：qq_self_note（轻量追加/改写）或 self_edit。
  const SELF_NOTES_FILE = path.join(STATE_DATA_DIR, 'self-notes.md');
  function loadSelfNarrative() {
    try {
      const text = fs.readFileSync(SELF_NOTES_FILE, 'utf8').trim();
      let updatedAt = '';
      try { updatedAt = fs.statSync(SELF_NOTES_FILE).mtime.toISOString(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9393'); }
      return { text, updatedAt };
    } catch { return { text: '', updatedAt: '' }; }
  }
  function saveSelfNarrative(text) {
    const body = String(text ?? '').trim().slice(0, 4000);
    try {
      try { fs.copyFileSync(SELF_NOTES_FILE, SELF_NOTES_FILE + '.bak-' + Date.now()); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9400'); }
      writeTextAtomic(SELF_NOTES_FILE, body ? body + '\n' : '', { source: 'her/self-notes' });
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9402'); }
    return { text: body, updatedAt: new Date().toISOString() };
  }
  function renderSelfNarrative() {
    const { text } = loadSelfNarrative();
    if (!text) return '';
    return `【你现在怎么看自己（你自己写的，随时能改）】\n${text}`;
  }

  // [KNOWLEDGE-CANDIDATES] 从查到记：把反复查过、还没记下来的外部知识做成注入块。
  // 只在**私聊**唤醒时注入：她在这里有 key/token，真的能 qq_cognition_add 记下去；
  // 自主时间（own-life/free-tick）没有令牌，摆出来她也写不了，所以那里只注入已记下的认知。
  // [QUOTE-CONTEXT] 有人引用了她那条：优先查 utterance 账本（记忆库），查不到再退回会话窗口。
  // [SELF-RECENT] 她在「别的会话」最近说过的事（私聊/其它群），压成 2–3 行递进当前提示。
  // 2026-10-30：私聊里说「电脑上画的」，群里却说「群里别人发的」——两个会话各说各的。
  // [PRAGMATICS] 把最后一条真人消息压成“这句话在干什么”+ 会话语境。
  // 只给线索与不确定性，不替她下情绪结论。
  function renderPragmaticContext(key) {
    try {
      const st = getSocialV2State(key);
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const last = [...recent].reverse().find((m) => m && !m.isSelf && String(m.text || '').trim());
      if (!last) return '';
      const age = Date.now() - (Number(last.time) || 0);
      if (age > 15 * 60 * 1000) return '';
      const text = String(last.text || '').trim();
      const stored = st.lastPragmaticFrame;
      const frame = stored && String(stored.text || '') === text
        ? stored
        : classifyPragmaticFrame(text, {
          key,
          recent: recent.slice(-5).map((m) => String(m.text || '')).filter(Boolean),
        });
      if (!stored || String(stored.text || '') !== text) {
        frame.emotion = applyEmotionCalibration(frame.emotion, st.emotionCalibration, key);
        st.discourse = updateDiscourseState(st.discourse || createDiscourseState(), frame, {
          text,
          speaker: String(last.userId ?? last.sender ?? ''),
          now: Date.now(),
        });
        try { saveSocialV2State(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9442'); }
      }
      const languageHits = findLanguageEpisodesByContext(
        readLanguageEpisodes(stateDataPath('language-episodes.jsonl'), { limit: 300 }),
        text,
        { limit: 2 },
      );
      // [AFFECT-UNIFY] prepareAffectHint 的 fused 结果优先；有它就压制语用启发式的情绪行。
      const affectLine = st.pendingFeel && Date.now() - Number(st.pendingFeel.at || 0) < 120000
        ? String(st.pendingFeel.text || '') : '';
      if (affectLine) st.pendingFeel = null;
      // [SELF-EMOTION] 对方情绪 ≠ 她的情绪；共情有边界，不自动镜像。
      let selfEmotionBlock = '';
      try {
        const mood = stateWithKey(loadMoodState(), key);
        const selfEmotion = appraiseSelfEmotion({
          frame,
          selfState: mood,
          relationship: st.relationship || {},
          outcomes: readOutcomes(stateDataPath('outcomes.jsonl'), { limit: 3 }),
        });
        const empathy = buildEmpathicStance({ frame, selfEmotion, relationship: st.relationship || {} });
        selfEmotionBlock = renderSelfEmotionBlock(selfEmotion, empathy);
        st.lastSelfEmotion = selfEmotion;
        // [EMOTION-VECTOR] 同一条消息只记一次底色/历史；否则每次唤醒都重复累加。
        if (st.lastEmotionVectorFrame !== text) {
          st.lastEmotionVectorFrame = text;
          // [STATE-HUB] 她自己的情绪底色也走单一写入者；缺失时回退旧路径。
          if (stateHub && typeof stateHub.observeSelfEmotion === 'function') {
            stateHub.observeSelfEmotion(key, selfEmotion);
          } else {
            const v = loadEmotionVector();
            observeSelfEmotion(v, key, selfEmotion);
            saveEmotionVector(v);
          }
          recordSelfEmotion({ key, selfEmotion, empathy, file: stateDataPath('self-emotion.jsonl') });
        }
        saveSocialV2State();
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9467'); }
      // [EMOTION-VECTOR] 持久底色：跨会话、跨回合，一句话看不出来但“最近一直这样”。
      let emotionVectorLine = '';
      try { emotionVectorLine = renderEmotionVector(stateHub && stateHub.state ? stateHub.state.affect : loadEmotionVector(), key); } catch { emotionVectorLine = ''; }
      return [
        affectLine,
        emotionVectorLine,
        renderPragmaticBlock(frame, { includeEmotion: !affectLine }),
        renderDiscourseBlock(st.discourse),
        selfEmotionBlock,
        renderLanguageEpisodeBlock(languageHits),
      ].filter(Boolean).join('\n');
    } catch { return ''; }
  }

  // [AGENCY] 她自己挂着的意图 + 最近结果；只有有内容才注入，避免空块。
  function renderAgencyBlock() {
    try {
      const intentions = loadIntentions(stateDataPath('intentions.json'));
      const outcomes = readOutcomes(stateDataPath('outcomes.jsonl'), { limit: 6 });
      return [renderIntentionsBlock(intentions, { limit: 3 }), renderOutcomesBlock(outcomes, { limit: 3 })]
        .filter(Boolean).join('\n\n');
    } catch { return ''; }
  }

  // [SELF-RECENT-CACHE] 记忆文件只在 mtime/size 变化时重读；每个唤醒都全量
  // readdir + JSONL parse 会随着记忆增长变成固定 IO 开销。
  const selfRecentCache = { dir: '', stamp: '', entries: [] };
  function renderSelfRecentBlock(key) {
    try {
      const dir = cfg.socialV2?.memoryInject?.dir || MEM_DIR;
      const files = fs.readdirSync(dir).filter((f) => /^memory.*\.jsonl$/.test(f));
      const stamp = files.map((f) => {
        try {
          const s = fs.statSync(path.join(dir, f));
          return `${f}:${s.mtimeMs}:${s.size}`;
        } catch { return `${f}:ERR`; }
      }).join('|');
      let entries = selfRecentCache.entries;
      if (selfRecentCache.dir !== dir || selfRecentCache.stamp !== stamp) {
        entries = [];
        for (const f of files) {
          try {
            for (const e of loadEntries(path.join(dir, f))) {
              if (e && e.kind === UTTERANCE_KIND) entries.push(e);
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-context-service.mjs:9509'); }
        }
        entries.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
        selfRecentCache.dir = dir;
        selfRecentCache.stamp = stamp;
        selfRecentCache.entries = entries;
      }
      // [SELF-RECENT-PRIVACY] 与记忆召回共用 sharePrivate/shareGroup：
      // 群会话默认不把私聊里的话递进来；私聊默认可以想起群里的自己。
      return renderSelfRecent(entries, {
        key,
        allowPrivate: cfg.socialV2?.memoryInject?.sharePrivate === true,
        allowGroup: cfg.socialV2?.memoryInject?.shareGroup !== false,
      });
    } catch { return ''; }
  }

  function renderQuoteContext(key) {
    try {
      const st = getSocialV2State(key);
      const dir = cfg.socialV2?.memoryInject?.dir || MEM_DIR;
      let utt = [];
      try {
        utt = loadEntries(filesForScope(dir, canonScope(key)).file)
          .filter((e) => e && e.kind === UTTERANCE_KIND)
          .slice(-300);
      } catch { utt = []; }
      return buildQuoteContext(st?.recentMessages ?? [], { utterances: utt });
    } catch { return ''; }
  }


  return {
    readMemoryRows, maybeExtractFacts, renderCoreFacts, renderSelfProfile,
    loadSelfNarrative, saveSelfNarrative, renderSelfNarrative, renderPragmaticContext,
    renderAgencyBlock, renderSelfRecentBlock, renderQuoteContext,
  };
}
