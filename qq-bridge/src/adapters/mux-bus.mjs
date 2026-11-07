// mux-bus.mjs · pumpMux（从 app.mjs 的 main() 搬出，2026-10-28 M-1）
//
// 依赖通过最后一个参数 __deps 注入（app.mjs 用 getter/setter 活绑定），模块自身零 import、零状态。
export async function pumpMux(__deps) {

    for (;;) {
      try {
        __deps.log('连接 DSH 事件流…');
        for await (const envelope of __deps.api.events.mux({})) {
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            __deps.recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            __deps.recordSessionUsage(frame.sessionId, frame.event);
            // [REASONING] 收思考：turn/start 清缓冲，assistant/message 累积（A/B/C 在 turn/end 收尾）
            try { __deps.captureReasoning(frame.sessionId, frame.event); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:22'); }
            // [GATE] 统计活跃 turn（所有会话，含独立会话）：/api/console/handoff、玩手机等也算
            if (frame.event.type === 'turn/start') {
              // [SCHED] 记活跃回合 + 只消费属于这个会话的槽位令牌（两者都在调度器里成对完成）
              try { __deps.noteTurnStart(frame.sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:26'); }
              __deps.consumeTurnGrant(frame.sessionId);
              __deps.cancelTransientArchive(frame.sessionId);
            }
            if (frame.event.type === 'turn/end') {
              __deps.turnDispatch.finish(String(frame.sessionId)); // 空出槽位，按优先级派给等待者
              // [REASONING] 思考链收尾：摘要进 thoughts / 长思考留全文 / 失败回合留经验候选
              try {
                const tsR = __deps.turnToolStats.get(frame.sessionId);
                __deps.flushReasoning(frame.sessionId, { failed: Number(tsR?.fail) > 0 });
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:36'); }
              // [TRANSIENT-ARCHIVE] 临时会话用完后闲置归档；主聊天会话（有 key 的）不归档
              try {
                const sid = String(frame.sessionId);
                const transientKind = __deps.isolatedKindBySession.get(sid) || (__deps.learnerSessions.has(sid) ? 'slang' : null);
                if (transientKind) __deps.scheduleTransientArchive(sid, transientKind);
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:42'); }
              // [LESSON-EFFECT] 给这回合注入过的经验记一次结果（代理指标，可机检）
              try {
                const k2 = __deps.reverse.get(frame.sessionId);
                const pend = k2 ? __deps.lessonPendingByKey.get(k2) : null;
                if (pend && pend.length) {
                  __deps.fs.appendFileSync(__deps.stateDataPath('lesson-usage.jsonl'),
                    JSON.stringify({ at: new Date().toISOString(), key: k2, ids: pend.slice(0, 5), outcome: String(frame.event.data?.reason?.kind || 'unknown') }) + '\n', 'utf8');
                  __deps.lessonPendingByKey.delete(k2);
                  // [LESSON-TRUTH] 回合完成不再自动 upvote：注入过 ≠ 用对了。
                  // 经验只在 skill_verify / 主人明确验收后由 lesson_vote 手动投票。
                  try {
                    __deps.log(`[lessons] ${k2} 回合结束，只记 usage，不自动投票（outcome=${String(frame.event.data?.reason?.kind || 'unknown')}）`);
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:55'); }
                }
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:57'); }
              // [SCHEDULER] ownlife 回合结束 → 派发排队中的那一件（优先级由 drainOwnlifeQueue 决定）
              try {
                if (__deps.isolatedSessions.get('ownlife') === String(frame.sessionId)) __deps.drainOwnlifeQueue();
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:61'); }
              // [WAIT-LEASE] 回合结束就释放该会话的等待租约：上一回合已死（stale-turn/busy-watch 强杀都算），
              // 它挂着的长轮询（若还在等静默窗）不该再拿 15 分钟租约卡死下一回合的 qq_wait_for_messages——
              // 此前强杀后「锁一直卡着」的假死锁就是这么来的。残留 handler 最多跑到自己的 timeoutMs 上限。
              const wk = __deps.reverse.get(frame.sessionId);
              if (wk) __deps.activeWaits.delete(wk);

            }
            // [ISOLATED-REVIVE] blocked = 会话已被归档（DSH 的 archived-session-gate 直接拒绝这一步）
            if (frame.event.type === 'turn/end' && frame.event.data?.reason?.kind === 'blocked') {
              const deadKind = __deps.isolatedKindBySession.get(frame.sessionId);
              if (deadKind) {
                __deps.isolatedDead.add(deadKind);
                __deps.saveIsolatedDead();
                __deps.log(`[isolated] ${deadKind} 会话的回合被 blocked（会话已归档）→ 下次投递前重建`);
              }
            }
            const key = __deps.reverse.get(frame.sessionId);
            if (!key) {
              // [SEEN] 无 key 会话（own-life/任务/学习）的浏览也留痕：她"自己上网"主要发生在这里，
              // 以前这些会话的工具事件没人接，看过就蒸发。
              // [TOOL-USAGE] 无 key 会话（任务/own-life/学习）的工具调用也记日志：
              // 以前只记有 key 的会话，她 64% 的手机操作都发生在任务/独处会话里 → 使用画像全是盲区。
              if (frame.event.type === 'tool/call') {
                const nm0 = String(frame.event.data?.name ?? '');
                try { __deps.appendToolLog({ type: 'call', time: new Date().toISOString(), key: '', sessionId: frame.sessionId, tool: nm0, args: __deps.sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? '') }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:86'); }
              }
              if (frame.event.type === 'tool/call') {
                const nm = String(frame.event.data?.name ?? '');
                const cid = frame.event.data?.callId;
                if (cid != null) {
                  let m = __deps.noKeyToolNames.get(frame.sessionId);
                  if (!m) { m = new Map(); __deps.noKeyToolNames.set(frame.sessionId, m); }
                  m.set(String(cid), { name: nm, args: String(frame.event.data?.arguments ?? '').slice(0, 120) });
                }
              }
              if (frame.event.type === 'tool/result') {
                const cid = frame.event.data?.message?.source?.callId;
                const rec = cid != null ? __deps.noKeyToolNames.get(frame.sessionId)?.get(String(cid)) : null;
                const rb = frame.event.data?.message?.content?.[0];
                const err = frame.event.data?.message?.isError === true || rb?.isError === true;
                if (rec && !err && /web_search|web_fetch|browse_posts|feed_posts|bili_search|bili_comments|watch_video/i.test(rec.name)) {
                  try {
                    const head = String(rb?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
                    __deps.browseStore = __deps.noteBrowse(__deps.browseStore, __deps.newBrowseEntry({ tool: rec.name, arg: rec.args, head, ok: true }));
                    __deps.browseSave();
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:107'); }
                }
                try {
                  __deps.appendToolLog({ type: 'result', time: new Date().toISOString(), key: '', sessionId: frame.sessionId, tool: rec?.name ?? '', ok: !err, error: err ? __deps.sanitizeToolArgs(String(rb?.text ?? '').slice(0, 200)) : null });
                  if (err && rec?.name) __deps.noteToolFailure('', rec.name, String(rb?.text ?? ''));
                  if (err && rec?.name) __deps.autoTraceToolFailure('', rec.name, String(rb?.text ?? ''));
                  try { __deps.noteLiveToolResult('', rec?.name || '', err ? String(rb?.text ?? '') : '', frame.sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:113'); }
                  if (err) { try { __deps.noteDeviceFailure(frame.sessionId, String(rb?.text ?? '')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:114'); } }
                } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:115'); }
                if (!err && rec?.name) { try { __deps.resolveToolFailure('', rec.name); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:116'); } }
                if (cid != null) __deps.noKeyToolNames.get(frame.sessionId)?.delete(String(cid));
              }
              // [TASK-LEDGER] 任务会话收尾：回写台账（完成/失败）
              if (__deps.taskSessions.has(frame.sessionId)) {
                const kc = __deps.taskCollectors.get(frame.sessionId) ?? __deps.createTurnCollector();
                __deps.taskCollectors.set(frame.sessionId, kc);
                const kEnded = kc.push(frame.event);
                if (kEnded) {
                  __deps.taskCollectors.delete(frame.sessionId);
                  __deps.taskSessions.delete(frame.sessionId);
                  const turnCompleted = kEnded.reason.kind === 'completed';
                  const fullText = String(kEnded.text || '').trim();
                  const note = fullText.slice(0, 300);
                  const parsed = (__deps.parseTaskResult && __deps.parseTaskResult(fullText)) || null;
                  // [TASK-POOL] 一任务一会话：优先按池里的 taskId 精确回写；找不到退回按 sessionId
                  const poolEntry = __deps.taskPoolRunning.find((x) => x.sessionId === frame.sessionId);
                  // [WORK-BRIDGE] 分身工作台已经用 work_update(done, 证据) 收尾时，
                  // 即使最终文本没写【任务结果】行，也把工作台的证据接进任务台账。
                  // [TASK-TRUTH] 没有显式结果行 = unknown；turn completed 只说明它把话说完了，不说明做成了。
                  let outcome = parsed?.outcome || (turnCompleted ? 'unknown' : 'failed');
                  let evidence = parsed?.evidence || '';
                  let nextAction = parsed?.nextAction || '';
                  try {
                    const wPre = __deps.workByTaskId(poolEntry?.taskId || '');
                    if (wPre && String(wPre.status) === String(__deps.WORK_STATUS?.DONE || 'done')) {
                      const last = (Array.isArray(wPre.progress) ? wPre.progress : []).slice(-1)[0]?.note || '';
                      // 工作台已 done：补证据；如果最终文本没写结果行，直接认 success。
                      if (last && !evidence) evidence = last;
                      if (last && (!parsed || outcome === 'unknown')) outcome = 'success';
                    }
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:147'); }
                  // [TASK-ACCEPT] acceptance 里有可机检的 文件:/网址: 时，收尾前跑一次；
                  // 不能机检的散文判据跳过，不假装验过。
                  if (outcome === 'success') {
                    try {
                      const acc = String(poolEntry?.acceptance || '').trim();
                      if (acc && typeof __deps.checkVerify === 'function') {
                        const v = await __deps.checkVerify(acc, { allowCommand: false, timeoutMs: 5000 });
                        if (v && v.ok === false) {
                          outcome = 'blocked';
                          nextAction = `验收没过：${String(v.evidence || '机器判据失败').slice(0, 160)}`;
                          evidence = String(v.evidence || evidence || '').slice(0, 300);
                        } else if (v && v.ok === true && !evidence) {
                          evidence = String(v.evidence || '机器验收通过').slice(0, 300);
                        }
                      }
                    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:163'); }
                  }
                  const res = __deps.finishTask(poolEntry?.taskId || '', {
                    outcome, note, evidence, nextAction, bySessionId: frame.sessionId,
                  });
                  const ok = outcome === 'success';
                  if (res.row) __deps.log(`[task-ledger] ${ok ? '完成' : (outcome === 'blocked' ? '卡住' : '未完成')}：${String(res.row.task || '').slice(0, 40)}${note ? '｜' + note.slice(0, 40) : ''}`);
                  // [TRACE-BRIDGE] 有证据的成功任务进经验轨迹池；失败/未知只留台账，不伪造成功轨迹。
                  try {
                    if (ok && res.row) {
                      __deps.appendTrace({
                        goal: String(res.row.task || '').slice(0, 120),
                        steps: [String(note || '').slice(0, 120)],
                        result: 'success',
                        note: `任务证据：${String(evidence || '').slice(0, 240)}`,
                        scope: String(poolEntry?.reportTo || res.row.reportTo || ''),
                      });
                    }
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:181'); }
                  if (res.row) __deps.notifyTaskDone(poolEntry?.reportTo || res.row.reportTo, poolEntry?.taskShort || res.row.task, note, ok);
                  // [WORKS] 分身收尾：工作台标记终态（进度已由 worker 的 work_update/work_note 写入）
                  try {
                    const w = __deps.workByTaskId(poolEntry?.taskId || res.row?.id);
                    if (w) {
                      const summary = __deps.summarizeWorkerText(kEnded.text, 120);
                      __deps.updateWorkById(w.id, (cur) => {
                        let next = cur;
                        if (summary) next = __deps.addProgress(next, summary);
                        if (nextAction) next = __deps.addProgress(next, `下一步：${nextAction}`);
                        next = __deps.setWorkStatus(next, ok ? __deps.WORK_STATUS.DONE : __deps.WORK_STATUS.FAILED);
                        return next;
                      });
                    }
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:196'); }
                  // 收尾即归档并 drain 队列：只要这个会话还在池里就退掉。
                  // 不能只看 res.idempotent——台账被外部过期（撤单/判死）时回写是空操作，
                  // 但会话本身仍要归档，否则它会永远占着池槽（实测 2026-10-25 验证任务时踩到）。
                  if (__deps.taskPoolRunning.some((x) => x.sessionId === frame.sessionId)) {
                    void __deps.retireTaskSession(frame.sessionId).catch((e) => globalThis.__ignoredCatch?.(e, 'src/adapters/mux-bus.mjs:201'));
                  }
                }
              }
              // [THOUGHTS] 独处/反思回合：抽取她自己的念头存盘（不发 QQ）
              if (__deps.thoughtSessions.has(frame.sessionId)) {
                const tc = __deps.thoughtCollectors.get(frame.sessionId) ?? __deps.createTurnCollector();
                __deps.thoughtCollectors.set(frame.sessionId, tc);
                const tEnded = tc.push(frame.event);
                if (tEnded) {
                  __deps.thoughtCollectors.delete(frame.sessionId);
                  __deps.thoughtSessions.delete(frame.sessionId);
                  // [REFLECT-DIAG] 先把本轮结果记下来：通不通过都给 3 分钟后那次产出检查一个可查的原因
                  const tText = String(tEnded.text || '').trim();
                  // [THOUGHT-SESSION-ID] 带上 sessionId，产出检查才能确认「这一条是本轮反思的」，
                  // 而不是拿别的独处回合的旧结果来冒充（串台会让 thought-only 误判成成功）。
                  __deps.lastThoughtTurn = { at: Date.now(), sessionId: String(frame.sessionId), kind: tEnded.reason.kind, len: [...tText].length, head: tText.replace(/\s+/g, ' ').slice(0, 80) };
                  if (!(tEnded.reason.kind === 'completed' && tText)) {
                    __deps.log(`[reflect] 反思回合没产出（reason=${tEnded.reason.kind}，${[...tText].length} 字）：${tText.slice(0, 80) || '(空)'}`);
                    try { __deps.logAction({ t: 'reflect', made: false, why: `no-output:${tEnded.reason.kind}`, len: [...tText].length }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:218'); }
                  }
                  if (tEnded.reason.kind === 'completed' && String(tEnded.text || '').trim()) {
                    // [FOCUS] 反思轮的产出里若带【FOCUS】块 → 落盘 state/focus.json（白天注入用）
                    try {
                      const f = __deps.parseFocusBlock(tEnded.text);
                      if (f) {
                        const n = __deps.saveFocusBlock(f);
                        __deps.log(`[focus] 重点块已存（${n} 槽）：${__deps.FOCUS_SLOTS.filter((s) => f[s]).map((s) => `${__deps.FOCUS_SLOT_CN[s]}=${f[s].slice(0, 20)}`).join(' | ')}`);
                      } else {
                        // [FOCUS-MISS] 反思轮要求写【FOCUS】块但没写：记一笔（白天注入仍会展示旧重点段，
                        // 不替她编；只暴露产出缺失，便于知道哪轮反思没对焦）
                        __deps.log(`[focus] 本轮反思没有【FOCUS】块（重点段保持上一轮内容）`);
                      }
                    } catch (fe) { __deps.log(`[focus] 解析失败（不影响反思）: ${fe?.message ?? fe}`); }
                    const reflectLines = __deps.extractThoughtLines(tEnded.text, 3);
                    // [SELF-THREAD] 只取 reflect 结果的第一句作为“刚才在想的事”，
                    // 不拿 reasoning（工具推演摘要）冒充；kernel 不在时 emit 是 no-op。
                    if (reflectLines.length) {
                      try { __deps.emitSelfThread?.(reflectLines[0], Date.now()); } catch (error) { /* best-effort */ }
                    }
                    for (const line of reflectLines) {
                      // 先数「以前出现过几次」，再记这一次：appendThought 会去重完全相同的句子
                      const prior = __deps.similarThoughtCount(line);
                      const row = __deps.appendThought('reflect', line);
                      if (!row) continue;
                      __deps.log(`[thoughts] 记下：${line.slice(0, 50)}`);
                      // [GOAL-IDEA] 同一念头反复出现（≥2 次）→ 记成目标候选，唤醒时提醒她
                      if (prior + 1 >= 2) {
                        const idea = __deps.addGoalIdea(line);
                        if (idea) __deps.log(`[goal-idea] 反复想到：${line.slice(0, 40)}（含这次共 ${prior + 1} 次）`);
                      }
                    }
                  }
                }
              }
              // [VISION] 看图会话：收集 turn，唤醒 /api/console/vision 的等待者（不发 QQ）。
              // [DIARY] 日记会话：捕获她写完的一篇日记，直接落盘（不受 diary_write 300 字限制）
              if (__deps.diarySessions.has(frame.sessionId)) {
                if (frame.event.type === 'turn/start' || frame.event.type === 'turn/end') __deps.log(`[diary-debug] ${frame.event.type} turn=${String(frame.event.data?.turn ?? '?').slice(0,8)} ${String(frame.sessionId).slice(0, 18)}`);
                const dDay = __deps.diarySessions.get(frame.sessionId);
                const dc = __deps.thoughtCollectors.get(frame.sessionId) ?? __deps.createTurnCollector();
                __deps.thoughtCollectors.set(frame.sessionId, dc);
                const dEnded = dc.push(frame.event);
                if (dEnded) {
                  __deps.thoughtCollectors.delete(frame.sessionId);
                  __deps.diarySessions.delete(frame.sessionId);
                  const dText = String(dEnded.text || '').trim();
                  if (dEnded.reason.kind === 'completed' && dText.length >= 50) {
                    __deps.appendDailyDiary(dDay, dText);
                    __deps.log(`[diary] ${dDay} 的日记已写好（${dText.length} 字，已存盘 + 桌面同步）`);
                  } else {
                    __deps.log(`[diary] ${dDay} 的日记会话没产出（reason=${dEnded.reason.kind}，${dText.length} 字）：${dText.slice(0, 100).replace(/\s+/g, ' ') || '(空)'}`);
                    __deps.logAction({ t: 'diary', day: dDay, made: false, why: `no-output:${dEnded.reason.kind}` });
                    // [ISOLATED-REVIVE] 会话被归档 → 桥接先把 blocked 标死，这里主动换新会话重试一次（每天最多 2 次）。
                    // 会话被归档的那次没跑到模型：退掉这次额度，好让换新会话的重试不算超限
                    if (dEnded.reason.kind === 'blocked') __deps.dropDiaryAttempt(dDay);
                    if (dEnded.reason.kind === 'blocked' && __deps.diaryAttempts(dDay) < 2) {
                      __deps.log(`[diary] ${dDay} 的会话已被归档，5 秒后换新会话重试`);
                      setTimeout(() => {
                        const today2 = new Date().toLocaleDateString('sv-SE');
                        void __deps.startDiarySession(dDay === today2 ? undefined : dDay, { force: __deps.diaryForcedDays.has(dDay) }).catch((error) => __deps.log(`[diary] 重试失败: ${error?.message ?? error}`));
                      }, 5000);
                    }
                  }
                }
              }
              // [VISION-SERVICE] 看图会话的事件由服务自主消费（collector/等待者/超时清理都在服务里）
              __deps.vision.handleEvent(frame);
              // [GROUP-FACTS-LLM] 群事实抽取回合：收集完整文本后交给等待者
              if (__deps.groupFactSessions.has(frame.sessionId)) {
                const fc = __deps.groupFactCollectors.get(frame.sessionId) ?? __deps.createTurnCollector();
                __deps.groupFactCollectors.set(frame.sessionId, fc);
                const fEnded = fc.push(frame.event);
                if (fEnded) {
                  __deps.groupFactCollectors.delete(frame.sessionId);
                  __deps.groupFactSessions.delete(frame.sessionId);
                  const waiters = __deps.groupFactWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) __deps.groupFactWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (fEnded.reason.kind === 'completed' && fEnded.text.trim()) waiter.resolve(fEnded.text);
                    else waiter.reject(new Error(`群事实 turn 未完成：${fEnded.reason.kind}`));
                  }
                }
              }
              // [GATE] 注意门精判会话：拿回判定 JSON，命中→topicMention 唤醒她；漏网→留门日志（不发 QQ）
              if (__deps.gateSessions.has(frame.sessionId)) {
                if (frame.event.type === 'turn/start' || frame.event.type === 'turn/end') __deps.log(`[gate-debug] ${frame.event.type} turn=${String(frame.event.data?.turn ?? '?').slice(0, 8)} ${String(frame.sessionId).slice(0, 18)}`);
                const gCollector = __deps.gateCollectors.get(frame.sessionId) ?? __deps.createTurnCollector();
                __deps.gateCollectors.set(frame.sessionId, gCollector);
                const gEnded = gCollector.push(frame.event);
                if (gEnded) {
                  __deps.gateCollectors.delete(frame.sessionId);
                  __deps.gateSessions.delete(frame.sessionId);
                  const gBatch = __deps.gateBatches.get(frame.sessionId) ?? null;
                  __deps.gateBatches.delete(frame.sessionId);
                  const { hits } = __deps.parseGateReply(gEnded.text);
                  if (gBatch?.key) {
                    __deps.applyGateHits({ key: gBatch.key, msgs: gBatch.msgs, hits, raw: gEnded.text, source: 'flash' });
                  } else {
                    __deps.appendGateLog({ key: null, stage: 2, completed: gEnded.reason.kind === 'completed', hits: hits.length, raw: String(gEnded.text ?? '').slice(0, 240) });
                  }
                }
              }
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (__deps.learnerSessions.has(frame.sessionId)) {
                const learnerCollector = __deps.learnerCollectors.get(frame.sessionId) ?? __deps.createTurnCollector();
                __deps.learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  __deps.learnerCollectors.delete(frame.sessionId);
                  const waiters = __deps.learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) __deps.learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      // [LEARNER-DIAG] 把 DSH 给的 reason 全文打出来——之前只打 kind，
                      // 报错原因不可见导致学习管线故障一直定位不了。
                      const why = JSON.stringify(learnerEnded.reason ?? {}).slice(0, 400);
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}；reason=${why}；textLen=${learnerEnded.text.length}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== __deps.slangLearnerSessionId) __deps.learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!__deps.isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              __deps.sendToolSucceededSessions.delete(frame.sessionId);
              __deps.pendingSendToolCalls.delete(frame.sessionId);
              __deps.v2TurnStartAt.set(frame.sessionId, Date.now());
              // [CONCURRENCY] 记录 turn 开始时刻：用来判断多个会话是否真的能同时跑
              __deps.log(`[turn] start ${key} session=${String(frame.sessionId).slice(0, 16)} turn=${frame.event.data?.turn ?? '?'} at=${new Date().toISOString().slice(11, 23)}`);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const rawArgs = __deps.sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              // [ACTIVITY-FIX] tool/call 事件的参数有时是 JSON 字符串（tool log 里 "args":"{\"x\":2050,...}"），
              // 不解析的话轨迹步骤全没坐标 → 洞见层全废（(未知)(undefined,undefined) 就是这么来的）
              const args = (typeof rawArgs === 'string') ? (() => { try { return JSON.parse(rawArgs); } catch { return rawArgs; } })() : rawArgs;
              __deps.appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args: rawArgs });
              try {
                let ts = __deps.turnToolStats.get(frame.sessionId);
                if (!ts) { ts = { ok: 0, fail: 0, names: new Set() }; __deps.turnToolStats.set(frame.sessionId, ts); }
                ts.names.add(toolName);
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:367'); }
              // [P1] 好奇刺激：她的主动探索行为（搜索/抓取/刷视频/翻词/挂心/工坊造东西）给好奇生理量充电。
              // 她自己发起的探索算她的兴趣（不限 owner 会话——群里刷到也挂心）。
              // [STARVE-FIX] 记下她最后一次动手机的时刻（own-life 用它判断"她真的正忙"）
              if (/^mcp__phone__|^phone_/.test(toolName)) __deps.lastPhoneOpAt = Date.now();
              if (/web_search|web_fetch|video_feed|video_watch|qq_curiosity|qq_workshop|phone/.test(toolName)) {
                try { __deps.lifeState = __deps.markCuriosityStimulus(__deps.lifeState, 0.6, Date.now()); __deps.saveLifeFile(__deps.lifeState); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:373'); }
              }
              // [ACTIVITY] 她操作手机时自动记轨迹（不靠她调 trace_log——实测 0 次）
              if (__deps.isPhoneTool(toolName)) {
                try { __deps.activityTracker.record(key, toolName, args, true); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:377'); }
              }
              if (callId != null) {
                if (__deps.isSendToolName(toolName)) {
                  let pending = __deps.pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    __deps.pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                // [WAIT-HOLD] 记下在跑的 qq_wait_for_messages：看门狗据此把「等待时间」从 turnMaxMs 里扣掉。
                if (/qq_wait_for_messages/.test(toolName)) {
                  let wset = __deps.waitToolCalls.get(frame.sessionId);
                  if (!wset) {
                    wset = new Set();
                    __deps.waitToolCalls.set(frame.sessionId, wset);
                  }
                  if (wset.size === 0) __deps.waitStartAt.set(frame.sessionId, Date.now());
                  wset.add(String(callId));
                }
                let nameMap = __deps.toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  __deps.toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
                const argMap = __deps.toolCallArgs.get(frame.sessionId) ?? new Map();
                __deps.toolCallArgs.set(frame.sessionId, argMap);
                argMap.set(String(callId), rawArgs);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (__deps.toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? __deps.errToText(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              try {
                const ts = __deps.turnToolStats.get(frame.sessionId);
                if (ts) {
                  if (resultError) { ts.fail += 1; ts.lastError = String(errorText ?? '').slice(0, 160); }
                  else ts.ok += 1;
                }
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:421'); }
              if (!resultError && toolName) { try { __deps.resolveToolFailure(key, toolName); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:422'); } }
              __deps.appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? __deps.sanitizeToolArgs(errorText) : null
              });
              if (resultError && toolName) {
                // [AUTO-TRACE] 工具失败自动留痕：失败点是「换法学习」的数据来源，不靠她自觉
                try { __deps.noteToolFailure(key, toolName, errorText); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:434'); }
                try { __deps.autoTraceToolFailure(key, toolName, errorText); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:435'); }
              }
              try { __deps.noteLiveToolResult(key, toolName, errorText, frame.sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:437'); }
              // [BROWSE] 她上网搜/读成功 → 记一笔（own-life 前沉淀成记忆；不催不评）
              // [BROWSE-SEEN] 她上网搜/读/逛帖子/看帖子流成功 → 记一笔（own-life 前沉淀成记忆；不催不评）。
              // 以前只记 web_search/web_fetch，browse_posts/feed_posts 看过就蒸发（只充了好奇值）。
              if (!resultError && callId != null && /web_search|web_fetch|browse_posts|feed_posts|bili_search|bili_comments|watch_video/i.test(toolName)) {
                try {
                  const rawArg = __deps.toolCallArgs.get(frame.sessionId)?.get(String(callId)) ?? '';
                  const headText = String(resultBlock?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
                  __deps.browseStore = __deps.noteBrowse(__deps.browseStore, __deps.newBrowseEntry({ tool: toolName, arg: String(rawArg).slice(0, 120), head: headText, ok: true }));
                  try {
                    let hs = __deps.turnSeenHeads.get(key);
                    if (!hs) { hs = []; __deps.turnSeenHeads.set(key, hs); }
                    if (headText) hs.push(`${toolName}: ${headText}`);
                    if (hs.length > 3) hs.splice(0, hs.length - 3);
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:451'); }
                  __deps.browseSave();
                  // [BROWSE-LEARN] 逛帖子/读到的别人的正文 → 抽高频词当黑话候选（学习材料只来自别人的话）
                  try {
                    if (/browse_posts|feed_posts|web_fetch|bili_search|bili_comments|watch_video/i.test(toolName)) {
                      const full = String(resultBlock?.text ?? '').replace(/\r/g, ' ').slice(0, 3400); // [BROWSE-LEARN] 帖子现在带评论区，截断放宽到 3400
                      if (full) {
                        __deps.browseLearnWindow.push(full);
                        if (__deps.browseLearnWindow.length > 30) __deps.browseLearnWindow.shift();
                        const known = new Set([
                          ...__deps.slangEntries.filter((e) => e.status === 'confirmed').map((e) => String(e.content || '')),
                          ...__deps.loadLessons(__deps.cfg.socialV2?.lessons?.file).map((l) => String(l.text || '')),
                        ]);
                        const terms = __deps.extractTerms(__deps.browseLearnWindow, { known, maxTerms: 4 });
                        if (terms.length) {
                          for (const term of terms) {
                            try { __deps.upsertSlangEntry(__deps.slangEntries, term, { source: 'browse', countIncrement: 1 }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:467'); }
                          }
                          __deps.saveSlang(__deps.SLANG_FILE, __deps.slangEntries);
                          __deps.log(`[browse-learn] 从浏览正文抽到候选：${terms.join(' / ')}`);
                        }
                      }
                    }
                  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:474'); }
                } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:475'); }
              }
              if (callId != null) {
                __deps.toolCallNames.get(frame.sessionId)?.delete(String(callId));
                // [WAIT-HOLD] 等待结束：把这一段等待时长累加进本回合的「不计时额度」。
                const wset = __deps.waitToolCalls.get(frame.sessionId);
                if (wset?.delete(String(callId)) && wset.size === 0) {
                  const startedAt = Number(__deps.waitStartAt.get(frame.sessionId)) || 0;
                  if (startedAt > 0) {
                    const prev = Number(__deps.turnWaitMs.get(frame.sessionId)) || 0;
                    __deps.turnWaitMs.set(frame.sessionId, prev + Math.max(0, Date.now() - startedAt));
                  }
                  __deps.waitStartAt.delete(frame.sessionId);
                  __deps.waitToolCalls.delete(frame.sessionId);
                }
                const pending = __deps.pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) __deps.pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    __deps.sendToolSucceededSessions.add(frame.sessionId);
                    // [LIFE-SENT] 发送工具成功 = 她真的往世界里说了话；落生命线供离线叙事/指标用。
                    try { __deps.noteLifeSent?.(key, toolName); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:life-sent'); }
                  }
                }
              }
            }
            const collector = __deps.collectors.get(frame.sessionId) ?? __deps.createTurnCollector();
            __deps.collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
            // [GHOST-END] 只收到 turn/end、没见过 turn/start（follow 流中途重开/单帧丢失/
            // 桥接启动时回合已在跑）时 collector 返回 null。旧实现把 v2TurnStartAt.delete
            // 和 collectors.delete 全锁在 if (ended) 里，于是该会话永久 busy，
            // 所有唤醒只进 pendingWakeReasons，@ 也不回，只能等 15 分钟 busy-cap。
            if (!ended && frame.event?.type === 'turn/end') {
              __deps.v2TurnStartAt.delete(frame.sessionId);
              __deps.collectors.delete(frame.sessionId);
              if (key) {
                __deps.pendingWakeKeys.delete(key);
                try { __deps.disarmPendingWakeLease?.(key); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:ghost-end'); }
              }
              __deps.log(`[turn-end] ${key || frame.sessionId} 收到无 turn/start 的收尾（事件可能丢失），已清理 busy 标记`);
            }
            if (ended) {
              // [TOOL-LEARN] 工具与学习：自动把这一回合的工具成败变成经验/技能反馈（不依赖她自觉）
              try { void __deps.applyTurnToolLearning(key, frame.sessionId, ended).catch((e) => globalThis.__ignoredCatch?.(e, 'src/adapters/mux-bus.mjs:528')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:505'); }
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = __deps.social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (__deps.currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = __deps.getSocialV2State(key);
                const turnStart = __deps.v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = __deps.sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(__deps.cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    __deps.log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = __deps.defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                __deps.logAction({
                  t: 'turn',
                  key,
                  trigger: st.lastWakeReason || null,
                  outcome: __deps.sendToolSucceededSessions.has(frame.sessionId) ? 'sent'
                    : (actionTaken ? 'closed' : (String(ended.text || '').trim() ? 'wrote_not_sent' : 'no_action')),
                  thoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.length : 0,
                  ms: turnStart > 0 ? Date.now() - turnStart : null,
                }); // [ACTION-LOG] 回合收尾：为什么醒 + 她做了什么（纯观察，零约束）
                __deps.saveSocialV2State();
              }
              __deps.v2TurnStartAt.delete(frame.sessionId);
              // [AT-SPLIT] 这个群的回合收尾 → 还有待回的 @ 就隔几秒派下一条（真开口了才出队）
              try {
                if (key && String(key).startsWith('group:')) __deps.scheduleNextAtSplit(key, { replied: __deps.sendToolSucceededSessions.has(frame.sessionId) });
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:541'); }
              __deps.collectors.delete(frame.sessionId);
              // [SESSION-ROTATE] 记这个 key 自上次换会话以来跑了多少回合（只在唤醒间隙轮换，不打断在跑的回合）。
              try {
                if (String(frame.sessionId) === String(__deps.state.sessions[key] ?? '')) {
                  const stRot = __deps.getSocialV2State(key);
                  stRot.sessionTurns = (Number(stRot.sessionTurns) || 0) + 1;
                }
              } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:549'); }
              const sendToolSucceeded = __deps.sendToolSucceededSessions.has(frame.sessionId);
              // [NO-SEND] 写了文本但没调用发送工具：reserved2 下文本不会自动发出，对方看不到。
              // 不自动补发（避免把思考内容发出去），只记一条提示，下次唤醒提醒她补发。
              if (__deps.currentMode === 'reserved2' && key && !sendToolSucceeded
                && ended.reason.kind === 'completed' && String(ended.text || '').trim()
                && silentQueueNow.length === 0) {
                try {
                  const stNS = __deps.getSocialV2State(key);
                  const t = String(ended.text).trim().slice(0, 200);
                  // [UNSENT] 单槽覆盖前的抢救：旧提示若已过期（>10min），先沉底再让位，
                  // 否则它只留在 bridge.log 里、下一轮直接被冲掉（旧版本就是"过期即遗忘"）。
                  const prevExpired = __deps.takeExpiredHint(stNS.noSendHint, Date.now());
                  if (prevExpired) __deps.sinkUnsentHint(prevExpired.text, prevExpired.at, key);
                  stNS.noSendHint = { text: t, at: Date.now() };
                  __deps.saveSocialV2State();
                  __deps.log(`[no-send] ${key} 本轮只写文字、没调用发送工具（${t.length} 字）；10 分钟内下次唤醒才注入补发提醒，过期后短句会沉底进挂心事（长旁白只留日志）`);
                } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:566'); }
              }
              __deps.sendToolSucceededSessions.delete(frame.sessionId);
              __deps.pendingSendToolCalls.delete(frame.sessionId);
              __deps.toolCallNames.delete(frame.sessionId);
              // [WAIT-HOLD] 回合收尾清掉等待计时，下一轮从零开始。
              __deps.waitToolCalls.delete(frame.sessionId);
              __deps.waitStartAt.delete(frame.sessionId);
              __deps.turnWaitMs.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = __deps.social.exitingSessions.has(frame.sessionId);
              if (isFarewell) __deps.social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = __deps.social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > __deps.SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) __deps.social.silentTurns.set(frame.sessionId, silentQueue);
                else __deps.social.silentTurns.delete(frame.sessionId);
                __deps.log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (__deps.pendingWakeKeys.has(key)) {
                __deps.pendingWakeKeys.delete(key);
                __deps.disarmPendingWakeLease(key);
                if (__deps.wakeConfigUpdatedKeys.has(key) || __deps.markReadCalledKeys.has(key)) {
                  __deps.ensureWakeableV2(__deps.getSocialV2State(key), { key });
                  __deps.wakeConfigUpdatedKeys.delete(key);
                  __deps.markReadCalledKeys.delete(key);
                  __deps.wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (__deps.wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(__deps.cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    __deps.wakeConfigMissCount.set(key, currentMiss);
                    __deps.pendingWakeKeys.add(key);
                    __deps.armPendingWakeLease(key);
                    __deps.deliverPrompt(key, __deps.buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        __deps.pendingWakeKeys.delete(key);
                        __deps.disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      __deps.pendingWakeKeys.delete(key);
                      __deps.disarmPendingWakeLease(key);
                      __deps.log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    __deps.log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = __deps.getSocialV2State(key);
                    st.wakeConfig = __deps.defaultWakeConfigV2();
                    __deps.saveSocialV2State();
                    __deps.log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // [ACTIVITY] 一轮结束收尾活动轨迹：产出 trace + 洞见（写 data/state/traces + insights）
              try {
                const done = __deps.activityTracker.finish(key, 'turn_end');
                if (done) {
                  __deps.log(`[activity] ${done.app} 记下 ${done.steps.length} 步${done.stuck ? '（有卡住）' : ''} → trace`);
                  // [SKILL-OPT] 把这次结果反馈给技能库：失败写改进点+降置信度，成功升置信度
                  try {
                    const skFile = __deps.stateDataPath('skills.json');
                    const sj = JSON.parse(__deps.fs.readFileSync(skFile, 'utf8'));
                    const r = __deps.optimizeSkill(sj, {
                      app: done.app || '',
                      goal: '',
                      stuck: !!done.stuck,
                      steps: (done.steps || []).length,
                    });
                    if (r.changed) {
                      // 走 inori-skills.save 的原子写（tmp+rename，与其它 skills 写点同一纪律）
                      __deps.saveSkills(sj, skFile);
                      __deps.log(`[skill-opt] ${r.note}`);
                    }
                  } catch (error) { __deps.log(`[skill-opt] 优化失败（忽略）: ${error?.message ?? error}`); }
                  // [GOAL-FOLLOWUP] 干到一半卡住的事不掉地上：自动记一条"手头的事"，她下次被唤醒会看到并接着做
                  try {
                    if (done.stuck && (done.steps || []).length >= 5) {
                      // [GOAL-FOLLOWUP-FIX] 旧版用 `if (gfile)` 门（gfile=cfg.socialV2?.goals?.file）：
                      // config 没有 goals 段时门永远不成立 → 卡住的活永远进不了目标栈。
                      // loadGoals/saveGoals 传 undefined 时走模块默认文件（和其它调用点一致）。
                      const gfile = __deps.cfg.socialV2?.goals?.file;
                      {
                        const gs = __deps.loadGoals(gfile);
                        const r2 = __deps.addGoalRow(gs, `接着做：刚才在「${done.app}」里卡住了（反复试没进展），换个方法，或问他要一句提示。`);
                        if (r2.ok) { __deps.saveGoals(gs, gfile); __deps.log(`[goal] 任务卡住 → 记入手头：${r2.goal.text.slice(0, 40)}`); }
                        // [RUMINATE] 没做成的事会惦记（来源③）：任务失败 → 余温
                        try { __deps.addRumination({ core: `在「${done.app}」里卡住了，没做成`, intensity: 0.6, source: 'task-failed', key: 'phone', at: Date.now() }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:659'); }
                      }
                    }
                  } catch (error) { __deps.log(`[goal] 卡住跟进失败（忽略）: ${error?.message ?? error}`); }
                }
              } catch (error) { __deps.log(`[activity] 收尾失败（忽略）: ${error?.message ?? error}`); }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                // [REWINDOW] 她在思考时进来的消息：这轮结束后不要立刻开口，
                // 而是**重新进一次窗口期**（scheduleWakeV2 会按 batchWindowMs=5s 重新计时），
                // 这样思考期间的新消息和随后的补充能合并成一次回应。
                const stEnd = __deps.getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const items = stEnd.pendingWakeReasons.splice(0, stEnd.pendingWakeReasons.length);
                  const live = items.filter((it) => it && typeof it === 'object'
                    && Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(it.seq)));
                  if (live.length) {
                    const best = live.reduce((a, b) => (__deps.wakePriorityV2(b.reason) > __deps.wakePriorityV2(a.reason) ? b : a));
                    __deps.log(`[reserved2] ${key} 思考期间来了 ${live.length} 条唤醒请求，重新进入窗口期（最高优先级 ${best.reason}@seq${best.seq}）`);
                    __deps.scheduleWakeV2(key, best.reason);
                  } else if (items.length) {
                    __deps.log(`[reserved2] ${key} 思考期间的 ${items.length} 条唤醒请求已被当前回合处理，跳过`);
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = __deps.mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  __deps.log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = __deps.socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      __deps.log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (__deps.isSilentMarker(plain)) {
                  __deps.log(`社交模式：AI 选择静默（${__deps.SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = __deps.socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      __deps.log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  __deps.log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = __deps.socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      __deps.log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...__deps.KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (__deps.shouldAuditKey(key) && (__deps.SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  __deps.log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  __deps.appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (__deps.cfg.security?.interceptNotify !== false) {
                    await __deps.sendNotice(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = __deps.socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      __deps.log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (__deps.isSocialEnabled()) {
                  if (__deps.shouldBlockSilentReply(key)) {
                    __deps.log(`静默模式，拦截在途回复 (${key})`);
                    __deps.appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = __deps.socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        __deps.log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  // [C2] 表达策略影子：只算建议；默认不改分条，EXPR_POLICY=1 才用 targetChars 收紧上限。
                  let exprStyle = null;
                  try {
                    if (typeof __deps.planExpression === 'function' && typeof __deps.getMindSelf === 'function') {
                      exprStyle = __deps.planExpression({
                        self: __deps.getMindSelf(key),
                        belief: typeof __deps.getMindBelief === 'function' ? __deps.getMindBelief(key) : null,
                        scene: String(key).startsWith('group:') ? 'group' : 'private',
                      });
                      if (process.env.EXPR_POLICY_DEBUG === '1') {
                        __deps.log('[expr] ' + key + ' 建议 messages=' + exprStyle.messages + ' chars=' + exprStyle.targetChars + ' delay=' + exprStyle.delayMs + ' tone=' + exprStyle.tone);
                      }
                    }
                  } catch (error) { /* best-effort */ }
                  const timeline = __deps.planSocialTimeline(plain, __deps.cfg.social, exprStyle);
                  const messages = timeline.main;
                  __deps.log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  __deps.appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await __deps.sendBurstToQQ(key, messages, __deps.cfg.social);
                  } else {
                    await __deps.sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = __deps.socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    __deps.log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    __deps.log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (__deps.lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      __deps.log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      __deps.log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (__deps.currentMode === 'reserved2') {
                  __deps.log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  __deps.appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  __deps.noteSilentTurnEndV2(key); // [SILENT-GUARD] 内心独白不算在群里开口
                } else {
                  if (__deps.shouldBlockSilentReply(key)) {
                    __deps.log(`静默模式，拦截在途回复 (${key})`);
                    __deps.appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  __deps.log(`agent 回复 (${key}) ${plain.length} 字`);
                  __deps.appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  // [SEND-ADVISORY] 只观察记录（接不接得上、这轮有没人叫她），拦不拦由她自己决定。
                  await __deps.sendGuardCheckV2(key, plain, __deps.getSocialV2State(key));
                  await __deps.sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                // [SESSION-REBUILD] 会话被模型端拒绝（400/上下文超长）：退役旧会话并重试一次唤醒，
                // 否则这个 key 会一直对着坏会话重试，永远说不了话（2026-10-26 18:22 群会话即如此）。
                if (/Messages request failed|request failed \(400\)|context length|too long/i.test(msg)) {
                  try {
                    __deps.log(`[SESSION-REBUILD] ${key} 会话被模型端拒绝（${String(msg).slice(0, 60)}），退役并重建`);
                    __deps.retireSession(key);
                    setTimeout(() => { void __deps.sendWakePromptV2(key, 'session-rebuilt').catch((e) => globalThis.__ignoredCatch?.(e, 'src/adapters/mux-bus.mjs:857')); }, 3000).unref?.();
                  } catch (error) { __deps.log(`[SESSION-REBUILD] 重建失败：${error?.message ?? error}`); }
                }
                const safeMsg = __deps.shouldAuditKey(key) && __deps.SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                await __deps.sendNotice(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = __deps.socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    __deps.log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                // [AUTO-CANCEL] 系统让位取消（busy-watch 的 turnMaxMs）不要发「已停止」——
                // 那是用户主动停止时的提示；自动取消应当静默，让新消息接上。
                if (__deps.autoCancelledKeys.has(key)) {
                  __deps.autoCancelledKeys.delete(key);
                  __deps.log(`[busy-watch] ${key} 的 turn 已自动让位取消（不提示用户；这回合留下的未发文本 ${String(ended.text || '').trim().length} 字）`);
                } else {
                  await __deps.sendToQQ(key, '⏹️ 已停止');
                }
                if (isFarewell) {
                  const st = __deps.socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    __deps.log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                __deps.log(`回合完成但无文本 (${key})`);
                __deps.noteSilentTurnEndV2(key); // [SILENT-GUARD] 强触发后仍不开口 → 计数（函数内部自判模式/理由）
                if (isFarewell) {
                  const st = __deps.socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    __deps.log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && __deps.learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await __deps.api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await __deps.api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              __deps.log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              __deps.log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = __deps.reverse.get(frame.sessionId);
            if (!key) continue;
            if (!__deps.isCurrentSession(key, frame.sessionId)) { await __deps.cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = __deps.shouldAuditKey(key) && __deps.SENSITIVE_RE.test(qText);
              if (sensitive) __deps.log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = __deps.shouldAuditKey(key) && __deps.SENSITIVE_RE.test(label);
                  if (optSensitive) __deps.log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await __deps.sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await __deps.registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = __deps.reverse.get(frame.sessionId);
            if (!key) continue;
            if (!__deps.isCurrentSession(key, frame.sessionId)) { await __deps.cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = __deps.shouldAuditKey(key) && __deps.SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) __deps.log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = __deps.shouldAuditKey(key) && __deps.SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) __deps.log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await __deps.sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await __deps.registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            __deps.log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        __deps.log('事件流中断:', error?.message ?? error);
      } finally {
        // [MUX-DISCONNECT] 断链时会丢掉「进行中回合」已经生成的文本：先把它们沉到底部容器
        // （outbox，10 分钟过期/最多 50 条），own-life/自唤醒时带一行，送不送由她定。
        // 不直接发 QQ —— 没收到 turn/end 的文本只是半句，直接发会变成没头没尾的回复。
        try {
          for (const [sid, collector] of __deps.collectors) {
            const pending = typeof collector?.pendingText === 'function' ? collector.pendingText() : '';
            if (!pending) continue;
            const key = __deps.reverse?.get(sid) ?? '';
            __deps.appendUndelivered?.({ file: __deps.undeliveredFile, key, text: pending });
            __deps.log(`事件流中断：${String(key || sid).slice(0, 40)} 未完成回合文本已沉底（${pending.length} 字）`);
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mux-bus.mjs:disconnect'); }
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        __deps.collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        __deps.social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        __deps.sendToolSucceededSessions.clear();
        __deps.pendingSendToolCalls.clear();
        __deps.v2TurnStartAt.clear();
        __deps.busySinceMs.clear();
        __deps.toolCallNames.clear();
        __deps.pendingWakeKeys.clear();
        __deps.clearAllPendingWakeLeases();
        __deps.social.exitingSessions.clear();
        __deps.wakeConfigUpdatedKeys.clear();
        __deps.markReadCalledKeys.clear();
        __deps.wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        __deps.activeWaits.clear();
      }
      await __deps.sleep(3000);
    }
  
}
