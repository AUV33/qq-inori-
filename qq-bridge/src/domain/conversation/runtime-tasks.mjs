// runtime-tasks.mjs · 任务池 + 工作台的运行时服务（从 app.mjs 拆出）
//
// 为什么拆：任务池/工作台共有 400+ 行状态机，和主聊天循环混在 app.mjs 里，
// 任何任务改动都要读 13k 行。这里只保留任务池状态机，依赖由 app 注入。
//
// 纪律：running 数组保持同一个引用（只 splice/push，不整体替换），
// 因为 console-server / mux-bus 直接持有它。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendTask, finishTask, promoteTask, pendingTasks, queuedTasks, expireTask, retaskToQueued, resumableTasks } from '../leaves/inori-taskledger.js';
import { poolCap, taskMaxMs, canDispatch, expiredRunning, loadPool, savePool } from '../leaves/inori-taskpool.js';
import { newWork, saveWorks, setWorkStatus, WORK_STATUS } from '../leaves/inori-works.js';
import { load as loadSkills, find as findSkills, noteInjected as noteSkillInjected, save as saveSkills } from '../leaves/inori-skills.js';
import { priorFailures } from '../leaves/inori-traces.js';

export function createTaskService(deps) {
  const {
    api, cfgRef, log, isDshReady, STATE_DIR, STATE_DATA_DIR,
    worksStore, ensureHerWorkspace, ensureChatModel, recordSessionKind,
    getSocialV2State, saveSocialV2State, scheduleWakeV2, recentTaskReportAt,
    taskSessions, taskCollectors, unwrap, buildWakePromptV2, rememberAgentToken,
    submitPromptWithTurnSlot,
  } = deps;
  const TASK_POOL_FILE = path.join(STATE_DIR, 'task-pool.json');
  const WORKS_FILE = path.join(STATE_DATA_DIR, 'works.json');
  const running = loadPool(TASK_POOL_FILE).running;
  let taskPoolMigrated = false;

  function worksSave() { saveWorks(WORKS_FILE, worksStore); }
  function workByTaskId(taskId) {
    const id = String(taskId || '');
    if (!id) return null;
    return worksStore.find((w) => w && w.taskId === id) || null;
  }
  function updateWorkById(id, fn) {
    const i = worksStore.findIndex((w) => w && w.id === id);
    if (i < 0) return null;
    const next = fn(worksStore[i]);
    if (!next) return null;
    worksStore[i] = next;
    worksSave();
    return next;
  }
  function buildWorkPromptText(work) {
    return [
      '【分身工作 · 你是当前 AI 伙伴的分身】',
      `要做的事：${work.title || work.goal || work.id}`,
      work.goal ? `目标：${work.goal}` : '',
      work.acceptance ? `验收：${work.acceptance}` : '',
      '',
      `这是工作台任务（work id=${work.id}）。干活过程中可以随时调 work_note 记一句进度（你的主体会看到）；`,
      '做完调 work_update(work_id, "done", 结果摘要 + 证据)；做不成调 work_update(work_id, "failed", 卡在哪 + 下一步)。',
      '收尾最后一行必须写：【任务结果】成功/失败/卡住｜证据：文件/截图/网址/机检结果/他确认｜下一步：一句话。',
      '没有这一行，系统按“未知”记账，不算做成。这行是给系统看的，不要当 QQ 消息发出去。',
      '你只对主账号本人汇报（主人是你的主），不要直接往 QQ 发消息，除非任务明确要求。',
    ].filter(Boolean).join('\n');
  }
  async function reconcileWorksOnBoot() {
    try {
      if (!isDshReady()) return;
      const active = worksStore.filter((w) => w && !['done', 'failed', 'cancelled'].includes(String(w.status)));
      if (!active.length) return;
      let requeued = 0;
      for (const w of active) {
        try {
          if (w.sessionId && running.some((x) => x.sessionId === w.sessionId)) continue;
          const row = pendingTasks().find((r) => r.id === w.taskId);
          if (row) continue;
          const prog = (Array.isArray(w.progress) ? w.progress : []).slice(-3).map((p) => p?.note || '').filter(Boolean).join('；');
          const row2 = appendTask({
            task: buildWorkPromptText(w) + (prog ? `\n\n【上次进度】${prog}` : ''),
            reportTo: w.reportTo || '', status: 'queued', acceptance: w.acceptance || '',
            fingerprint: `work:${w.title}`, nextAction: prog ? '接着上次进度做，不要从零重开' : '',
            intentionId: w.intentionId || '',
          });
          w.taskId = row2.id; w.status = 'queued'; w.sessionId = ''; w.updatedAt = Date.now(); requeued += 1;
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:79'); }
      }
      if (requeued) { worksSave(); log(`[works] 重启恢复：${requeued} 件活重新排队`); }
      await drainTaskPool();
    } catch (e) { log(`[works] 重启恢复失败（已忽略）: ${e?.message ?? e}`); }
  }

  async function startWork({ title, goal = '', acceptance = '', reportTo = '', intentionId = '' }) {
    const work = newWork({ title: String(title || '').trim(), goal, acceptance, reportTo, intentionId });
    if (!work.title) throw new Error('title 不能为空');
    const row = appendTask({
      task: buildWorkPromptText(work), reportTo: String(reportTo || ''), status: 'queued',
      acceptance: String(acceptance || ''), fingerprint: `work:${work.title}`, intentionId,
    });
    work.taskId = row.id; worksStore.push(work); worksSave();
    await drainTaskPool();
    log(`[works] 新活 ${work.id}「${work.title}」→ 任务 ${row.id}`);
    return work;
  }

  function poolSave() { savePool(TASK_POOL_FILE, running); }

  async function createTaskSession(reportTo = '', ownerRequested = false) {
    const herWsId = await ensureHerWorkspace();
    // [PRESET-BY-CALLER] 只按调用方身份给 admin preset，绝不按 reportTo 猜：
    // reportTo 是请求体字段，群会话把它填成 owner 就能拿到 admin 会话（confused deputy）。
    // `reportTo === ownerKey` 这个旧判据已删除；主人私聊发起时 ownerRequested=true。
    const fromOwner = !!ownerRequested;
    const taskPreset = fromOwner
      ? (cfgRef?.socialV2?.taskPool?.preset || 'qq-chat-admin')
      : (cfgRef?.socialV2?.agentPreset || 'qq-chat-v2');
    log(`[task-pool] 任务会话 preset=${taskPreset}（来源 ${reportTo || '未知'}）`);
    const value = unwrap(await api.sessions.create({ workspaceId: herWsId, agentPreset: taskPreset }), 'task pool session');
    await ensureChatModel(value.sessionId, cfgRef?.socialV2?.taskPool?.reasoningEffort || 'low');
    try { await api.callUnary('session/rename', { sessionId: value.sessionId, title: `任务分派 ${Date.now().toString(36).slice(-5)}` }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:111'); }
    recordSessionKind(value.sessionId, 'task');
    return value.sessionId;
  }

  const taskSkillIds = new Map();
  function takeTaskSkillIds(sessionId) {
    const ids = taskSkillIds.get(String(sessionId || '')) || [];
    taskSkillIds.delete(String(sessionId || ''));
    return ids;
  }

  function buildTaskPromptText(task, reportTo, onSkillIds = null) {
    let outText = [
      '【接手一件事 · 没人等你回话】',
      `要做的事：${task}`,
      '',
      `做完把结果发到 ${reportTo}（用 qq_send_message，key 参数填 ${reportTo}）。`,
      '做得越快越好；做不了的就说清楚卡在哪，不要硬猜、不要假装做成了。',
      '这是独立任务会话：你的输出不会自动发到 QQ，必须自己调用发送工具才算有回报。',
      '',
      '【收尾格式】最后一行必须写：',
      '【任务结果】成功/失败/卡住｜证据：文件/截图/网址/机检结果/他确认｜下一步：一句话',
      '没有这一行，系统按“未知”记账，不算做成。这行是给系统看的，不要当 QQ 消息发出去。',
    ].join('\n');
    try {
      if (cfgRef?.socialV2?.skills?.enabled !== false) {
        const store = loadSkills(cfgRef?.socialV2?.skills?.file);
        const hits = findSkills(store, task, 3);
        if (hits.length) {
          const ids = hits.map((h) => h?.skill?.id).filter(Boolean);
          try { onSkillIds?.(ids); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:142'); }
          try { for (const id of ids) noteSkillInjected(store, id); saveSkills(store, cfgRef?.socialV2?.skills?.file); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:143'); }
          outText += '\n【你学过这些做法（能对上就照做，也可以改）】\n'
            + hits.map((h) => { const s = h.skill; return `- ${s.name}：${s.desc || ''}｜步骤：${(s.steps || []).join(' → ')}｜成功判据：${s.verify || s.verifyHuman || '没写'}${s.nextDrill ? `｜下一步练：${s.nextDrill}` : ''}｜掌握 ${Number(s.mastery ?? 0)}`; }).join('\n')
            + '\n用到的每条做完后调 skill_record 记一次（有判据的先 skill_verify，验过才算 ok=true；没判据只记尝试）。';
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:149'); }
    return outText;
  }

  async function deliverTaskPrompt(sessionId, task, reportTo, ownerRequested = false) {
    let priorBlock = '';
    try {
      const rows = priorFailures(task, { limit: 2 });
      if (rows.length) priorBlock = '\n\n【以前同类失败的卡点】\n' + rows.map((r) => `- ${String(r.error || r.note || '没有记录原因').slice(0, 100)}`).join('\n');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:158'); }
    let skillIds = [];
    const block = buildTaskPromptText(task + priorBlock, reportTo, (ids) => { skillIds = ids; });
    let full = block;
    try {
      let ctx = buildWakePromptV2(reportTo, 'handoff');
      if (ownerRequested) {
        try {
          const stT = getSocialV2State(reportTo);
          if (!stT.ownerAgentToken) {
            stT.ownerAgentToken = crypto.randomBytes(24).toString('hex');
            rememberAgentToken(reportTo, stT.ownerAgentToken);
            saveSocialV2State();
          }
          if (stT.agentToken) ctx = ctx.replaceAll(stT.agentToken, stT.ownerAgentToken);
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:173'); }
      }
      full = ctx + '\n\n' + block;
    } catch (error) {
      log(`[task-pool] ${reportTo} 唤醒上下文构建失败（只发任务文本）: ${error?.message ?? error}`);
    }
    try {
      api.events.follow(sessionId);
      taskSessions.add(sessionId);
      taskCollectors.delete(sessionId);
      taskSkillIds.set(String(sessionId), skillIds);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:184'); }
    const accepted = await submitPromptWithTurnSlot({
      sessionId, label: `task:${String(sessionId).slice(0, 8)}`, kind: 'background',
      content: [{ type: 'text', text: full }],
    });
    if (!accepted.result.ok) {
      try { taskSessions.delete(sessionId); taskSkillIds.delete(String(sessionId)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:190'); }
      throw new Error(`task prompt 被拒: ${accepted.result.error?.code}: ${accepted.result.error?.message}`);
    }
    log(`[task-pool] 已投递任务会话 ${sessionId.slice(0, 8)}（回报到 ${reportTo}，${[...full].length} 字）`);
  }

  async function dispatchQueuedTask(row) {
    let sessionId;
    try { sessionId = await createTaskSession(row.reportTo || '', !!row.ownerRequested); }
    catch (error) { log(`[task-pool] 建会话失败，${row.id} 继续排队: ${error?.message ?? error}`); return false; }
    const promoted = promoteTask(row.id, sessionId);
    if (!promoted) {
      try { await api.stopSessionWork(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:202'); }
      try { await api.callUnary('workspace/archiveSession', { sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:203'); }
      return true;
    }
    running.push({ taskId: row.id, sessionId, dispatchAt: Date.now(), taskShort: String(row.task || '').slice(0, 40), reportTo: row.reportTo || '', acceptance: row.acceptance || '' });
    poolSave();
    try {
      const resumeNote = (row.lastError || row.nextAction)
        ? `\n\n【上次做到哪】${row.lastError || row.note || '没有结论'}${row.nextAction ? `\n【下一步】${row.nextAction}` : ''}\n（接着做，不要从零重开；做完仍要写【任务结果】行。）`
        : '';
      const acceptanceLine = row.acceptance ? `\n\n【验收】${row.acceptance}\n做完必须给证据。` : '';
      await deliverTaskPrompt(sessionId, String(row.taskFull || row.task || '') + acceptanceLine + resumeNote, row.reportTo, !!row.ownerRequested);
      log(`[task-pool] 开跑 ${row.id}（${String(row.task || '').slice(0, 40)}，池 ${running.length}/${poolCap(cfgRef ?? {})}）`);
      return true;
    } catch (error) {
      running.splice(0, running.length, ...running.filter((x) => x.sessionId !== sessionId));
      poolSave(); retaskToQueued(row.id);
      try { await api.stopSessionWork(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:219'); }
      try { await api.callUnary('workspace/archiveSession', { sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:220'); }
      log(`[task-pool] 投递失败，${row.id} 退回排队: ${error?.message ?? error}`);
      return false;
    }
  }

  function pickNextTaskRow() {
    const rows = queuedTasks();
    if (!rows.length) return null;
    const isWork = (text) => String(text || '').startsWith('【分身工作');
    const worksCap = Math.max(1, Number(cfgRef?.socialV2?.works?.maxParallel) || 2);
    const runningWorks = running.filter((x) => isWork(x.taskShort)).length;
    const ownerRows = rows.filter((r) => !isWork(r.task));
    const workRows = rows.filter((r) => isWork(r.task));
    if (ownerRows.length) return ownerRows[0];
    if (runningWorks < worksCap) return workRows[0] ?? null;
    return null;
  }

  async function drainTaskPool() {
    let guard = 0;
    while (guard++ < 16) {
      if (!canDispatch(running.length, cfgRef ?? {})) break;
      const next = pickNextTaskRow();
      if (!next) break;
      if (!(await dispatchQueuedTask(next))) break;
    }
  }

  async function retireTaskSession(sessionId, reason = '') {
    const entry = running.find((x) => x.sessionId === sessionId);
    if (!entry) return;
    running.splice(0, running.length, ...running.filter((x) => x.sessionId !== sessionId));
    poolSave();
    try { await api.stopSessionWork(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:254'); }
    try { await api.callUnary('workspace/archiveSession', { sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:255'); }
    try { taskSessions.delete(sessionId); taskCollectors.delete(sessionId); api.events.forget(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:256'); }
    try { for (const row of pendingTasks()) if (row.sessionId === sessionId && row.id !== entry.taskId) { if (retaskToQueued(row.id)) log(`[task-pool] ${row.id} 退回队列（旧会话遗留）`); } } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:257'); }
    log(`[task-pool] 会话已归档 ${sessionId.slice(0, 8)}（${entry.taskId || '?'}${reason ? '，' + reason : ''}）`);
    await drainTaskPool();
  }

  async function taskPoolWatchdog() {
    if (!isDshReady() || !running.length) return;
    const cap = taskMaxMs(cfgRef ?? {});
    const nowMs = Date.now();
    for (const dead of expiredRunning(running, nowMs, cap)) {
      let isRunning = false;
      try {
        const list = unwrap(await api.sessions.list({}), 'session.list');
        const items = Array.isArray(list) ? list : (list?.items ?? []);
        isRunning = items.find((s) => s?.sessionId === dead.sessionId)?.running === true;
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:272'); }
      const hardCap = cap * 2;
      if (isRunning && nowMs - Number(dead.dispatchAt || 0) < hardCap) {
        dead.dispatchAt = nowMs; poolSave();
        log(`[task-pool] ${dead.taskId || '?'} 超时但 DSH 仍在跑，顺延计时（再给 ${Math.round(cap / 60000)} 分钟）`);
        continue;
      }
      expireTask(dead.taskId, `task timeout（超 ${Math.round(cap / 60000)} 分钟未完成）`);
      try {
        const w = workByTaskId(dead.taskId);
        if (w) updateWorkById(w.id, (cur) => setWorkStatus(cur, WORK_STATUS.FAILED, Date.now(), '超时（' + Math.round(cap / 60000) + ' 分钟没做完）'));
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:283'); }
      notifyTaskDone(dead.reportTo, dead.taskShort, `超 ${Math.round(cap / 60000)} 分钟没做完`, false);
      log(`[task-pool] ${dead.taskId || '?'} 超时（${Math.round((nowMs - Number(dead.dispatchAt || 0)) / 60000)} 分钟），归档并出队`);
      await retireTaskSession(dead.sessionId, 'timeout');
    }
    for (const entry of [...running]) {
      const pending = pendingTasks().find((r) => r.id === entry.taskId);
      let isRunning = true;
      try {
        const list = unwrap(await api.sessions.list({}), 'session.list');
        const items = Array.isArray(list) ? list : (list?.items ?? []);
        isRunning = items.find((s) => s?.sessionId === entry.sessionId)?.running === true;
      } catch { continue; }
      if (!pending) {
        if (isRunning) continue;
        log(`[task-pool] ${entry.taskId || '?'} 台账已终态、会话不跑了，归档腾槽`);
        await retireTaskSession(entry.sessionId, 'ledger-terminal');
        continue;
      }
      if (pending.status !== 'running') continue;
      if (Date.now() - Number(entry.dispatchAt || 0) < 90 * 1000) continue;
      if (isRunning) continue;
      finishTask(entry.taskId, { ok: false, note: '结果未知：重启窗口丢了 turn/end（按未完成记账）' });
      try {
        const w = workByTaskId(entry.taskId);
        if (w) updateWorkById(w.id, (cur) => setWorkStatus(cur, WORK_STATUS.FAILED, Date.now(), '结果未知：会话空闲但没收到收尾事件'));
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:309'); }
      notifyTaskDone(entry.reportTo, entry.taskShort, '结果未知：重启把收尾事件吞了，按未完成记账（要的话可以让我重跑）', false);
      log(`[task-pool] ${entry.taskId || '?'} 会话已空闲但没收到 turn/end，按「结果未知」收尾（重启窗口丢事件兜底）`);
      await retireTaskSession(entry.sessionId, 'idle-close');
    }
  }

  async function migrateTaskPoolOnce() {
    if (taskPoolMigrated) return;
    taskPoolMigrated = true;
    for (const entry of running) {
      try { api.events.follow(entry.sessionId); taskSessions.add(entry.sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:320'); }
    }
    try {
      const list = unwrap(await api.sessions.list({}), 'session.list');
      const alive = new Set((Array.isArray(list) ? list : (list?.items ?? [])).map((s) => String(s?.sessionId ?? '')).filter(Boolean));
      for (const row of pendingTasks()) {
        if (row.status === 'queued') continue;
        const inPool = running.some((x) => x.sessionId === row.sessionId);
        if (!inPool && row.sessionId && !alive.has(String(row.sessionId))) {
          expireTask(row.id, 'restart cleanup: session not found');
          log(`[task-pool] 幽灵任务判死：${String(row.task || '').slice(0, 30)}（${String(row.sessionId).slice(0, 8)} 已不存在）`);
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:333'); }
    try {
      const old = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'isolated-task.json'), 'utf8'));
      if (!old?.sessionId) return;
      const pending = pendingTasks().find((r) => r.sessionId === old.sessionId);
      if (!pending) { log(`[task-pool] 旧共享任务会话无未终任务，跳过迁移（${String(old.sessionId).slice(0, 8)}）`); return; }
      if (running.some((x) => x.sessionId === old.sessionId)) return;
      running.push({ taskId: pending.id || '', sessionId: old.sessionId, dispatchAt: Date.now(), taskShort: String(pending.task || '').slice(0, 40), reportTo: pending.reportTo || '', acceptance: pending.acceptance || '' });
      poolSave(); api.events.follow(old.sessionId); taskSessions.add(old.sessionId); taskCollectors.delete(old.sessionId);
      log(`[task-pool] 旧任务会话迁入池（${String(old.sessionId).slice(0, 8)}，${String(pending.task || '').slice(0, 30)}）`);
      await drainTaskPool();
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:344'); }
  }

  function notifyTaskDone(reportTo, taskText, note, ok = true) {
    try {
      if (!reportTo) return;
      const stD = getSocialV2State(reportTo);
      stD.lastTaskDone = { task: String(taskText || '').slice(0, 120), note: String(note || '').slice(0, 100), ok, at: Date.now() };
      saveSocialV2State();
      const justReported = Date.now() - Number(recentTaskReportAt.get(reportTo) || 0) < 2 * 60 * 1000;
      if (!justReported) scheduleWakeV2(reportTo, 'taskDone');
      log(`[task-pool] 完成通知 ${reportTo}（${String(taskText || '').slice(0, 30)}${ok ? '' : '，失败'}）${justReported ? '；任务会话刚回报过，不重复唤醒' : '；已安排 taskDone 唤醒'}`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-tasks.mjs:356'); }
  }

  function taskBoardSnapshot() {
    const pending = pendingTasks();
    return {
      capacity: poolCap(cfgRef ?? {}),
      running: running.map((x) => ({ taskId: x.taskId, sessionId: x.sessionId, dispatchAt: x.dispatchAt, task: x.taskShort, reportTo: x.reportTo })),
      queued: pending.filter((r) => r.status === 'queued').map((r) => ({ id: r.id, at: r.at, task: r.task, reportTo: r.reportTo })),
      resumable: resumableTasks({ limit: 10 }).map((r) => ({ id: r.id, task: r.task, outcome: r.outcome, lastError: r.lastError, nextAction: r.nextAction, finishedAt: r.finishedAt })),
    };
  }

  return {
    running, worksSave, workByTaskId, updateWorkById, buildWorkPromptText, reconcileWorksOnBoot, startWork,
    poolSave, createTaskSession, buildTaskPromptText, deliverTaskPrompt, takeTaskSkillIds,
    dispatchQueuedTask, pickNextTaskRow, drainTaskPool, retireTaskSession,
    taskPoolWatchdog, migrateTaskPoolOnce, notifyTaskDone, taskBoardSnapshot,
  };
}
