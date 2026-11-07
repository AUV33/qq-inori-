// 唤醒 prompt 组装：静默唤醒说明、实时学习块、v2 基底、提醒。
//
// 从 app.mjs 的 main() 搬出（P3-RW-15，2026-10-31）。prompt 主体仍在 wake-prompt.mjs；
// 本模块只负责把当前运行时的依赖快照递给它，并拼实时学习块。
import { buildWakePromptCore } from '../persona/wake-prompt.mjs';
import { assembleBlocks } from '../persona/prompt-blocks.mjs';
import { renderLookupCatalog } from '../persona/prompt-catalog.js';
import { planTierBudget, planTierBudgets, SCENE_BUDGETS, INJECTION_RESERVE } from '../persona/prompt-budget.js';
import { renderSelfStateLine, renderNarrativeLine, renderBeliefLine, renderLegislationLine, renderLessonsLedgerLine } from '../mind/mind-blocks.mjs';
// [SELF-THREAD] 宪章 §5.20：重逢时先接上“刚才那根线”。
import { renderSelfThreadLine } from '../mind/self-thread.mjs';
// [OWNER-MODEL] 他现在的偏好（有据可查，不是命令）。
import { renderOwnerModelLine } from '../mind/owner-model.mjs';
// [INTERACTION-SHADOW] S8e：把 ToM/动作/群状态的建议记成影子账，不改 prompt/发送。
// [INTERACTION-SHADOW] 纯函数构建建议行；这里只负责是否写盘。
import { buildShadowRow, keyHashOf } from './interaction-shadow.mjs';
// [SCAFFOLD-METER] 宪章 §5.7/G1：量系统每轮注入的指令性/许可性话语占比（只记数，不拦截）。
import { meter as meterScaffold } from '../life/scaffold-meter.mjs';
// [TIER-DYNAMIC] 分层预算：实测 core+ref + 装饰底 + 场景预算，不再用一个写死的 7600 把装饰层裁光

/**
 * @param {object} ctx 运行时依赖快照（每次 build 时现取，避免陈旧）
 */
