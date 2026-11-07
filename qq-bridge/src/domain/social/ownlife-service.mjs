// 她自己的生活：节奏定时器、独处 context、掉地上愿望补做。
//
// 从 app.mjs 的 main() 搬出（P3-RW-28，2026-11-01）。ownLife 实例由本模块持有；
// 所有状态与拼装函数注入，模块只负责定时器生命周期与 deliver 回调。
/**
 * @param {object} ctx
 */
export function createOwnLifeService(ctx) {
  const {
    fs, cfg, log, path, STATE_DIR, MEM_DIR, createOwnLife, mayOwnWake, drowsinessOf,
    getLifeState, getLastPhoneOpAt, socialV2, getCurrentMode, getSocialV2State, loadGoals,
    loadLessons, filesForScope, summarizeRelationship, requireMemoryEntries,
    openCuriosityLoops, buildAutonomyPrompt, renderRelationship, lifeTimePre, ruminationPre,
    drainUnsentHints, renderUnsentLine, quantSnapshotLine, renderAgencyBlock, loadDayPlan,
    renderIntentionCandidates, buildIntentionCandidates, openWishItems, loadWishState,
    appendJsonl, deliverToIsolated, dispatchOwnlifeUnified, isConversationBusyV2,
    isSessionAllowedInCurrentMode, boredomOf,
    markInterest, dueWishes, markWishRun, pendingJudgeList, findUnknownTerms, renderUnknownTerms,
    loadSlang, renderSlangJudgeLine, sedimentBrowseIfAny, renderWanderNudge, saveLifeFile,
    saveWishState, sendWakePromptV2, renderLifeLine, renderCuriosityLine,
    // [WIRING-FIX] 自主时间里读浏览轨迹/黑话判定队列/DSH 就绪态；原来都是 app.mjs 的局部名，
    // 搬出后这几条分支一跑就 ReferenceError（自主时间的「递判定队列」「逛完说一句」全静默失效）。
    SLANG_FILE, getSlangEntries, getBrowseStore, getDshReady,
    // [WIRING-FIX] 独处时记「有活动了」要用 lifeNote，原来裸引用 → 静默失败
    lifeNote,
    // [IDLE-ASSOC] 独处时把联想图点亮的一两条带进提示（空串不附）。
    getIdleAssociationLine,
  } = ctx;
  let ownLife = null;
  function startOwnLife() {
    try {
      if (ownLife) ownLife.stop();
      const ownerKey = 'private:' + String(cfg.ownerQQ ?? '');
      if (!cfg.ownerQQ || ownerKey === 'private:') {
        log('[own-life] 没有 ownerQQ，跳过');
        return;
      }
      const oc = cfg.ownLife ?? {};
      if (oc.enabled === false) {
        log('[own-life] 配置已关闭（ownLife.enabled=false）');
        return;
      }
      // [WISH-MAKUP] 最近一次"想独处但太忙"的时间戳与次数（24h 内下个空档补上）
      let lastWishDrop = null;
      ownLife = createOwnLife({
        getLifeGate: () => { // [LIFE] 状态门：睡着=不发；犯困=推延；她正在真机上操作=不打断
          if (!mayOwnWake(getLifeState())) return 'sleeping';
          if (drowsinessOf(getLifeState()) >= 0.75) return 'drowsy';
          // [STARVE-FIX] "正忙"只认她真的在动手（3 分钟内有 phone_* 操作），
          // 不再拿泛化的 getLifeState() active（它会被任何"活动"刷新，等于长期占死这条路）。
          if (Date.now() - getLastPhoneOpAt() < 3 * 60000) return 'in-progress';
          return 'ok';
        },
        key: ownerKey,
        statePath: path.join(STATE_DIR, 'own-life.json'),
        ...(Number(oc.intervalMs) > 0 ? { intervalMs: Number(oc.intervalMs) } : {}),
        ...(oc.maxPerDay !== undefined ? { maxPerDay: Number(oc.maxPerDay) } : {}), // 0 = 不设每日上限（模块 [OPEN-CAP]），别用 >0 过滤
        // [STARVE-FIX] 保底：一天至少给到几次"自己的时间"（饿过 3 个间隔就跳过"正忙"）
        minPerDay: oc.minPerDay !== undefined ? Number(oc.minPerDay) : 2,
        ...(typeof oc.textDay === 'string' && oc.textDay ? { textDay: oc.textDay } : {}),
        ...(typeof oc.textMidnight === 'string' && oc.textMidnight ? { textMidnight: oc.textMidnight } : {}),
        extraLines: typeof getIdleAssociationLine === 'function' ? getIdleAssociationLine : '',
        rhythmPath: path.join(STATE_DIR, 'own-life-rhythm.json'), // [RHYTHM-HERS] 她自调的节奏（qq_set_own_life_rhythm 写这里，每 tick 热读）
        // ★ 正在忙就推延；推延超过 maxDefer 次则放弃，并把"没去成"记进记忆
    // [STARVE-FIX] 她自己的时间走独立会话（deliverToIsolated('ownlife')），跟私聊忙不忙无关；
    // 旧实现拿私聊 busy 当门，私聊一有动静就永远轮不到。并发由模块自己的 busy 标记兜着。
    isBusy: () => false,
    onDrop: async ({ at, count, total }) => {
      // [WISH-MAKUP] 她"想独处"的机会被放弃了 → 记下来，下个空档补上（24h 内有效）
      lastWishDrop = { at, count };
      try {
        const d = new Date(at);
        const day = d.toLocaleDateString('sv-SE');
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const entry = {
          day,
          time: `${day} ${hm}`,
          kind: 'event',
          text: `想自己待会儿，但连着 ${count} 次都正忙，这次就没去成（累计 ${total} 次）。`,
        };
        fs.mkdirSync(MEM_DIR, { recursive: true });
        // [NOISE-GATE] 自述类事件不刷库：24h 内同主题（"想自己待会儿…没去成"）只留 1 条。
        // 旧行为每次放弃都追加，memory.jsonl 里全是同一句话的不同计数变体。
        let recentSame = false;
        try {
          const lines = fs.readFileSync(MEM_DIR + '/memory.jsonl', 'utf8').split(/\r?\n/);
          for (const line of lines) {
            if (!line) continue;
            let r = null; try { r = JSON.parse(line); } catch { continue; }
            if (!r || r.kind !== 'event' || !String(r.text || '').includes('想自己待会儿')) continue;
            const at = Date.parse(String(r.time || r.day || '').replace(' ', 'T'));
            if (Number.isFinite(at) && Date.now() - at < 24 * 3600 * 1000) { recentSame = true; break; }
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8231'); }
        if (recentSame) {
          log(`[own-life] 24h 内已有同类"没去成"记录，不再重复写（累计 ${total} 次）`);
        } else {
          appendJsonl(MEM_DIR + '/memory.jsonl', entry, { source: 'bridge/ownlife-drop' });
          log(`[own-life] 已把"没去成"记进记忆（累计 ${total} 次）`);
        }
      } catch (error) {
        log(`[own-life] 记记忆失败（已忽略）: ${error?.message ?? error}`);
      }
    },
    log: (m, ...rest) => log(`[own-life] ${m}${rest.length ? ' ' + rest.join(' ') : ''}`),
        deliver: async (text) => {
          if (socialV2.paused) throw new Error('socialV2 已暂停');
          if (getCurrentMode() !== 'reserved2') throw new Error('当前不是 reserved2 模式');
          let finalText = text;
          // 每次独处唤醒都重新取快照：目标、关系和经验会随对话变化。
          try {
            const gst = getSocialV2State(ownerKey);
            const goals = loadGoals(cfg.socialV2?.goals?.file);
            const lessons = loadLessons(cfg.socialV2?.lessons?.file);
            const memoryDir = cfg.socialV2?.memory?.dir || MEM_DIR;
            const P = filesForScope(memoryDir, ownerKey);
            const relationship = summarizeRelationship({
              messages: gst.recentMessages ?? [],
              memories: requireMemoryEntries(P.file),
              scope: P.scope,
            });
            let curiosityLoops = [];
            try { curiosityLoops = openCuriosityLoops(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'curiosity.json'), 'utf8'))); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8260'); }
            const autonomy = buildAutonomyPrompt({
              // [CURIOSITY] 她自己挂心着的事（open loops）：空档里正好可以去弄明白
              curiosityLoops,
              goals,
              lessons,
              recentMessages: gst.recentMessages ?? [],
              relationship,
              // [WISH-MAKUP] 掉地上的"想独处"愿望：24h 内补一次，用过即清
              pendingWish: lastWishDrop && Date.now() - lastWishDrop.at < 24 * 3600000 ? { at: lastWishDrop.at, count: lastWishDrop.count } : null,
            });
            if (autonomy.includes('wish-makeup')) lastWishDrop = null; // 补上了，愿望兑现
            const relationText = renderRelationship(relationship);
            const lifeLine = lifeTimePre(); // [LIFE] 时间段 + 她的生活状态（生理层）
            const rumLine = ruminationPre(ownerKey); // [RUMINATE] 独处时最容易想起惦记的事
            // [UNSENT] 挂心事（沉底）：组装前先排水各会话过期的 noSendHint，过期不遗忘——
            // 送不送她定（qq_send 补一句即可），不催不派活、不新唤醒
            let unsentLine = null;
            try { drainUnsentHints(); unsentLine = renderUnsentLine(Date.now()); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8278'); }
            // [QUANT] 她那 100 块虚拟本金还在那儿：递一行净值 + 工具名，看不看、做不做她定
            let quantLine = null;
            try { quantLine = quantSnapshotLine(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8281'); }
            const agencyBlock = renderAgencyBlock();
            // [INTENTION-CANDIDATES] wish/curiosity/goal/day-plan 合成一份候选池；不再各占一行重复。
            // dayPlan 之前只写在文件里、没进候选池，导致“她自己的时间看不到今天定了什么”。
            let candidateBlock = '';
            try {
              const todayPlan = loadDayPlan();
              candidateBlock = renderIntentionCandidates(buildIntentionCandidates({
                wishes: typeof openWishItems === 'function' ? openWishItems(loadWishState()) : [],
                curiosity: curiosityLoops,
                // goals 已由 selfKnowledgeBlock 以「手头的事（带下一步/多久没动）」注入，
                // 这里不再重复；候选池只补 wish/curiosity/dayPlan。
                goals: [],
                dayPlan: todayPlan?.items ?? [],
              }));
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8296'); }
            finalText = [autonomy, relationText, lifeLine, rumLine, candidateBlock, unsentLine, quantLine, agencyBlock, text].filter(Boolean).join('\n\n');
            // [WANDER] 闲逛 nudge：只在她自己的时间递一句「上次逛是几天前」，不催不考核
            try {
              const nudge = renderWanderNudge(getBrowseStore()?.entries ?? []);
              if (nudge) {
                finalText = nudge + '\n\n' + finalText;
                log('[browse-nudge] 独处时递了闲逛提示');
              }
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8305'); }
            // [LIFE] 她发起"自己的时间" = 有活动了（状态账本记录）
            try { lifeNote({ type: 'activity' }); markInterest(getLifeState()); saveLifeFile(getLifeState()); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8307'); }
          } catch (error) { log(`[autonomy] 上下文构建失败（使用基础提示）: ${error?.message ?? error}`); }
          // [GLOSS] 把「她没见过但反复被提到的词」递给她：提示词里写'偶尔搜一下'是没用的，必须主动喂
          try {
            const gst = getSocialV2State(ownerKey);
            let known = '';
            try { known = loadLessons(cfg.socialV2?.lessons?.file).map((x) => x.text).join('\n'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8313'); }
            // [GLOSS-MONOTONIC] 已知集 = lessons + slang 全库（candidate/confirmed/rejected）：
            // 她查过/在查的词不再当"未知词"反复递（两个词库之前没打通，同一个词会一直"没见过"）；
            // rejected = 她已经裁决过（知道，但不学/不用）→ 也算定案，gloss 行不翻"你可能不懂它的含义"
            try {
              const slang = loadSlang(SLANG_FILE).filter((e) => e.content);
              if (slang.length) known += '\n' + slang.map((e) => `${e.content} ${e.meaning ?? ''}`).join('\n');
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8320'); }
            const unk = findUnknownTerms(gst.recentMessages ?? [], known, { minMessages: 2, limit: 6 });
            const line = renderUnknownTerms(unk);
            if (line) {
              // [WIRING-FIX] 这里原来拼的是入参 text，会把前面拼好的自主性/关系/生活/候选整段丢掉：
              // 只要本轮有生词，她这段独处时间就只剩「一行生词 + 正文」，上下文全没了。
              finalText = line + '\n\n' + finalText;
              log(`[gloss] 待查 ${unk.length} 个词：${unk.map((x) => x.term).join(',')}`);
            }
          } catch (error) { log(`[gloss] 检测失败（已忽略）: ${error?.message ?? error}`); }
          // [SLANG-JUDGE] 词库判定队列：机器研究出的含义递给她，她自己想、自己确认/放下（事实+许可，不催不派活）
          try {
            const judgeLine = renderSlangJudgeLine(getSlangEntries(), cfg.slang?.judgeListMax ?? 8);
            if (judgeLine) {
              finalText = judgeLine + '\n\n' + finalText;
              log(`[slang-judge] 递判定队列给她（${pendingJudgeList(getSlangEntries(), 30).length} 词）`);
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8335'); }
          sedimentBrowseIfAny();
          await dispatchOwnlifeUnified('own-life', finalText);
        },
      });
      ownLife.start();
      // [FREE-TICK] 持续运行的「节拍」：没人找她时，她自己每隔一段时间有一次「想做什么就做什么」的机会。
      // 纪律：事实+许可；睡觉不触发；每 25 分钟最多一次、每小时最多 3 次；有人找她（有未读）就不抢。
      // 不是一个词·不是统计指标——只看行为是否自然出现。
      if (cfg.socialV2?.freeTick?.enabled !== false) {
        const ft = cfg.socialV2?.freeTick ?? {};
        const ftInterval = Math.max(60 * 1000, Number(ft.intervalMs) || 5 * 60 * 1000);
        const ftMinGap = Math.max(5 * 60 * 1000, Number(ft.minGapMs) || 25 * 60 * 1000);
        const ftMaxPerHour = Math.max(1, Number(ft.maxPerHour) || 3);
        const ftProb = Math.min(1, Math.max(0, Number(ft.probability) || 0.4));
        let ftLastAt = 0;
        let ftHourStart = Date.now();
        let ftHourCount = 0;
        const freeTickPromptText = () => {
          try {
            const p = 'data/prompts/free-tick.md';
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8357'); }
          return '【现在没人找你】接下来这一会儿是你自己的：想干什么就干什么（看看消息、上网逛逛、弄手上的活、或者就发呆/继续睡）。不想动就这么待着——没人等你回话。';
        };
        const freeTickTimer = setInterval(async () => {
          try {
            if (getCurrentMode() !== 'reserved2' || !getDshReady()) return;
            if (getLifeState().state === 'sleep') return; // 睡着不吵她
            const now = Date.now();
            if (now - ftLastAt < ftMinGap) return;
            if (now - ftHourStart > 3600000) { ftHourStart = now; ftHourCount = 0; }
            if (ftHourCount >= ftMaxPerHour) return;
            try {
              const stFt = getSocialV2State(ownerKey);
              if (Array.isArray(stFt?.unread) && stFt.unread.length > 0) return; // 有人找她：先回人
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8371'); }
            if (Math.random() > ftProb) return; // 概率门控：不让节拍变成闹钟
            ftLastAt = now;
            ftHourCount += 1;
            log(`[free-tick] 给她一次自己的时间（本小时第 ${ftHourCount}/${ftMaxPerHour} 次）`);
            // [WANDER] free-tick 也带一句闲逛提示（事实+许可）
            let freeTickText = freeTickPromptText();
            try {
              const nudge = renderWanderNudge(getBrowseStore()?.entries ?? []);
              if (nudge) freeTickText = nudge + '\n\n' + freeTickText;
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8381'); }
            await dispatchOwnlifeUnified('free-tick', freeTickText);
          } catch (error) { log(`[free-tick] 失败（已忽略）: ${error?.message ?? error}`); }
        }, ftInterval);
        freeTickTimer.unref?.();
      }
      // [SELF-WAKE] 系统只替她记着、到点叫醒：每 30s 扫一遍「她说的想干的事」里到点的。
      // 她正在忙就跳过（下轮再扫，runAt 不动）；叫醒后 runAt 归零不重复；愿望本身挂着等她关掉或 14 天沉底。
      const wishScanTimer = setInterval(() => {
        try {
          if (socialV2.paused || getCurrentMode() !== 'reserved2') return;
          const due = dueWishes(loadWishState());
          if (!due.length) return;
          const ids = [];
          for (const w of due) {
            const key = w.key || ownerKey;
            if (!isSessionAllowedInCurrentMode(key)) continue;
            if (isConversationBusyV2(key, getSocialV2State(key))) continue; // 她正忙着：顺延到下轮，不硬插
            ids.push(w.id);
            log(`[self-wake] ${key} 叫醒兑现愿望：${w.wish.slice(0, 40)}`);
            void sendWakePromptV2(key, 'selfWake').catch((error) => log(`[self-wake] 唤醒异常 ${key}:`, error?.message ?? error));
          }
          if (ids.length) saveWishState(markWishRun(loadWishState(), ids));
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8404'); }
      }, 30000);
      wishScanTimer.unref?.();
      // [BOREDOM] 无聊驱动：动机触发的"找事做"，独立于 own-life 的计时轮（不占 12 次日限额）。
      // 活人不是钟在响才动，是痒了才动。触发条件全确定性：
      //   无聊≥0.7 且 不困（困意<0.75，困了该睡不是该找事）且 没在忙活动
      //   且 非安静时段(3-8) 且 45 分钟冷却 且 当天最多 3 轮
      const tryBoredomRound = async () => {
        try {
          const now = Date.now();
          // [SLEEP-SPEC] 睡实了=真休眠：无聊轮也停（刚被叫醒的 45 分钟窗口内例外——那时她还醒着）
          if (getLifeState().state === 'sleep' && !mayOwnWake(getLifeState(), now)) return;
          const bo = boredomOf(getLifeState(), now);
          if (bo < 0.7) return;
          if (drowsinessOf(getLifeState(), now) >= 0.75) return; // 困了 → 自然睡，不是找事
          if (getLifeState().state === 'active' && now - getLifeState().stateChanged < 10 * 60000) return; // 正忙活
          const h = new Date(now).getHours();
          if (h >= 3 && h < 8) return; // 安静时段不闹
          const day = new Date(now).toLocaleDateString('sv-SE');
          if (getLifeState().boreDay !== day) { getLifeState().boreDay = day; getLifeState().boreCount = 0; }
          if ((getLifeState().boreCount || 0) >= 3) return;
          if (now - (getLifeState().boreLastAt || 0) < 45 * 60000) return;
          const idleMin = Math.round((now - (getLifeState().lastInterestAt || now)) / 60000);
          let text = `【无聊轮】你已经闲了 ${idleMin} 分钟了，有点闷。`;
          try {
            const gs = loadGoals(cfg.socialV2?.goals?.file).filter((g) => g.status === 'active');
            if (gs.length) text += '\n你"想做"的事：\n' + gs.slice(0, 5).map((g, i) => `${i + 1}. ${String(g.text).slice(0, 60)}`).join('\n');
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8431'); }
          text += '\n随便做点什么：刷会儿手机、发条说说、接着没做完的事（做完 goal_progress 记一笔），或者去工坊给自己写点东西（qq_workshop）。想说话就说一句，但别为说话而说话。';
          const lifeLine = renderLifeLine(getLifeState());
          if (lifeLine) text += '\n' + lifeLine;
          // [CURIOSITY] 无聊轮也递挂心着的事（同一个容器）
          try {
            const cur = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'curiosity.json'), 'utf8'));
            const curLine = renderCuriosityLine(cur, now);
            if (curLine) text += '\n' + curLine;
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8440'); }
          // [SLANG-JUDGE] 无聊轮也递词库判定队列（同一纪律：事实+许可，不催不派活）
          try {
            const judgeLine = renderSlangJudgeLine(getSlangEntries(), cfg.slang?.judgeListMax ?? 8);
            if (judgeLine) text += '\n' + judgeLine;
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-service.mjs:8445'); }
          getLifeState().boreCount = (getLifeState().boreCount || 0) + 1;
          getLifeState().boreLastAt = now;
          markInterest(getLifeState()); // 这一轮本身就是"有意思的事"，别 45 分钟后又撞一轮
          saveLifeFile(getLifeState());
          sedimentBrowseIfAny();
          await dispatchOwnlifeUnified('boredom', text);
          log(`[life] 无聊轮投递（无聊 ${Math.round(bo * 100)}%，今天第 ${getLifeState().boreCount} 轮）`);
        } catch (error) { log(`[life] 无聊轮失败（已忽略）: ${error?.message ?? error}`); }
      };
      const boreTimer = setInterval(() => { tryBoredomRound(); }, 5 * 60000);
      if (typeof boreTimer.unref === 'function') boreTimer.unref();
    } catch (e) {
      log(`[own-life] 启动失败（不影响桥接）: ${e?.message ?? e}`);
    }
  }

  return { startOwnLife };
}
