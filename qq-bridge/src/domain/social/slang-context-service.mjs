// 黑话上下文：入窗/允许提交/公开条目/已确认列表/提示注入。
//
import { SLANG_STATUS } from './slang-learner.js';

// 从 app.mjs 的 main() 搬出（P3-RW-45，2026-11-01）。学习者会话与抽取执行仍在 app；
// 本模块只消费 slang 窗口/库，拼提示词。
/**
 * @param {object} ctx
 */
export function createSlangContext(ctx) {
  const {
    cfg, getSlangEntries, slangWindows, log, truncateText, renderTimeLine, queueSlangTask,
    // [WIRING-FIX] 这几个是 main() 里的状态容器/就绪态，原来裸引用 → 黑话提取排队每次都炸
    getDshReady, slangPolicyState, slangExtractionCooldowns, slangSubmitTimes,
    decideSlangExtraction, hasUrgentSignal, runSlangExtraction, buildSlangContext,
  } = ctx;
  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!getDshReady()) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    const now = Date.now();
    // [SLANG-POLICY] 窗口里有「≥3 条消息都在用、且词库里没有」的词 → 允许 10 分钟提前提取；
    // 没有生词就按普通冷却（默认 60 分钟），每小时最多 3 次（含普通）。
    let urgent = false;
    if (messages.length >= min) {
      try {
        const known = getSlangEntries().map((e) => e.content).join('\n');
        urgent = hasUrgentSignal(messages, known, { minMessages: 3 });
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'slang-context-service.mjs:3740'); }
    }
    const decision = decideSlangExtraction(slangPolicyState.get(key), {
      now,
      messageCount: messages.length,
      minMessages: min,
      cooldownMs: Number(cfg.slang?.extractCooldownMs ?? 300000),
      urgentCooldownMs: Number(cfg.slang?.urgentCooldownMs ?? 10 * 60 * 1000),
      maxPerHour: Number(cfg.slang?.urgentMaxPerHour ?? 3),
      urgent,
    });
    if (!decision.extract) return;
    slangPolicyState.set(key, decision.next);
    slangExtractionCooldowns.set(key, now);
    if (decision.reason === 'urgent') log(`[slang] ${key} 有生词信号，提前提取`);
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? '',
      // 谁点的头：她（qq_slang_judge）vs 控制台；留痕给控制台显示，不泄露给其他群。
      ...(e?.agentConfirmedAt ? { agentConfirmedAt: e.agentConfirmedAt } : {}),
      ...(e?.agentRejectedAt ? { agentRejectedAt: e.agentRejectedAt } : {})
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return getSlangEntries()
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    // [TIME-ONCE] 唯一时间行：日期 + 星期 + 时段 + 提示（以前这里另拼一条 toLocaleString，
    // 与 lifestate 的「现在是 …」重复；现在只保留 renderTimeLine 这一处）。
    const timeLine = renderTimeLine();
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(getSlangEntries(), cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  return { maybeQueueSlangExtraction, feedSlangWindow, allowSlangSubmit, publicSlangEntry, confirmedSlangListV2, withSlangContext };
}
