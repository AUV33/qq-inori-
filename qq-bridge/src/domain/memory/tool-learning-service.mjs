// 工具/学习闭环：反馈读写、工具日志读取、回合结束自动记技能成败。
//
// 从 app.mjs 的 main() 搬出（P3-RW-31，2026-11-01）。turnToolStats 仍由 app 持有，
// 本模块只消费并删除当前回合统计；技能库读写经 applyOutcome/saveSkills 注入。
/**
 * @param {object} ctx
 */
export function createToolLearning(ctx) {
  const {
    fs, cfg, log, readJsonSafe, atomicWriteJson, FEEDBACK_FILE, TOOL_LOG_FILE,
    redactSensitiveText, turnToolStats, getSocialV2State, takeTaskSkillIds,
    recordSkillAttempt, loadSkills, checkVerify, applyOutcome, saveSkills, saveSocialV2State,
  } = ctx;
  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'tool-learning-service.mjs:10464'); }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  // [AUTO-TRACE] 工具失败自动留痕（不依赖她自觉调 trace_log）：
// 失败点是「换法学习」的唯一数据来源；同工具+同错误 30 分钟内只记一次，防刷屏。
const autoTraceSeen = new Map(); // `${key}|${tool}|${err}` -> ts
  // [TOOL-LEARN] 工具与学习自动闭环（不依赖她自觉）：
  //   ① 成功的回合也留 trace（以前只记失败，反思看不到"怎么成的"）；
  //   ② 这回合注入过的技能，按工具成败自动记一笔 success/fail（她从不手动 skill_record）。
  async function applyTurnToolLearning(key, sessionId, ended) {
    const s = turnToolStats.get(sessionId);
    turnToolStats.delete(sessionId);
    if (!s) return;
    const st = getSocialV2State(key);
    // [DEAD-CODE] 2026-11-03 删掉 `names`/`workNames`：算完没人用（"[TRACE-TRUTH] 回合完成不等于
    // 事情做成"之后，靠工具名判断"这轮算不算干活"的逻辑已撤掉）。
    const completed = ended?.reason?.kind === 'completed';
    // [TRACE-TRUTH] 回合完成不等于事情做成：不再自动写 success trace。
    // 真正走通且有 verify 的轨迹由任务/练习层显式写入；这里只保留工具统计。
    const taskIds = takeTaskSkillIds(sessionId);
    const ids = taskIds.length ? taskIds : (Array.isArray(st.$skillIds) ? st.$skillIds : []);
    // [LEARN-LOOP] 技能回合结果单独记账：完成 ≠ 技能成功，这里只记“这轮跑没跑完”
    try { recordSkillAttempt(ids, completed ? 'completed' : String(ended?.reason?.kind || 'unknown'), key); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'tool-learning-service.mjs:10493'); }
    if (ids.length) {
      try {
        const store = loadSkills(cfg.socialV2?.skills?.file);
        let changed = 0;
        for (const id of ids) {
          const skill = (store.items || []).find((x) => x.id === id);
          if (!skill) continue;
          let outcome = null;
          let hint = '';
          let verifiedBy = '';
          let evidence = '';
          const toolFailed = s.fail > 0 && s.ok === 0;
          if (toolFailed) { outcome = false; hint = String(s.lastError || '工具报错，看看是哪一步没反应，换法试试').slice(0, 160); }
          // [SKILL-TRUTH] 回合完成不算成功；只有 文件:/网址: 判据通过才算 verify。
          // 命令判据仍只由显式 skill_verify 执行。没有判据的自动回合只记 attempt。
          if (completed && skill.verify && /^(文件|路径|file|网址|链接|url)\s*[:：]/i.test(String(skill.verify))) {
            try {
              const v = await checkVerify(skill.verify, { allowCommand: false, timeoutMs: 5000 });
              if (v && v.ok !== null) {
                outcome = !!v.ok;
                if (v.ok) { verifiedBy = 'verify'; evidence = String(v.evidence || '').slice(0, 300); }
                else hint = String(v.evidence || '').slice(0, 160);
              }
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'tool-learning-service.mjs:10517'); }
          }
          if (outcome === null) {
            // [ATTEMPT] 注入过、但这回合没法定成败：只记一次尝试（ok=null 只加 attempts，不改成败）。
            if (completed && (Number(s.ok) || 0) + (Number(s.fail) || 0) > 0) {
              const ra = applyOutcome(store, id, { ok: null, source: 'turn' });
              if (ra) changed += 1;
            }
            continue;
          }
          const r = applyOutcome(store, id, { ok: outcome, hint, source: 'turn', verifiedBy, evidence });
          if (r) changed += 1;
        }
        if (changed) {
          saveSkills(store, cfg.socialV2?.skills?.file);
          log(`[skills] ${key} 自动记了 ${changed} 条（工具 ${s.ok} 成 / ${s.fail} 败${completed ? '，回合完成' : '，回合未完成'}）`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'tool-learning-service.mjs:10534'); }
    }
    st.$skillIds = [];
    try { saveSocialV2State(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'tool-learning-service.mjs:10537'); }
  }

  return { readFeedbackEntries, appendFeedbackEntry, readToolLog, applyTurnToolLearning };
}
