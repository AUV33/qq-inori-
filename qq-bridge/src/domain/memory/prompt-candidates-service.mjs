// 提示词候选行：知识候选（查词/工具日志）与技能候选（重复成功轨迹）。
//
// 从 app.mjs 的 main() 搬出（P3-RW-43，2026-11-01）。只拼一行提示，不写 skills.json。
/**
 * @param {object} ctx
 */
export function createPromptCandidates(ctx) {
  const {
    cfg, log, TOOL_LOG_FILE, readJsonlSafe, collectLookups, cognition, pickCandidates,
    renderCandidates, getSocialV2State, saveSocialV2State, loadSkills,
    detectSkillCandidates, recentTraces, renderSkillCandidates,
  } = ctx;
  function renderKnowledgeCandidates() {
    try {
      const lookups = collectLookups(readJsonlSafe(TOOL_LOG_FILE));
      if (!lookups.length) return '';
      const items = cognition.load();
      return renderCandidates(pickCandidates(lookups, items));
    } catch { return ''; }
  }

  // ── [SELF-KNOWLEDGE] 自主时间也要看得见自己 ──────────────────────────────
  // [SKILL-CANDIDATE] 从最近成功轨迹里找“同类事情做过多次”的候选；只递一句，
  // 不写 skills.json、不建 draft、不派任务。只在私聊出现，24h 内不重复提醒。
  function renderSkillCandidateLine(key) {
    try {
      if (!String(key).startsWith('private:')) return '';
      const st = getSocialV2State(key);
      const now = Date.now();
      if (Number(st.lastSkillCandidateAt) && now - Number(st.lastSkillCandidateAt) < 24 * 3600 * 1000) return '';
      const store = loadSkills(cfg.socialV2?.skills?.file);
      const list = detectSkillCandidates(recentTraces(160), { existingSkills: store.items, now });
      if (!list.length) return '';
      st.lastSkillCandidateAt = now;
      saveSocialV2State();
      log(`[skill-candidate] ${key} ${list.map((c) => c.goal).join('、').slice(0, 80)}`);
      return renderSkillCandidates(list);
    } catch { return ''; }
  }


  return { renderKnowledgeCandidates, renderSkillCandidateLine };
}
