// 隔离会话投递与日记：buildIsolatedContextV2 / deliverToIsolated / startDiarySession。
//
// 从 app.mjs 的 main() 搬出（P3-RW-46，2026-11-01）。会话创建/上下文包/令牌剥离/回合槽
// 全部注入；模块只负责「投什么、投给谁、投完跟不跟」。
/**
 * @param {object} ctx
 */
export function createIsolatedSession(ctx) {
  const {
    cfg, log, getSocialV2, getSocialV2State, readRoleState, roleHintForMode,
    getIsSessionAllowedInCurrentMode, renderConversations, getDshReady, yieldToConversations,
    isolatedDead, ensureIsolatedSession, ensureChatModel, buildWakePromptV2,
    stripKnownTokens, collectSessionTokens, promptTextOf, buildContextPacket,
    groupReadWindowText, getSelfKnowledgeBlock, acquireTurnSlot, bindTurnGrant,
    submitPromptWithTurnSlot, getApi, thoughtSessions, thoughtCollectors,
    taskSessions, taskCollectors, stateWithKey, saveSocialV2State,
    getLifeState, todayDiaryWritten, diaryAttempts, bumpDiaryAttempts, logAction,
    readJsonlSafe, MEM_DIR, stateDataPath, renderReflectLine, loadLessons, loadGoals,
    // [WIRING-FIX] 日记上下文里用 path.join 拼路径；模块里既没 import 也没注入 → ReferenceError
    path,
    diarySessions, createTurnCollector,
  } = ctx;
  function buildIsolatedContextV2(key) {
    try {
      const parts = [];
      const roleState = readRoleState();
      const roleFull = roleHintForMode('v2', '');
      if (roleFull) parts.push(`【当前角色】${roleState.role}\n${roleFull}`);
      const rows = [];
      for (const [ck, cst] of getSocialV2().conversations) {
        if (!ck) continue;
        if (ck !== key && !getIsSessionAllowedInCurrentMode(ck)) continue;
        rows.push({ key: ck, ...cst });
      }
      const convs = renderConversations(rows, { currentKey: key });
      if (convs) parts.push(convs);
      if (!parts.length) return '';
      return `${parts.join('\n\n')}\n\n【这是背景，不是催你回话】现在是你的时间；不要用发送工具去回复上面列出的会话。\n\n`;
    } catch { return ''; }
  }

  async function deliverToIsolated(kind, promptText, { key = null, reason = kind, beforePrompt = null } = {}) {
    if (!getDshReady()) throw new Error('DSH 未就绪');
    await yieldToConversations(kind);
    // [ISOLATED-REVIVE] 上次这个会话被 blocked（=已被归档）→ 先重建再投，别把内容丢进死会话
    if (isolatedDead.has(kind)) {
      // 别在这里先 delete：交给 ensureIsolatedSession 新建成功后统一 delete+落盘，
      // 否则文件里的记录清不掉，下次重启又会白重建一次。
      await ensureIsolatedSession(kind, { force: true }).catch((error) => { log(`[isolated] ${kind} 重建失败: ${error?.message ?? error}`); });
    }
    const sessionId = await ensureIsolatedSession(kind);
    // [EFFORT-ALL] 隔离会话（ownlife/diary/reflect/task）也跟随默认思考档：
    // 已存在的会话不会走创建分支，这里每次投递补一次（epoch 已应用则直接返回）。
    if (kind !== 'gate') {
      try { await ensureChatModel(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:3381'); }
    }
    let full = promptText;
    if (key) {
      try {
        // [ISOLATED-CONTEXT] 只有真正需要办事的隔离会话（task/gate）拿完整唤醒上下文（含令牌）；
        // 独处/反思/日记/学习只拿背景——它们没有理由往任何会话里发消息。
        if (kind === 'task' || kind === 'gate') {
          full = buildWakePromptV2(key, reason) + '\n\n' + promptText;
        } else {
          // [CONTEXT-PACKET] 类型边界：isolated 不允许令牌；内容里万一混进已知令牌，这里兜底剥离。
          const { text, hits } = stripKnownTokens(buildIsolatedContextV2(key), collectSessionTokens(getSocialV2().conversations));
          if (hits) log(`[context-packet] ${kind} 内容里混入 ${hits} 个会话令牌，已剥离（本不该出现）`);
          full = promptTextOf(buildContextPacket({ purpose: 'isolated', content: text })) + '\n\n' + promptText;
        }
      } catch (error) {
        log(`[isolated] ${kind} 唤醒上下文构建失败（只发任务文本）: ${error?.message ?? error}`);
      }
    }
    // [GROUP-WINDOW] 她自己的时间（ownlife/free-tick）也带上只读群窗。
    if (kind === 'ownlife') {
      try { const gw = groupReadWindowText(); if (gw) full += '\n\n' + gw; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:3402'); }
    }
    // [SELF-KNOWLEDGE] 她自己的时间也要看得见自己：自述 / 自我档案 / 最近的样子 / 趋势 /
    // 手上的目标 / 上次手机里怎么做的。以前这些只在有人叫她时注入，她自己安排时间时看不到。
    if (kind === 'ownlife' || kind === 'free-tick') {
      try {
        const sk = getSelfKnowledgeBlock({ withTraces: true, key });
        if (sk) {
          full = sk + '\n\n' + full;
          log(`[self-knowledge] ${kind} 注入自我认知（${sk.length} 字）`);
        }
      } catch (error) { log(`[self-knowledge] ${kind} 注入失败（已忽略）: ${error?.message ?? error}`); }
    }

    // [GATE-FIX] 需要在投递前就登记 collector 的调用方（门的 flash 回合只有 1~2 秒，
    // 投递后再登记会漏掉 turn/start 与 assistant/message，只剩一个 turn/end——
    // createTurnCollector 没见过 turn/start 就会把它判成「不是我这一轮」，结果静默丢失。
    // 实测：10-25 全天 34 次粗筛命中投进 flash，stage-2 一条都没回来，topicMention 从未触发）。
    const turnGrant = await acquireTurnSlot(`isolated:${kind}`, { kind: 'background' });
    bindTurnGrant(turnGrant, sessionId);
    // [FOLLOW-FIRST] 必须赶在 submit 之前登记 follow：
    // follow 请求往返期间 turn/start 可能已经发生，投递后再 follow 会错过它，
    // 调度器就以为“拿到槽但没开始回合”，60s 后回收槽位（ownlife/reflect 长期空转的根因之一）。
    if (kind === 'reflect' || kind === 'ownlife') {
      // [THOUGHT-REGISTER] 会话登记与 follow 必须分开：旧代码放在同一个 try 且 best-effort 吞错，
      // DSH 断连时 follow 抛错 → thoughtSessions.add 被跳过 → mux 永不采集该回合，
      // lastThoughtTurn 恒为 null（实测 2026-11-03 整夜 18 次 thought=null 的根因）。
      // 登记是本地状态，绝不能被网络调用绑架；失败也要留日志，不再静默。
      thoughtSessions.add(sessionId);
      thoughtCollectors.delete(sessionId);
      try {
        getApi().events.follow(sessionId);
      } catch (error) {
        log(`[isolated] ${kind} follow 失败（会话已登记，回合仍会被采集）: ${error?.message ?? error}`);
        globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:follow-first-thoughts');
      }
    }
    if (kind === 'task') {
      try {
        getApi().events.follow(sessionId);
        taskSessions.add(sessionId);
        taskCollectors.delete(sessionId);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:follow-first-task'); }
    }
    if (kind === 'diary') {
      try { getApi().events.follow(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:follow-first-diary'); }
    }
    if (typeof beforePrompt === 'function') {
      try { beforePrompt(sessionId); } catch (error) { log(`[isolated] ${kind} 投递前钩子失败（继续投递）: ${error?.message ?? error}`); }
    }
    const accepted = await submitPromptWithTurnSlot({
      sessionId,
      label: `isolated:${kind}`,
      kind: 'background',
      content: [{ type: 'text', text: full }],
      turnGrant,
    });
    if (!accepted.result.ok) {
      throw new Error(`isolated ${kind} prompt 被拒: ${accepted.result.error?.code}: ${accepted.result.error?.message}`);
    }
    // [FOLLOW-FIRST] follow/念头/任务/日记的登记已移到 submit 之前（见上），此处不再重复。
    log(`[isolated] ${kind} 已投递（${sessionId.slice(0, 8)}，${[...full].length} 字）`);
    return { ok: true, sessionId };
  }

  const diaryForcedDays = new Set(); // 操作员强制写过的日期（重试时要继承 force）
  async function startDiarySession(targetDay, opts = {}) {
    // opts.force：操作员手动触发时越过"她已睡着"这道门（默认不越过）

    const day = targetDay || new Date().toLocaleDateString('sv-SE');
    const makeup = !!targetDay; // 补写昨天的
    const force = !!opts.force || diaryForcedDays.has(day);
    // 1) 写过就不写；2) 睡着不写（不叫醒她写日记）
    if (todayDiaryWritten(day)) { log(`[diary] ${day} 已写过，跳过`); logAction({ t: 'diary', day, made: false, why: 'already_written' }); return; }
    if (getLifeState().state === 'sleep' && !force) { log(`[diary] ${day} 她已睡着，日记跳过（不叫醒）`); logAction({ t: 'diary', day, made: false, why: 'asleep' }); return; }
    if (getLifeState().state === 'sleep' && force) log(`[diary] ${day} 她睡着，但这是手动触发，仍然写（force）`);
    if (opts.force) diaryForcedDays.add(day);
    // [DIARY-DEDUPE] 同一天最多投 2 次：写成过一次就不再投，两次都失败也不再烧钱重投
    const att = diaryAttempts(day);
    // [DIARY-FIX] 运维手动触发（force）要能补写：否则撞上"每天最多 2 次"就永远补不回来
    if (att >= 2 && !force) { log(`[diary] ${day} 今天已投过 ${att} 次都没写成，不再重投`); logAction({ t: 'diary', day, made: false, why: 'attempt-cap' }); return; }
    if (att >= 2 && force) log(`[diary] ${day} 已投过 ${att} 次，本次是手动补写（force 越过上限）`);
    logAction({ t: 'diary', day, made: true, makeup });
    // 素材：全部确定性取材
    const parts = [];
    try {
      const memDir = cfg.getSocialV2()?.memory?.dir || MEM_DIR;
      const digest = readJsonlSafe(path.join(memDir, 'memory.jsonl')).filter((r) => r?.kind === 'day-digest' && String(r.day) === day);
      if (digest.length) parts.push(`【今天聊过的】${String(digest[digest.length - 1].text).slice(0, 300)}`);
      const trows = readJsonlSafe(path.join(stateDataPath('traces'), `${day}.jsonl`));
      const stuckN = trows.filter((t) => t?.stuck).length;
      if (trows.length) parts.push(`【今天手机上做的】${trows.length} 段操作，其中 ${stuckN} 段卡住过`);
      const lifeLine = renderReflectLine(getLifeState());
      if (lifeLine) parts.push(lifeLine);
      const todayLessons = loadLessons(cfg.getSocialV2()?.lessons?.file).filter((l) => String(l.at || '').startsWith(day));
      if (todayLessons.length) parts.push('【今天新攒的经验】\n' + todayLessons.map((l) => '- ' + String(l.text).slice(0, 60)).join('\n'));
      const actGoals = loadGoals(cfg.getSocialV2()?.goals?.file).filter((g) => g.status === 'active');
      if (actGoals.length) parts.push('【手头上挂着的事】\n' + actGoals.map((g) => '- ' + String(g.text).slice(0, 50)).join('\n'));
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:3492'); }
    const material = parts.length ? parts.join('\n') : '（今天很安静，没什么大事发生）';
    const head = makeup
      ? '【昨晚的日记（补）】你昨晚睡着前没来得及写日记，现在刚醒，把昨晚到现在补成一篇较长且详细的记录 + 总结（不少于 300 字）：'
      : '【今天的日记】一天快结束了，写今天的日记——不是碎片，是一篇较长且详细的记录 + 总结（不少于 300 字）：';
    const prompt = `${head}
  1. 今天记下来的事：我做了什么（聊天/任务/玩手机），每件事干成得怎样
  2. 今天想明白的：卡在哪、学到了什么、哪件事我做得不对
  3. 明天：想接着做什么、期待什么
  素材（都是今天的，你决定结构和角度，不用全覆盖）：
  ${material}

  直接写日记正文，不用调任何工具，不用发 QQ 消息。一篇写到底，别写流水账。`;
    const key = `private:${String(cfg.ownerQQ ?? '')}`;
    // [AUDIT-FIX] sid 必须在 try 外可见：catch 里要删的是本次真正登记的 key，
    // 而不是空串。原先 delete('') 让 diarySessions.size>0 永久为真，日记调度整体停摆。
    // [AUDIT-FIX] 一次投递可能登记多个 sessionId（deliverToIsolated 在会话已死时会
    // force 重建），失败时必须把**所有**登记过的 key 都清掉，否则残留一个就让
    // diarySessions.size>0 永久为真，日记调度整体停摆。
    const registered = new Set();
    const register = (id) => {
      if (!id) return;
      registered.add(id);
      diarySessions.set(id, day);
    };
    try {
      register(await ensureIsolatedSession('diary'));
      bumpDiaryAttempts(day);
      await deliverToIsolated('diary', prompt, {
        key, reason: 'diary',
        // [DIARY-CAPTURE] 必须在投递前登记 collector：否则 turn/start 与 assistant/message 先流过，
        // 只剩一个 turn/end，createTurnCollector 认不出来（同注意门那次的坑）→ 日记永远落不了盘。
        beforePrompt: (sessionId) => {
          register(sessionId);
          thoughtCollectors.set(sessionId, createTurnCollector());
          try { getApi().events.follow(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'isolated-session-service.mjs:3517'); }
        },
      });
      log(`[diary] 已发起 ${day} 的日记会话（素材 ${parts.length} 项，第 ${diaryAttempts(day)} 次投递）`);
    } catch (error) {
      for (const id of registered) {
        diarySessions.delete(id);
        thoughtCollectors.delete(id);
      }
      log(`[diary] 发起失败: ${error?.message ?? error}`);
    }
  }
  let diaryInFlight = false;
  let lastMakeupAttempt = '';
  const diaryTimer = setInterval(async () => {
    try {
      if (diaryInFlight || diarySessions.size > 0 || !cfg) return;
      const d = new Date();
      const h = d.getHours();
      const today = d.toLocaleDateString('sv-SE');
      const yday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
      if (h >= 22 && d.getMinutes() >= 30 && !todayDiaryWritten(today)) {
        // 每晚 22:30 / 23:30：当天没写且她醒着 → 写今天的
        diaryInFlight = true;
        // [AUDIT-FIX] 用 finally 复位：异常路径下 diaryInFlight 曾永久为 true，日记再不调度。
        try { await startDiarySession(); } finally { diaryInFlight = false; }
      } else if (h < 8 && !todayDiaryWritten(yday) && lastMakeupAttempt !== today && getLifeState().state !== 'sleep') {
        // 清晨补写：昨晚没写成（她睡着了）→ 她醒来后补一篇"昨晚的"（每个早晨只试一次）
        lastMakeupAttempt = today;
        diaryInFlight = true;
        try { await startDiarySession(yday); } finally { diaryInFlight = false; }
      }
    } catch (error) { log(`[diary] 调度失败: ${error?.message ?? error}`); }
  }, 60000);
  diaryTimer.unref?.();

  // [SLANG-WAITFIX] 取证实锤（2026-10-25 22:39 批）：重批 turn 跑 283 秒（32 次 web_search/web_fetch），
  // 120s 必超时；超时文案又含「会话」被失效正则误伤 → 作废+归档+重建学习会话，已完成的结果白扔。
  // 默认上调 300s（覆盖 283s 重批），可用 cfg.slang.learnerWaitMs 覆盖（非法值回退默认）。

  // [WIRING-FIX] 2026-11-03：diaryForcedDays 归本模块所有，mux-bus 重试日记时要读它判断哪天被强制过。
  // 以前 consoleDeps 的 getter 引用了一个从未声明的同名标识符 ⇒ 重试分支一读就 ReferenceError。
  return { buildIsolatedContextV2, deliverToIsolated, startDiarySession, diaryForcedDays };
}
