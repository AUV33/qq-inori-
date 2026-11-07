// 自我认知块：她自己的时间/唤醒里看到的「我是谁、最近怎么样、手头有什么事」。
//
// 从 app.mjs 的 main() 搬出（P3-RW-16，2026-10-31）。只读状态、拼文本，不发送、不写业务状态
// （cognition.markUsed 的 usedCount 回填除外，和原来一致）。
import os from 'node:os';

/**
 * @param {object} ctx
 */
export function createSelfKnowledge(ctx) {
  const {
    getSocialV2State, cfg, computeStyleStats, chaseState, getChaseAdaptMax, readJsonlSafe,
    path, stateDataPath, buildSelfModel, loadLessons, renderSelfNarrative, selfAnchorLine = () => '', renderSelfProfile,
    renderSelfModel, summarizeSelfTrend, renderSelfTrend, cognition, loadGoals, renderGoals,
    renderGoalOpenInvitation, activityTracker, renderTraceHint, renderThoughts,
    renderLessonCandidates, renderBehaviorLedger, summarizeLearningWrites, renderLearningWritesLine,
    renderSelfRecentBlock, renderLiveLearningBlocks, renderLedger, renderWorksLine, worksStore,
    renderSkillCandidateLine,
  } = ctx;
  function buildSelfModelForPrompt(key = '') {
    const stm = key ? getSocialV2State(key) : null;
    const rs = Array.isArray(stm?.recentMessages) ? stm.recentMessages : [];
    const others = rs.filter((m) => m && !m.isSelf && m.text).slice(-12).map((m) => m.plain || m.text);
    const myOwn = rs.filter((m) => m && m.isSelf && m.text).slice(-20).map((m) => m.plain || m.text);
    const styleEntry = {
      mine: computeStyleStats(myOwn, cfg.socialV2?.style ?? {}),
      scene: computeStyleStats(others, cfg.socialV2?.style ?? {}),
    };
    const day = new Date().toLocaleDateString('sv-SE');
    let tracesToday = [];
    try { tracesToday = readJsonlSafe(path.join(stateDataPath('traces'), `${day}.jsonl`)); } catch { tracesToday = []; }
    return buildSelfModel({
      styleEntry,
      chase: chaseState(stm ?? {}),
      adapt: { maxPerDay: getChaseAdaptMax() || 3 },
      traces: tracesToday,
      lessons: loadLessons(cfg.socialV2?.lessons?.file),
    });
  }

  // 不含令牌、不含别人的消息。
  function selfKnowledgeBlock({ withTraces = false, key = '' } = {}) {
    const parts = [];
    try { const n = renderSelfNarrative(); if (n) parts.push(n); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9596'); }
    try {
      // 她跑在哪：环境事实由代码给，不写死在角色卡里
      parts.push(`【你跑在哪】你是跑在 ${os.hostname()} 上的 AI 程序，不是真人；你的记忆、经验、日记都存在这台机器的文件里，重启不会丢。`);
      // [SELF-ANCHOR] 身份事实（personId/名字来源/角色卡 hash）；没有账本就整块不出现。
      const anchor = typeof selfAnchorLine === 'function' ? selfAnchorLine() : '';
      if (anchor) parts.push(anchor);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:anchor'); }
    try {
      const lessonsFile = cfg.socialV2?.lessons?.file;
      const model = buildSelfModelForPrompt(key);
      // 三块各自兜错：画像渲染失败不该把自我模型/趋势一起吞掉（她少看一段自己）
      try { const profile = renderSelfProfile(model); if (profile) parts.push(profile); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9602'); }
      try { const recent = renderSelfModel(model); if (recent) parts.push(recent); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9603'); }
      try {
        const trend = summarizeSelfTrend({
          styleRows: readJsonlSafe(stateDataPath('style-profile.jsonl')),
          actionRows: readJsonlSafe(stateDataPath('action-log.jsonl')),
          lessonsRows: readJsonlSafe(lessonsFile || stateDataPath('lessons.jsonl')),
        });
        const trendLine = renderSelfTrend(trend);
        if (trendLine) parts.push(trendLine);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9616'); }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9617'); }
    // [COGNITION-OWN] 她自己的时间也要看得见自己想明白的事：以前认知只在聊天唤醒注入
    //（wake-sender 的 [COGNITION]），自主时间看不到 —— 于是「记了也用不上」，
    // 从查到记的闭环缺最后一环。这里只递事实，不催她照着做。
    let cogItems = [];
    try { cogItems = cognition.load(); } catch { cogItems = []; }
    try {
      const cog = cognition.render(cogItems, '');
      if (cog?.text) {
        parts.push(String(cog.text).trim());
        // [COG-V2] 和 wake-sender 一样回填 usedCount；自己时间注入过也算一次。
        if (Array.isArray(cog.ids) && cog.ids.length && typeof cognition.markUsed === 'function') {
          try { cognition.transact((items) => ({ ok: true, items: cognition.markUsed(items, cog.ids) })); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9629'); }
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9632'); }
    // [KNOWLEDGE-CANDIDATES] 候选不在这里出：自主时间没有会话令牌，摆出来她也写不了。
    // 候选改在私聊唤醒时注入（renderKnowledgeCandidates → wake-sender 的私聊分支）。
    try {
      const goals = loadGoals(cfg.socialV2?.goals?.file);
      const block = renderGoals(goals);
      if (block) parts.push(`【你手头的事（你自己定的目标）】\n${block}`);
      else {
        const invite = renderGoalOpenInvitation(goals);
        if (invite) parts.push(invite);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9638'); }
    if (withTraces) {
      try {
        const recentTraces = [];
        for (const app of activityTracker.recentApps?.(3) ?? []) recentTraces.push(...activityTracker.lookup(app, 1));
        const hint = renderTraceHint(recentTraces.slice(0, 2));
        if (hint) parts.push(hint);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9645'); }
    }
    // [THOUGHTS] 她上次是怎么想的（含新加的 reasoning 摘要）
    try { const th = renderThoughts(3); if (th) parts.push(th); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9648'); }
    // [LESSON-CANDIDATE] 她自己想到、还没定成经验的那几句
    try { const lc = renderLessonCandidates(2); if (lc) parts.push(lc); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9650'); }
    // [SELF-CONTEXT-PARITY] 下面这些原来只在聊天唤醒里注入；自己时间看不到同一个自己。
    if (key) {
      try {
        const nowB = new Date();
        const dayKey = nowB.toLocaleDateString('sv-SE');
        const ledger = renderBehaviorLedger({ day: dayKey, now: nowB });
        const body = String(ledger).replace(/^【[^】]*】\s*/, '').replace(/^\d{4}-\d{2}-\d{2}[：:]\s*/, '').trim();
        if (body) parts.push(`我最近做过的（截至 ${nowB.toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}）：${body.slice(0, 240)}`);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9659'); }
      try {
        const lw = summarizeLearningWrites(readJsonlSafe(stateDataPath('learning-trend.jsonl')), { days: Number(cfg.socialV2?.selfModel?.learningDays) || 7 });
        const line = renderLearningWritesLine(lw);
        if (line) parts.push(line);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9664'); }
      try { const sr = renderSelfRecentBlock(key); if (sr) parts.push(sr); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9665'); }
      try { const live = renderLiveLearningBlocks(key, 'ownlife'); if (live) parts.push(live); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9666'); }
      if (String(key).startsWith('private:')) {
        try { const lg = renderLedger(); if (lg) parts.push(lg); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9668'); }
        try { const wl = renderWorksLine(worksStore); if (wl) parts.push(wl); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9669'); }
        try { const sc = renderSkillCandidateLine(key); if (sc) parts.push(sc); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-knowledge.mjs:9670'); }
      }
    }
    return parts.join('\n\n');
  }

  return { buildSelfModelForPrompt, selfKnowledgeBlock };
}
