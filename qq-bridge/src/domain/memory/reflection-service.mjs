// 夜间反思：每天一次/重试，把当天经历、学习、行为账喂给反思回合。
//
// 从 app.mjs 的 main() 搬出（P3-RW-26，2026-10-31）。反思状态文件、prompt 拼装、
// 投递与结果检查全部经 deps 注入；模块只持有定时器句柄。
/**
 * @param {object} ctx
 */
export function createReflectionService(ctx) {
  const {
    fs, path, cfg, STATE_DATA_DIR, MEM_DIR, log, appendJsonl, writeJsonDocument,
    readJsonlSafe, deliverToIsolated, getSocialV2State, buildReflectPrompt,
    checkReflectOutcome, reflectShouldRun, summarizeLearning, renderLearningDigest,
    renderReflectLine, renderSlangJudgeLine, writeReflectInsight, loadGoals, loadLessons,
    writeDailyDigestV2, writeBehaviorMemorySnapshot, renderBehaviorLedger, stateDataPath,
    // [WIRING-FIX] 夜间反思拼 prompt 时要读生活状态和黑话库；原来直接引用 app.mjs 的局部名，
    // 搬出后每次反思都 ReferenceError（反思一直静默失败）。
    getLifeState, getSlangEntries,
    // [LIFE-LOG-FEED] 生命线摘要（最近 24h 收发/睡眠/反思/错误），失败则整行不出现
    getLifeSummary = () => '',
    // [WIRING-FIX] 上一轮反思回合结果由 mux 写入 main()（lastThoughtTurn），模块里没有这个名字，必须注入 getter
    getLastThoughtTurn = () => null,
    // [REFLECT-LIFE-LOG] 反思结果回写生命线：R7「反思产物可追溯」+ 事故可回放 + Aliveness 成长维。
    // 未注入时为 no-op，既有调用方/测试行为不变。
    appendLifeEvent = () => {},
  } = ctx;
  let tickRef = null;
  function startNightlyReflection() {
    const REFLECT_STATE = path.join(STATE_DATA_DIR, 'reflection.json');
    // [REFLECT-AUDIT] 每次发起/产出检查都落一条，失败原因不再只活在会被轮转掉的 bridge.log 里：
    // 之前 10-28 03:33 那次「经验 +0 / 目标 +0」，事后完全查不到为什么（日志已滚走）。
    const REFLECT_RUNS = path.join(STATE_DATA_DIR, 'reflection-runs.jsonl');
    const noteRun = (row) => { try { appendJsonl(REFLECT_RUNS, { at: new Date().toISOString(), ...row }, { source: 'bridge/reflection' }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8557'); } };
    const readState = () => { try { return JSON.parse(fs.readFileSync(REFLECT_STATE, 'utf8')); } catch { return {}; } };
    const writeState = (s) => { try { writeJsonDocument(REFLECT_STATE, s, { source: 'bridge/reflection' }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8559'); } };
    const lessonCount = () => { try { return loadLessons(cfg.socialV2?.lessons?.file).length; } catch { return 0; } };
    const memoryCount = () => { try { return (fs.readFileSync(MEM_DIR + '/memory.jsonl', 'utf8').split('\n').filter((l) => l.trim()).length); } catch { return 0; } };

    const tick = async () => {
      try {
        // [DIGEST] 每天一次把当天消息压成摘要（已写过就跳过；独立于反思，不受 24h 冷却影响）
        writeDailyDigestV2();
        // [BEHAVIOR-MEM] 每小时一条带时间戳的行为快照（进记忆，可被检索；同小时去重）
        writeBehaviorMemorySnapshot();
        if (cfg.socialV2?.reflection?.enabled === false) return;
        const st = readState();
        // [REFLECT] 重试优先：上一轮"没产出"会写 nextRunAt，到点就再喊一次
        //（不受窗口/冷却限制——窗口可能已过，这次是补做上次没干成的事）
        // [GOALS] 只补目标：上一轮经验写够了但一件目标都没有 → 单独补一次，不重做整套反思
        if (st.pendingGoals && Number(st.nextRunAt) > 0 && Date.now() >= Number(st.nextRunAt)) {
          const key = `private:${cfg.ownerQQ ?? ''}`;
          if (cfg.ownerQQ) {
            const prompt = '【补一件事】你现在手上没有任何在做的事。\n' +
              '用 goal_list 看一眼，然后用 goal_add 记一条你接下来想做的事。\n' +
              '小事也行（比如「把画世界的画补完」「把那家店问清楚」）。\n' +
              '只做这一件事，写完就结束，不用写经验，不用发消息。';
            await deliverToIsolated('reflect', prompt, { key, reason: 'goals-only' });
            const tries = Number(st.goalsTries) || 0;
            writeState({ ...st, pendingGoals: true, goalsTries: tries + 1, nextRunAt: 0, lastGoalsRunAt: Date.now() });
            log(`[goals] 单独补一次目标（第 ${tries + 1} 次）`);
            setTimeout(() => {
              try {
                const after = goalCount();
                const cur = readState();
                if (after > 0) {
                  writeState({ ...cur, pendingGoals: false, goalsTries: 0, nextRunAt: 0, lastResult: { ...(cur.lastResult || {}), goalsMoved: after, ok: true, reason: 'goals-only' } });
                  log(`[goals] 目标栈有内容了：${after} 件进行中`);
                } else {
                  writeState({ ...cur, pendingGoals: false, goalsTries: 0, nextRunAt: 0 });
                  log('[goals] 补了一次仍然没有目标，今天不再催（不硬塞目标给她）');
                }
              } catch (e) { log('[goals] 目标检查异常: ' + (e?.message ?? e)); }
            }, Math.max(5000, Number(cfg.socialV2?.reflection?.outcomeCheckMs) || 3 * 60 * 1000)).unref?.();
          }
          return;
        }
        const dueRetry = Number(st.nextRunAt) > 0 && Date.now() >= Number(st.nextRunAt);
        const decision = dueRetry
          ? { run: true, reason: `retry(${Number(st.retries) || 0})` }
          : reflectShouldRun(new Date(), st.lastRunAt ?? null, cfg.socialV2?.reflection ?? {});
        if (!decision.run) return;
        const key = `private:${cfg.ownerQQ ?? ''}`;
        if (!cfg.ownerQQ) return;
        const before = lessonCount();
        const goalCount = () => { try { return loadGoals(cfg.socialV2?.goals?.file).filter((x) => x.status === 'active').length; } catch { return 0; } };
        const beforeGoals = goalCount();
        const social = getSocialV2State(key);
        let prompt = buildReflectPrompt({
          date: new Date().toLocaleDateString('sv-SE'),
          lessonCount: before,
          recentCount: (social.recentMessages ?? []).length,
          memoryCount: memoryCount(),
        }, cfg.socialV2?.reflection ?? {});
        // [REFLECT-FEED] 反思只给数字（N 条经验）她只能凑数；喂「今天发生了什么」，
        // 反思才写得出来。全部确定性取材，不花模型钱。
        try {
          const day = new Date().toLocaleDateString('sv-SE');
          const parts = [];
          const drows = readJsonlSafe(path.join(cfg.socialV2?.memory?.dir || MEM_DIR, 'memory.jsonl'))
            .filter((r) => r?.kind === 'day-digest' && String(r.day) === day);
          if (drows.length) parts.push(`今天聊过的：${String(drows[drows.length - 1].text).slice(0, 160)}`);
          // [SEEN] 今天看到的东西（上网/帖子流/视频）：给事实，反思时可据此写经验，别让看过的白看。
          try {
            const seenRows = readJsonlSafe(path.join(cfg.socialV2?.memory?.dir || MEM_DIR, 'memory.jsonl'))
              .filter((r) => String(r?.day) === day && (r?.kind === 'browse' || (r?.kind === 'event' && r?.prov === 'video-watch')));
            if (seenRows.length) parts.push('今天看到的东西：\n' + seenRows.slice(-4).map((r) => `- ${String(r.text).slice(0, 100)}`).join('\n'));
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8631'); }
          // [HALF-FINISHED] 今天「干了一半 / 中断」的事（kind=event，比如"基建活干了一半"）：
          // 反思时她会看着这些决定哪些要接上，避免活掉在地上。
          const evrows = readJsonlSafe(path.join(cfg.socialV2?.memory?.dir || MEM_DIR, 'memory.jsonl'))
            .filter((r) => r?.kind === 'event' && String(r.day) === day && !String(r.text || '').includes('想自己待会儿'));
          const halfDone = evrows.filter((r) => /一半|没弄完|还没|卡住|掉线|接不|没领|没收|剩下的|中途/.test(String(r.text || '')));
          if (halfDone.length) parts.push(`今天没干完的事（${halfDone.length} 件）：\n` + halfDone.slice(0, 3).map((r) => `- ${String(r.text).slice(0, 60)}`).join('\n') + '\n——每件想想：接上去还是算了？接就 goal_add，算了就 goal_done 划掉，别让它悬着。');
          // [LEARN] 群学习素材：只取「别人」的话（她的自己的话永远不进学习材料——她不自学）
          try {
            const othersSamples = [];
            for (const gk of Object.keys(state.sessions ?? {})) {
              if (!String(gk).startsWith('group:')) continue;
              const gst = getSocialV2State(gk);
              const om = (gst.recentMessages ?? []).filter((m) => m && m.text && !m.isSelf);
              for (const m of om.slice(-4)) othersSamples.push(`[${String(gk).slice(6)}] ${m.sender ?? '某人'}：${String(m.text).slice(0, 40)}`);
            }
            if (othersSamples.length) parts.push('最近别人的话（不含你自己，学习只看这些）：\n' + othersSamples.slice(0, 8).join('\n'));
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8648'); }
          // [LEARN] 操作素材：卡住的段要给明细（app+步数+结果），反思才能逐段写成操作程序
          try {
            const trows = readJsonlSafe(path.join(stateDataPath('traces'), `${day}.jsonl`));
            const stuckRows = trows.filter((t) => t?.stuck);
            if (stuckRows.length) {
              parts.push('卡住的段：' + stuckRows.map((t) => `${t.app ?? '某app'}${(t.steps ?? []).length}步(${t.result ?? '?'})`).join('、') + ' ——每一段都写成一条操作程序（第四件事），别让卡住的段落白卡');
            } else if (trows.length) {
              parts.push(`今天手机上做了 ${trows.length} 段操作，没有卡住`);
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8658'); }
          const stale = loadLessons(cfg.socialV2?.lessons?.file).filter((l) => {
            const at = Date.parse(String(l.at || ''));
            const used = Date.parse(String(l.usedAt || ''));
            const cutoff = Date.now() - 30 * 86400000;
            return Number.isFinite(at) && at < cutoff && (!Number.isFinite(used) || used < cutoff);
          });
          if (stale.length) parts.push(`有 ${stale.length} 条经验 30 天没再用到（如：${stale.slice(0, 3).map((l) => String(l.text).slice(0, 24)).join('；')}）——它们还在库里不会被动，你只用判断哪天还会用上`);
          let evoRows = [];
          try {
            evoRows = fs.readFileSync(stateDataPath('evolution.jsonl'), 'utf8').split('\n').filter(Boolean)
              .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8670'); }
          const edits24 = evoRows.filter((r) => r.kind === 'code_edit' && Date.now() - Date.parse(r.at) < 86400000);
          if (edits24.length) parts.push(`最近 24 小时「你」被更新过 ${edits24.length} 处（${[...new Set(edits24.map((r) => String(r.file).split('/').pop()))].join('、')}），想想这些改动对怎么做事有什么用`);
          // [BEHAVIOR-LEDGER] 行为账：她今天实际干了什么（五处散账汇成一行事实，不评价）
          try {
            const ledger = renderBehaviorLedger({ day, now: new Date() });
            if (ledger) parts.push(ledger + '\n——账摆在这了，想「这些事为什么做、明天想做得不一样的地方在哪」；没账的日子不用硬想。');
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8677'); }
          const lifeLine = renderReflectLine(getLifeState()); // [LIFE] 生活状态喂料：说睡几次/说完又动/作息偏移（事实，不替她下结论）
          if (lifeLine) parts.push(lifeLine);
          // [LIFE-LOG-FEED] 生命线：今天实际收到/发出多少、睡过几次、反思/错误几次（确定性摘要，不花模型钱）
          try {
            const lifeSummary = typeof getLifeSummary === 'function' ? getLifeSummary() : '';
            if (lifeSummary) parts.push('今天的时间线：' + lifeSummary);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:life-log-feed'); }
          // [SLANG-JUDGE] 夜间反思也递词库判定队列（固定的安静槽位）：own-life 轮会被忙推延甚至整轮放弃
          // （2026-10-25 实测：积压 24 轮全忙），判定队列不能只挂在稀缺的独处轮上。
          // 同一纪律：事实+许可，不催不派活；判定权归她（qq_slang_judge）。
          try {
            const judgeLine = renderSlangJudgeLine(getSlangEntries(), cfg.slang?.judgeListMax ?? 8);
            if (judgeLine) parts.push(judgeLine);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8686'); }
          if (parts.length) prompt = prompt + '\n\n【今天发生的事（反思素材，别只写数字，写你想明白了什么）】\n' + parts.join('\n');
          // [LEARN-LOOP] 学习账本：黑话采用、经验完成率、技能结果，事实+许可，不派活
          try { prompt += '\n\n' + renderLearningDigest(summarizeLearning(7)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8689'); }
          // [FOCUS] 第四件产出：把今天压成四槽位重点块，白天好对焦。
          // 写不出就整块写「无」——没有就别编（和经验的"凑不够就少写"同一原则）。
          prompt += '\n\n【第四件事·重点提炼】\n看完今天发生的事，把你对焦的东西压成四行，写在最末尾的【FOCUS】块里（原样保留标记，块内四行，每行格式「槽位:一句话」，没有的就写「槽位:无」）：\n【FOCUS】\n他的要求:今天他说的话里真正在意的要求（最多1句）\n她承诺的:你答应过还没兑现的（最多1句）\n没做完的:今天干了一半/想干没干成的（最多1句）\n她留意到的:你今天留意到但没接话的（最多1句）\n【/FOCUS】\n——块外不要重复这四行；没有就整块只写四行「无」。';
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'reflection-service.mjs:8693'); }
        if (dueRetry) {
          // 重试时把要求说死：上次一条都没写，这次必须有产出
          prompt = '【补做】上一轮反思你一条都没写。\n' + prompt + '\n\n这次必须至少写 1 条（lesson_write），写完就结束。';
        }
        const delivered = await deliverToIsolated('reflect', prompt, { key, reason: dueRetry ? 'reflection-retry' : 'reflection' });
        // 记下本轮反思的会话 id：3 分钟后的产出检查只认这一轮的思考输出，
        // 否则会拿上一次独处回合的旧 thought 来冒充（串台 → 假成功）。
        const sessionId = String(delivered?.sessionId || '');
        // 新一轮（非补做）从零计今夜次数；补做沿用今夜计数。
        const nightRunsAtStart = dueRetry ? (Number(st.nightRuns) || 0) : 0;
        writeState({ ...st, lastRunAt: Date.now(), beforeCount: before, beforeGoals, lastResult: null, nextRunAt: 0, nightRuns: nightRunsAtStart, pendingSessionId: sessionId });
        noteRun({ kind: dueRetry ? 'retry' : 'run', before, beforeGoals, window: decision.reason, nightRuns: nightRunsAtStart });
        log(`[reflect] 已发起夜间反思（此前 ${before} 条经验，窗口 ${decision.reason}，今夜第 ${nightRunsAtStart + 1} 次）`);
        // 3 分钟后检查产出：没产出必须记失败，并按配置重试（不能当"叫过了就算"）
        setTimeout(() => {
          try {
            const after = lessonCount();
              const cur = readState();
              const thought = getLastThoughtTurn();
              // [THOUGHT-TRUTH] 把「本轮回合的思考输出」交给判据：她想了但没调用 lesson_write
              // 属于 thought-only（已想、收工、不重试），与 no-turn（回合根本没跑）严格区分。
              const r = checkReflectOutcome(before, after, {
                ...(cfg.socialV2?.reflection ?? {}),
                thought,
                sessionId: cur.pendingSessionId || null,
              });
              // [GOALS] 目标栈也算产出：一条经验都没写、目标也没动一下 → 这一轮等于没做
              const afterGoals = goalCount();
              const goalsMoved = afterGoals - (Number(cur.beforeGoals) || 0);
              const ok = r.ok || goalsMoved > 0;
              const settled = r.settled === true && !ok; // 想过了，但没写工具：不重试、不虚报
              const reason = r.ok ? r.reason : (goalsMoved > 0 ? 'goals+' + goalsMoved : r.reason);
              const tries = Number(cur.retries) || 0;
              const rawMax = Number(cfg.socialV2?.reflection?.maxRetries);
              const maxRetries = Number.isFinite(rawMax) ? rawMax : 2;
              const retryMs = Number(cfg.socialV2?.reflection?.retryAfterMs) || 10 * 60 * 1000;
              const summary = '经验 +' + r.added + ' / 目标 +' + goalsMoved;
              noteRun({
                kind: 'outcome', ok: ok || settled, added: r.added, goalsMoved, reason, tries, settled,
                thought: thought ? {
                  kind: thought.kind ?? '', len: thought.len ?? 0,
                  head: String(thought.head || '').slice(0, 120), sessionId: thought.sessionId || null,
                } : null,
              });
              // [REFLECT-LIFE-LOG] 结果回写生命线：成功写 completed（R7 可追溯 / Aliveness 成长维消费），
              // 失败写 failed（事故可回放能看见「反思整夜空转」，但绝不伪装成完成、不虚增成长分）。
              // 此前只记 reflection-runs.jsonl，生命线里零痕迹 → 成长维恒为 reflections=0。
              try {
                // thought-only 是真实发生过的反思（她输出了思考文本），计入 completed 但在 payload 里
                // 标明 thoughtOnly/added=0，绝不冒充"写了 lesson"；失败仍写 failed 供回放。
                appendLifeEvent({
                  type: (ok || settled) ? 'reflection.completed' : 'reflection.failed',
                  key,
                  payload: { added: r.added, goalsMoved, reason, tries, ok: ok || settled, thoughtOnly: settled },
                });
              } catch (error) { log(`[reflect] 生命线回写失败（已忽略）: ${error?.message ?? error}`); }
              if (settled) {
                // [THOUGHT-ONLY] 她想了，只是没调用 lesson_write：把原话留成事实账（不替她编 lesson），
                // 今夜收工不重试。旧口径在这里会一路重试到"今夜用尽"，18 次空转且成长维恒 0。
                try {
                  appendJsonl(stateDataPath('reflection-thoughts.jsonl'), {
                    at: new Date().toISOString(), sessionId: cur.pendingSessionId || null,
                    kind: r.thought?.kind || '', len: Number(r.thought?.len) || 0,
                    head: String(r.thought?.head || ''),
                  }, { source: 'bridge/reflection' });
                } catch (error) { log(`[reflect] 思考文本留存失败（已忽略）: ${error?.message ?? error}`); }
                writeState({ ...cur, retries: 0, goalsTries: 0, pendingGoals: false, nightRuns: 0, nextRunAt: 0, pendingSessionId: '', lastResult: { at: Date.now(), added: 0, goalsMoved, ok: true, reason: 'thought-only' } });
                log(`[reflect] 产出检查：${summary} → 她想过了（${r.thought?.len ?? 0} 字）但没写工具，收工不重试：${String(r.thought?.head || '').slice(0, 60)}`);
              } else if (ok) {
                // [REFLECT-INSIGHT] 认知层写端（用户拍板 b）：反思批达标后确定性沉淀洞见
                //（经验账 + 群倾向，零 LLM）——对话侧认知不再只靠手机 trace 那条路。
                if (cfg.socialV2?.reflection?.insights !== false) {
                  try {
                    const nIns = writeReflectInsight({ added: r.added, after, goalsMoved, ok: true, date: new Date().toLocaleDateString('sv-SE') });
                    log(nIns ? `[insight-reflect] 反思批沉淀洞见 ${nIns} 条` : '[insight-reflect] 反思批完成但沉淀 0 条（写端返回 0）');
                  } catch (error) {
                    // [INSIGHT-VIS] 以前静默 catch → 洞见永远是 0 条也没人知道；现在留痕
                    log(`[insight-reflect] 洞见写端失败（已忽略）: ${error?.message ?? error}`);
                  }
                } else {
                  log('[insight-reflect] 洞见写端已关闭（socialV2.reflection.insights=false）');
                }
                // [GOALS] 经验写够了但目标一件都没有 → 单独排一次补目标（不重做整套反思）
                const activeGoals = goalCount();
                const goalTries = Number(cur.goalsTries) || 0;
                const maxGoalTries = Number(cfg.socialV2?.reflection?.maxGoalsRetries) || 2;
                if (activeGoals === 0 && goalTries < maxGoalTries) {
                  const waitMs = Number(cfg.socialV2?.reflection?.retryAfterMs) || 10 * 60 * 1000;
                  writeState({
                    ...cur, retries: 0, goalsTries: goalTries, pendingGoals: true, nightRuns: 0,
                    nextRunAt: Date.now() + waitMs,
                    lastResult: { at: Date.now(), added: r.added, goalsMoved, ok: true, reason },
                  });
                  log(`[reflect] 产出检查：${summary} → 经验达标，但目标为 0，${Math.round(waitMs / 60000)} 分钟后单独补目标（第 ${goalTries + 1}/${maxGoalTries} 次）`);
                } else {
                  writeState({ ...cur, retries: 0, goalsTries: 0, pendingGoals: false, nightRuns: 0, nextRunAt: 0, lastResult: { at: Date.now(), added: r.added, goalsMoved, ok: true, reason } });
                  log(`[reflect] 产出检查：${summary} → 达标`);
                }
              } else if (tries < maxRetries) {
                writeState({
                  ...cur,
                  retries: tries + 1,
                  nextRunAt: Date.now() + retryMs,
                  lastResult: { at: Date.now(), added: r.added, goalsMoved, ok: false, reason },
                });
                log(`[reflect] 产出检查：${summary} → 未达标(${reason})，${Math.round(retryMs / 60000)} 分钟后重试 ${tries + 1}/${maxRetries}｜本轮回合 reason=${thought?.kind ?? '-'} 输出 ${thought?.len ?? 0} 字 session=${thought?.sessionId ?? '(无)'}：${thought?.head || '(空)'}${reason === 'no-turn' ? '｜注意：回合根本没跑完，多为 DSH/投递链路问题，别当成"她没想"' : ''}`);
              } else {
                // [REFLECT-KEEP-TRYING] 之前这里直接 nextRunAt=0「今天不再试」，于是 10-28 03:33
                // 三连空产出之后整晚没有反思、也没人知道。改成今夜再排一次（默认 1 小时后再试，
                // 上限 maxNightRuns 次），到上限才收工，并把原因留在 reflection-runs.jsonl。
                const nightRuns = Number(cur.nightRuns) || 0;
                const maxNightRuns = Math.max(2, Number(cfg.socialV2?.reflection?.maxNightRuns) || 6);
                const laterMs = Math.max(30 * 60 * 1000, Number(cfg.socialV2?.reflection?.retryLaterMs) || 60 * 60 * 1000);
                if (nightRuns + 1 < maxNightRuns) {
                  writeState({
                    ...cur,
                    retries: 0,
                    nightRuns: nightRuns + 1,
                    nextRunAt: Date.now() + laterMs,
                    lastResult: { at: Date.now(), added: r.added, goalsMoved, ok: false, reason: reason + '(稍后再试)' },
                  });
                  log(`[reflect] 产出检查：${summary} → 未达标(${reason})，${Math.round(laterMs / 60000)} 分钟后再试（今夜第 ${nightRuns + 1}/${maxNightRuns} 次）｜本轮回合 reason=${thought?.kind ?? '-'} 输出 ${thought?.len ?? 0} 字 session=${thought?.sessionId ?? '(无)'}：${thought?.head || '(空)'}`);
                } else {
                  writeState({ ...cur, retries: 0, nightRuns: 0, nextRunAt: 0, pendingSessionId: '', lastResult: { at: Date.now(), added: r.added, goalsMoved, ok: false, reason: reason + '(今夜用尽)' } });
                  log(`[reflect] 产出检查：${summary} → 未达标(${reason})，今夜 ${maxNightRuns} 次都没写成，明晚再来｜本轮回合 reason=${thought?.kind ?? '-'} 输出 ${thought?.len ?? 0} 字 session=${thought?.sessionId ?? '(无)'}：${thought?.head || '(空)'}`);
                }
              }
            } catch (error) { log('[reflect] 产出检查异常（不影响主流程）: ' + (error?.message ?? error)); }
        }, Math.max(5000, Number(cfg.socialV2?.reflection?.outcomeCheckMs) || 3 * 60 * 1000)).unref?.();
      } catch (error) {
        // [REFLECT-SEND-FAIL] 旧实现只打一行会被轮转掉的日志，DSH 未就绪时整晚发起失败
        // 却既无账本记录也无生命线事件（实测 11-03 静默空转）。这里把"没投出去"变成可查事实。
        const why = String(error?.message ?? error);
        log(`[reflect] 发起失败（已忽略）: ${why}`);
        try { noteRun({ kind: 'send-failed', ok: false, error: why.slice(0, 200) }); } catch (e) { void e; }
        try {
          appendLifeEvent({ type: 'reflection.failed', key: `private:${cfg.ownerQQ ?? ''}`, payload: { reason: 'send-failed', error: why.slice(0, 200) } });
        } catch (e) { void e; }
      }
    };
    tickRef = tick;
    // 启动 1 分钟后先看一次（若正处窗口内且冷却已过），之后每 10 分钟看一次
    setTimeout(tick, 60 * 1000).unref?.();
    setInterval(tick, 10 * 60 * 1000).unref?.();
  }
  try { startNightlyReflection(); } catch (error) { log(`[reflect] 定时器启动失败: ${error?.message ?? error}`); }


  return { startNightlyReflection, _tick: () => (tickRef ? tickRef() : Promise.resolve()) };
}
