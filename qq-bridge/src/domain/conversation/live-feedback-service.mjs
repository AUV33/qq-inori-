// 实时反馈：owner 纠正/工具失败/设备失败/练手位/活动菜单。
//
// 从 app.mjs 的 main() 搬出（P3-RW-27，2026-10-31）。只写 session-notes/记忆/状态文件，
// 不发送；设备失败一次性提醒与练手位节流都在这里。
/**
 * @param {object} ctx
 */
export function createLiveFeedback(ctx) {
  const {
    fs, cfg, log, stateDataPath, reverse, looksLikeCorrection, loadSessionNotes,
    addCorrection, saveSessionNotes, clearOpenLoops, shouldNoteToolFailure,
    classifyToolError, renderLiveHint, addOpenLoop, openLoopText, classifyFailure,
    loadSkills, pickPracticeSlots, DEFAULT_MAX_INJECTED, renderPracticeSlots,
    renderActivityMenu,
  } = ctx;
  function noteSessionCorrection(key, text, isOwner = false) {
    try {
      if (!isOwner || !looksLikeCorrection(text)) return;
      const notes = loadSessionNotes();
      const r = addCorrection(notes, key, text, { source: 'owner' });
      if (r.ok && !r.duplicate) saveSessionNotes(notes);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:8008'); }
  }

  // [LIVE-LEARN] 实时工具反馈：失败 → 分类 + 换法提示，写进 session-notes 的 openLoops。
  // 只记“有下一步”的失败；成功后清掉同工具 streak。跨回合保留，下一次唤醒能看到。
  const liveFailStreaks = new Map();
  function noteLiveToolResult(key, tool, errorText = '', sessionId = '') {
    try {
      const k = String(key || (sessionId ? `task:${sessionId}` : ''));
      if (!k) return;
      const t = String(tool || '');
      if (!errorText) {
        for (const sk of [...liveFailStreaks.keys()]) if (sk.startsWith(`${k}|${t}|`)) liveFailStreaks.delete(sk);
        try {
          const notes = loadSessionNotes();
          const short = t.replace(/^mcp__[^_]+__/, '');
          if (clearOpenLoops(notes, k, { prefix: `${short} 报错：` })) saveSessionNotes(notes);
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:8025'); }
        return;
      }
      if (!shouldNoteToolFailure(t, errorText)) return;
      const cls = classifyToolError(t, errorText);
      const sk = `${k}|${t}|${cls.kind}`;
      const streak = (liveFailStreaks.get(sk) || 0) + 1;
      liveFailStreaks.set(sk, streak);
      const hint = renderLiveHint({ tool: t, error: errorText, streak });
      const notes = loadSessionNotes();
      // [WIRING-FIX] 成功时按短名（去掉 mcp__server__ 前缀）清 loop，失败时也必须用短名写，
      // 否则写进去的是全名、永远清不掉——同一工具的失败提示会一直挂在下一轮唤醒里。
      const shortName = t.replace(/^mcp__[^_]+__/, '');
      const r = addOpenLoop(notes, k, openLoopText(shortName, errorText), hint, { source: 'tool' });
      if (r.ok) saveSessionNotes(notes);
      try {
        fs.appendFileSync(stateDataPath('live-feedback.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), key: k, tool: t, kind: cls.kind, streak, hint }) + '\n', 'utf8');
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:8040'); }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:8041'); }
  }

  // [DEVICE-GUARD] 同一个回合里连续 3 次手机类失败 → 记一笔，下次唤醒提醒换事（不中途打断她）
  const DEVICE_BLOCKED_FILE = stateDataPath('device-blocked.json');
  const deviceStreak = new Map();
  function noteDeviceFailure(sessionId, text) {
    try {
      const sid = String(sessionId ?? '');
      if (!sid) return;
      if (classifyFailure(String(text ?? '')) !== 'device') { deviceStreak.delete(sid); return; }
      const n = (deviceStreak.get(sid) || 0) + 1;
      deviceStreak.set(sid, n);
      if (n === 3) {
        const key = reverse.get(sid) || '';
        fs.writeFileSync(DEVICE_BLOCKED_FILE, JSON.stringify({ at: Date.now(), key, sessionId: sid, streak: n }), 'utf8');
        log(`[device-guard] ${key || sid} 连续 ${n} 次手机失败，已记账（下一次唤醒提醒换事）`);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:8059'); }
  }
  function takeDeviceBlockedLine() {
    try {
      const raw = fs.readFileSync(DEVICE_BLOCKED_FILE, 'utf8');
      fs.rmSync(DEVICE_BLOCKED_FILE, { force: true }); // 一次性：说了就清
      const j = JSON.parse(raw);
      if (Date.now() - Number(j.at || 0) > 6 * 3600_000) return '';
      return '【手机还是没连上】上次一连着 3 次手机失败（没检测到设备/没授权）。那次想做的事先放着；这次别把时间花在手机上。\n\n';
    } catch { return ''; }
  }
  // [PRACTICE] 练手位：她学过但还没做成过的技能（≥1 次注入、成功 0），只递事实+许可，不派任务。
  // [PRACTICE-QUIET] 2026-10-29：试过很多次仍 0 成功的（如「明日方舟 adb 部署干员」注入 2709 次）
  // 不再每小时摆到眼前——那会把自主时间变成「再试一次」的循环。规则在 practice-slot.mjs。
  function practiceSlotLine() {
    try {
      const store = loadSkills(cfg.socialV2?.skills?.file);
      const items = store.items || [];
      const { stuck } = pickPracticeSlots(items);
      if (stuck.length) log(`[practice] 跳过 ${stuck.length} 条注入过 ${DEFAULT_MAX_INJECTED}+ 次仍未成功的技能（先放着，不再每小时推）`);
      return renderPracticeSlots(items);
    } catch { return ''; }
  }
  // [ACTIVITY-MENU] 2026-10-30：玩方舟是**可选活动**，不是待办。
  // 菜单只列「她会做的活动 + 会几件」（名字全来自技能库 activity 字段）；不写注入次数/成功数，
  // 否则又变回每小时催一次的任务单。挑不挑、挑哪个由她定。
  function activityMenuLine() {
    try {
      let extraActivities = [];
      try {
        const data = JSON.parse(fs.readFileSync(stateDataPath('activities.json'), 'utf8'));
        if (Array.isArray(data?._pool)) extraActivities = data._pool;
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:activity-pool'); }
      return renderActivityMenu(loadSkills(cfg.socialV2?.skills?.file).items || [], { extraActivities, limit: 3 });
    } catch (error) { globalThis.__ignoredCatch?.(error, 'live-feedback-service.mjs:activity-menu'); return ''; }
  }

  return { noteSessionCorrection, noteLiveToolResult, noteDeviceFailure, takeDeviceBlockedLine, practiceSlotLine, activityMenuLine };
}
