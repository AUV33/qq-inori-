// 黑话抽取/研究执行：等学习者回合、抽候选、入库、自动晋升、研究回报。
//
import { SLANG_STATUS } from './slang-learner.js';
// 从 app.mjs 的 main() 搬出（P3-RW-52，2026-11-01）。会话/提示词/解析全部注入；
// 模块只负责「跑一轮抽取并落库」。
/**
 * @param {object} ctx
 */
export function createSlangLearnerRuntime(ctx) {
  const {
    cfg, log, getSlangEntries, setSlangEntries, ensureSlangLearnerSession, invalidateSlangLearnerSession,
    // [WIRING-FIX] 等待者表/窗口/研究锁/就绪态都是 main() 的局部状态，裸引用 → 抽取回合每次都炸
    learnerWaiters, slangWindows, slangResearchingIds, getDshReady,
    queueSlangTask, saveSlangStore, buildExtractionPrompt, parseExtractionJson,
    upsertSlangEntry, autoPromoteSlang, buildResearchPrompt, parseResearchJson,
    submitPromptWithTurnSlot,
  } = ctx;
  function waitLearnerTurn(sessionId, timeoutMs) {
    let ms = timeoutMs;
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
      const cfgMs = Number(cfg.slang?.learnerWaitMs);
      ms = Number.isFinite(cfgMs) && cfgMs > 0 ? cfgMs : 300000;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${ms}ms)`));
      }, ms);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key, { retried = false } = {}) {
    if (cfg.slang?.enabled === false) return;
    if (!getDshReady()) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await submitPromptWithTurnSlot({
        sessionId,
        label: 'isolated:slang',
        kind: 'background',
        content: [{ type: 'text', text: promptText }],
      });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(getSlangEntries(), item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      // [SLANG-AUTO] 自动升格：research 确认过（meaning 非空）且群友还在用（count≥N）的候选，
      // 机器直接升 confirmed 进黑话表，不必等她逐个判；她之后仍可 reject 任何词（终态）。
      // config: slang.autoPromote = { enabled: true(默认), minCount: 4(默认) }。
      {
        const ap = cfg.slang?.autoPromote ?? {};
        if (ap.enabled !== false) {
          const apRes = autoPromoteSlang(getSlangEntries(), Number(ap.minCount ?? 4));
          if (apRes.promoted.length) {
            setSlangEntries(apRes.entries);
            saveSlangStore();
            log(`黑话自动升格 ${apRes.promoted.length} 条进黑话表：${apRes.promoted.slice(0, 8).join('、')}${apRes.promoted.length > 8 ? ' 等' : ''}`);
          }
        }
      }
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      const msg = String(error?.message ?? error);
      // [SLANG-WAITFIX] 超时不失效学习会话（文案含「会话」会误伤）；仅 404/not found/「未正常完成」失效。
      if (!/超时/.test(msg) && /会话|session|not found|404/i.test(msg)) {
        invalidateSlangLearnerSession();
      }
      // [LEARNER-RETRY] 学习会话偶发 turn error（DSH 侧，常见于会话状态陈旧）：
      // 重建学习会话后重试一次，避免一次坏 turn 就丢掉整批黑话。
      if (!retried && /未正常完成/.test(msg)) {
        log(`黑话提取失败 (${key})，重建学习会话重试一次: ${msg.slice(0, 300)}`);
        try { invalidateSlangLearnerSession(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'slang-learner-runtime.mjs:3659'); }
        return runSlangExtraction(key, { retried: true });
      }
      log(`黑话提取失败 (${key}): ${msg.slice(0, 500)}`);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!getDshReady()) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await submitPromptWithTurnSlot({
        sessionId,
        label: 'isolated:slang',
        kind: 'background',
        content: [{ type: 'text', text: promptText }],
      });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = getSlangEntries().find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
      // [SLANG-AUTO] 研究填完含义后，凡是被研究的候选（群友观测到即 count>=1）自动升格进黑话表，
      // 不再等待下一轮抽取——否则低活跃群抽取长期不触发，研究出的词永远卡在候选、不注入 AI 上下文。
      if (cfg.slang?.autoPromote?.enabled !== false) {
        let promoted = 0;
        for (const e of targets) {
          const live = getSlangEntries().find((x) => x.id === e.id);
          if (live && live.status === SLANG_STATUS.CANDIDATE && String(live.meaning ?? '').trim()) {
            live.status = SLANG_STATUS.CONFIRMED;
            live.autoConfirmedAt = new Date().toISOString();
            live.updatedAt = new Date().toISOString();
            promoted += 1;
          }
        }
        if (promoted) {
          saveSlangStore();
          log(`黑话研究后自动升格 ${promoted} 条进黑话表`);
        }
      }
    } catch (error) {
      const rmsg = String(error?.message ?? error);
      // [SLANG-WAITFIX] 同提取侧：超时不失效会话。
      if (!/超时/.test(rmsg) && /会话|session|not found|404/i.test(rmsg)) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  // 黑话上下文（入窗/允许提交/公开条目/已确认列表/提示注入）已搬到 slang-context-service.mjs（P3-RW-45）。

  return { waitLearnerTurn, runSlangExtraction, runSlangResearch };
}