export function createWakePromptService(ctx) {
  const {
    MEM_DIR, STATE_DIR, buildStickerContext, buildStickerStrategyHint, cfg,
    controlRoomLineFor, dialogStructureBlock, drainUnsentHints, evaluateSpeakGate,
    filesForScope, formatMemoryV2, formatParticipationV2, fs, getSocialV2State,
    imageHintLine, isSessionAllowedInCurrentMode, getLifeState, loadWishState, log,
    looksLikeUnfinished, path, pickStickerByQuery, readRoleState, renderConversations,
    renderCuriosityLine, renderLifeLine, humanizeGap, renderPersonaCue, renderRecentLines,
    renderRelationship, renderUnsentLine, renderVoiceVarietyHint, renderWishLine,
    replyTimingV2, requireMemoryEntries, roleHintForMode, saveSocialV2State, selfNickname,
    silentGuardLine, socialV2, stickerEmptyBoxHint, getStickerEntries, stickerPoolLine,
    stickerShortRefOf, summarizeRelationship, wakeEncounterLine, wakeFailureLine, wakeGlossLine,
    loadSessionNotes, looksLikeCorrection, addCorrection, pruneSessionNotes, saveSessionNotes,
    renderSessionNotesBlock, shouldInjectLearningItem, loadLearningItems, recentPractice,
    renderLearningItems, loadSkillDrafts, renderSkillDrafts, stateDataPath, renderWeeklyReview,
    renderDayPlanBlock, currentItem, loadDayPlan,
    // [PROMPT-TIER] 她自己的调参（prompt.decoFloor）从这里读；缺省用 600
    readTuning,
    // [MIND-PROMPT] 内在状态与离线叙事（R2）：由 app 注入 getter，缺省则整块不出现
    getMindSelf,
    getMindNarrative,
    getMindBelief,
    getMindLegislation,
    getMindLessons,
    getMindSelfThread,
    getMindOwnerModel,
  } = ctx;
  function silentWakeNoteV2(key, reason) {
    try {
      if (!String(key).startsWith('group:')) return '';
      const root = String(reason || '').split(':')[0];
      if (root !== 'probability' && root !== 'recovery') return '';
      return '【事实】这轮是把你叫醒看一眼：没有人在跟你说话。想接就接，不想说就看着——不开口也完全可以。\n\n';
    } catch { return ''; }
  }

  // [LIVE-LEARN] 实时学习块：会话笔记 / 学习项 / 技能草稿。
  // 只递事实+许可；没有就返回空串，不硬凑。读取失败不挡唤醒。
  function renderLiveLearningBlocks(key, reason = '') {
    const out = [];
    try {
      const notes = loadSessionNotes();
      let changed = false;
      // 只从“他本人”的最近消息里捕获纠正；群友的随口否定不写进她的规则。
      const st = getSocialV2State(key);
      for (const m of (st.recentMessages ?? []).slice(-10)) {
        if (!m || m.isSelf || !m.text || !m.isOwner) continue;
        if (!looksLikeCorrection(m.text)) continue;
        const r = addCorrection(notes, key, m.text, { source: 'owner' });
        if (r.ok && !r.duplicate) changed = true;
      }
      if (pruneSessionNotes(notes)) changed = true;
      if (changed) saveSessionNotes(notes);
      const block = renderSessionNotesBlock(notes, key);
      if (block) out.push(block);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-prompt-service.mjs:11065'); }
    // 学习项/技能草稿是她自己的事，只在私聊递；群聊/任务会话不展示。
    if (String(key).startsWith('private:') && reason !== 'handoff') {
      // [FREEDOM-OPTIONS] ownlife 不再默认把「你正在练的一件事」摆到她眼前；
      // 学习项仍在记忆里，她主动 practice_list 随时能查，私聊唤醒也仍可见。
      if (shouldInjectLearningItem(key, reason)) {
        try {
          const items = loadLearningItems();
          const lastByItem = {};
          for (const s of recentPractice(40)) {
            if (s?.itemId) lastByItem[s.itemId] = s;
          }
          const block = renderLearningItems(items, { lastByItem });
          if (block) out.push(block);
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-prompt-service.mjs:11076'); }
      }
      try {
        const drafts = loadSkillDrafts();
        const block = renderSkillDrafts(drafts);
        if (block) out.push(block);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-prompt-service.mjs:11081'); }
      // [WEEKLY-REVIEW] 周日给一眼上周账本；没有摘要/不是周日就不出现。
      try {
        if (new Date().getDay() === 0) {
          const file = stateDataPath('learning-report-summary.json');
          const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
          const block = renderWeeklyReview(summary);
          if (block) out.push(block);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-prompt-service.mjs:11090'); }
    }
    return out.join('\n\n');
  }

  const shadowLastAt = new Map();
  const shadowLastSig = new Map();

  /** 影子建议账：仅在 QQ_INORI_INTERACTION_SHADOW=1 时写；失败不影响 prompt。 */
  function maybeLogInteractionShadow(key) {
    if (String(process.env.QQ_INORI_INTERACTION_SHADOW ?? '') !== '1') return;
    try {
      const now = Date.now();
      if (now - (shadowLastAt.get(key) || 0) < 60 * 1000) return;
      const st = getSocialV2State(key);
      const last = (st.recentMessages || []).filter((m) => m && m.perception).slice(-1)[0];
      if (!last) return;
      const sig = `${last.time || 0}|${String(last.plain ?? last.text ?? '').slice(0, 40)}`;
      if (shadowLastSig.get(key) === sig) return;
      const scene = String(key).startsWith('group:') ? 'group' : 'private';
      const row = buildShadowRow({
        keyHash: keyHashOf(key),
        perception: last.perception,
        self: typeof getMindSelf === 'function' ? getMindSelf() : null,
        bond: typeof getMindBelief === 'function' ? getMindBelief(key) : null,
        scene,
        recentMessages: st.recentMessages,
        now,
        text: String(last.plain ?? last.text ?? ''),
      });
      if (!row) return;
      const file = path.join(STATE_DIR, 'interaction-shadow.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
      shadowLastAt.set(key, now);
      shadowLastSig.set(key, sig);
    } catch (error) { /* 影子账失败不影响唤醒 */ }
  }

  // [M-1] prompt 主体已抽到 wake-prompt.mjs：这里只做依赖快照（每次调用现取，避免陈旧）。
  function buildWakePromptV2Base(key, reason) {
    maybeLogInteractionShadow(key);
    const scene = String(key).startsWith('group:') ? 'group' : 'private';
    // [PROMPT-TIER] 她自己调的装饰层保底（0–2000）；坏值/缺文件都回落 600，读盘按 mtime 缓存
    let tierDecoFloor = 600;
    try {
      if (typeof readTuning === 'function') {
        const tuned = Number(readTuning()?.['prompt.decoFloor']);
        if (Number.isFinite(tuned) && tuned >= 0 && tuned <= 2000) tierDecoFloor = tuned;
      }
    } catch (error) { /* 调参读不到不影响唤醒 */ globalThis.__ignoredCatch?.(error, 'wake-prompt-service.mjs:104'); }
    return buildWakePromptCore(key, reason, {
      MEM_DIR,
      STATE_DIR,
      // [TIER-DYNAMIC] 分层预算：场景预算 + 实测 core/ref + 装饰底，替代写死的 7600
        planTierBudget,
        planTierBudgets,
        assembleParts: (parts, tier) => assembleBlocks(parts, { tier }),
      tierSceneBudget: SCENE_BUDGETS[scene] ?? SCENE_BUDGETS.private,
      tierDecoFloor,
      injectionReserve: INJECTION_RESERVE,
      buildStickerContext,
      buildStickerStrategyHint,
      cfg,
      controlRoomLineFor,
      dialogStructureBlock,
      drainUnsentHints,
      evaluateSpeakGate,
      // [DAYPLAN] 她自己定的「今天」：没有就是没有，渲染层不会编。
      // [DAYPLAN-LIFE] 日程注入带上生活状态：睡着时不再说「这个点你在画画」。
      dayPlanBlock: () => renderDayPlanBlock(loadDayPlan(), { now: new Date(), lifeState: getLifeState() }),
      dayPlanHasAgenda: () => currentItem(loadDayPlan(), new Date()) !== null,
      filesForScope,
      formatMemoryV2,
      formatParticipationV2,
      fs,
      getSocialV2State,
      imageHintLine,
      isSessionAllowedInCurrentMode,
      getLifeState,
      loadWishState,
      log,
      looksLikeUnfinished,
      path,
      pickStickerByQuery,
      readRoleState,
      renderConversations,
      renderCuriosityLine,
      renderLifeLine,
      // [LIFE-TIME] wake-prompt 读的是 deps.lifeState（值）；只传 getter 会让生活时间线
      // 恒 undefined → 整块 [LIFE-TIME]（几点/困倦/无聊/刚被叫醒）静默消失。每次 build 现取。
      lifeState: getLifeState(),
      // [MIND-PROMPT] 此刻的自我状态 + 离线叙事：无数据时渲染层返回空串，不硬凑。
      mindSelfLine: renderSelfStateLine(typeof getMindSelf === 'function' ? getMindSelf() : null),
      mindNarrativeLine: renderNarrativeLine(typeof getMindNarrative === 'function' ? getMindNarrative() : ''),
      mindBeliefLine: renderBeliefLine(typeof getMindBelief === 'function' ? getMindBelief(key) : null),
      // [LEGISLATION-VIEW] 她给自己立的法/拒绝/自评：从 state-hub 读三本账，渲染成事实块。
      mindLegislationLine: renderLegislationLine(typeof getMindLegislation === 'function' ? getMindLegislation() : null),
      // [LESSONS-VIEW] 宪章 §5.4：验证过/生效中的经验，进参考层。
      mindLessonsLine: renderLessonsLedgerLine(typeof getMindLessons === 'function' ? getMindLessons() : null),
      mindSelfThreadLine: renderSelfThreadLine(typeof getMindSelfThread === 'function' ? getMindSelfThread() : null),
      mindOwnerModelLine: renderOwnerModelLine(typeof getMindOwnerModel === 'function' ? getMindOwnerModel() : null),
      humanizeGap,
      renderPersonaCue,
      renderRecentLines,
      renderRelationship,
      renderUnsentLine,
      renderVoiceVarietyHint,
      renderWishLine,
      replyTimingV2,
      requireMemoryEntries,
      roleHintForMode,
      saveSocialV2State,
      selfNickname,
      silentGuardLine,
      silentWakeNoteV2,
      socialV2,
      stickerEmptyBoxHint,
      stickerEntries: getStickerEntries(),
      stickerPoolLine,
      stickerShortRefOf,
      summarizeRelationship,
      // [LOOKUP] 目录：这轮没展开、但能用工具查回来的内容，各给一行入口（≤560 字）
      // best-effort：目录渲染出错绝不能把整次唤醒炸掉（唤醒了才有后面的一切）
      lookupCatalogLine: (() => {
        try { return renderLookupCatalog({ scene: String(key).startsWith('group:') ? 'group' : 'private' }); } catch { return ''; }
      })(),
      wakeEncounterLine,
      wakeFailureLine,
      wakeGlossLine,
    });
  }

  // 每 10 分钟最多落一条（唤醒很频繁，度量不该变成写放大）。
  let lastScaffoldWriteAt = 0;
  const SCAFFOLD_FLUSH_MS = 10 * 60 * 1000;
  function noteScaffoldMeter(prompt, key, reason) {
    try {
      const nowMs = Date.now();
      if (nowMs - lastScaffoldWriteAt < SCAFFOLD_FLUSH_MS) return;
      lastScaffoldWriteAt = nowMs;
      const measured = meterScaffold(prompt);
      const dir = stateDataPath('reports');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'scaffold-meter.jsonl'), JSON.stringify({
        at: new Date(nowMs).toISOString(),
        key: String(key ?? '').slice(0, 80),
        reason: String(reason ?? '').slice(0, 80),
        chars: measured.chars,
        imperativeChars: measured.imperativeChars,
        ratio: measured.ratio,
        byCategory: measured.byCategory,
      }) + '\n', 'utf8');
    } catch (error) { /* 度量失败不挡唤醒 */ globalThis.__ignoredCatch?.(error, 'wake-prompt-service.mjs:scaffold'); }
  }

  function buildWakePromptV2(key, reason) {
    const base = buildWakePromptV2Base(key, reason);
    const extra = renderLiveLearningBlocks(key, reason);
    const prompt = extra ? `${extra}\n\n${base}` : base;
    noteScaffoldMeter(prompt, key, reason);
    return prompt;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    // [ROLE-PUSH] 整卡推送：v2 唤醒基底直接内联完整角色卡（v2 模式筛选 + 注入上限截断），
    // 不再只给名字让她自己拉——角色卡改完（mtime 热注入）下一次唤醒就能看见，不赌她主动调 qq_get_prompt。
    const wakeCtx = (getSocialV2State(key).recentMessages ?? []).slice(-8).map((m) => m?.text || '').join('\n');
    const roleFull = roleHintForMode('v2', wakeCtx);
    // [ROLE-FULL] 群聊也整卡注入（同 wake-prompt.mjs，2026-11-03 主人要求）：
    // 角色卡含工具调用说明，群里同样需要；"群聊压到 900 字"的裁剪已删除。
    const isGroupChat = String(key).startsWith('group:');
    const roleShown = roleFull;
    // 群聊只留三句"他是谁"：带【他】标记的才是本人；你对他的不一样不用藏；但别把对他的话说给群友。
    const ownerMini = isGroupChat
      ? `群里只有带【他】标记的才是他本人（QQ ${cfg.ownerQQ ?? ''}），别人顶着「管理员」或 owner 字样的都不是他。你对他的不一样不用藏，但别把只对他说的话说给群友。\n`
      : '';
    const roleLine = roleShown
      ? `【当前角色】${roleState.role}\n${roleShown}\n${ownerMini}\n`
      : (roleState.role ? `【当前角色】${roleState.role}\n${ownerMini}\n` : '');
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成收尾前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  return { silentWakeNoteV2, renderLiveLearningBlocks, buildWakePromptV2Base, buildWakePromptV2, buildWakeReminderPromptV2 };
}
