// 情绪/秘书/对话结构：开口前 affect 融合、秘书判定、谁在对谁说。
//
// 从 app.mjs 的 main() 搬出（P3-RW-39，2026-11-01）。模型/ONNX/3B 调用全部注入；
// 本模块只读 st、写 st.affectCache/topicStack/metrics。
import { loadEmotionVector, saveEmotionVector, observeOtherAffect } from '../leaves/inori-emotion-vector.js';
/**
 * @param {object} ctx
 */
export function createWakeAffect(ctx) {
  const {
    cfg, log, getSocialV2State, saveSocialV2State, scheduleWakeV2, aggregateFeel,
    renderFeelHint, correctTarget, fuseJudgement, isDirectedAtAi, classifyAffectOnnx,
    ensureEmotionServer, shouldTrustOnnx, onnxJudgement, pickExamples, judgeByModel,
    local3bAlive, local3bBase, ensureLocal3b, touchLocal3b, completeLocal3b, shouldJudge,
    gateEmbedTexts, buildSecretaryPrompt, parseSecretaryVerdict, secretaryAllows,
    shouldConsultSecretary, selfNickname, stateHub = null, governor = null,
  } = ctx;
  function affectWhoLabel(key) { return String(key).startsWith('private:') ? '他' : '这个说话的人'; }
  async function prepareAffectHint(key, reason) {
    try {
      const a = cfg.socialV2?.affect ?? {};
      if (a.enabled === false) return;
      const stA = getSocialV2State(key);
      const isGroup = String(key).startsWith('group:');
      const msgs = (Array.isArray(stA.unread) && stA.unread.length ? stA.unread : (stA.recentMessages || [])).filter((m) => m && !m.isSelf && String(m.text || m.plain || '').trim());
      const last = msgs[msgs.length - 1];
      if (!last) return;
      const text = String(last.text || last.plain || '');
      const directed = isDirectedAtAi(text) || !!last.quoteTargetIsSelf;
      const windowMsgs = msgs.slice(-3).map((m) => ({ text: String(m.text || m.plain || ''), at: Number(m.time) || Date.now() }));
      const rule = aggregateFeel(windowMsgs, { directedAtSelf: directed, isGroup, windowMs: 10 * 60 * 1000 });
      let fused = fuseJudgement(rule, null, { ruleMin: Number(a.ruleMin) || 0.5, modelMin: Number(a.modelMin) || 0.55 });
      let used = 'rule';
      let dirFixed = false;
      // 群聊只记日志（不注入）时不必调 3B：省一次模型调用和几秒延迟
      const willInject = !isGroup || a.groupInject === true;
      const seqKey = Number(last.seq) || 0;
      const cached = stA.affectCache && stA.affectCache.seq === seqKey && Date.now() - Number(stA.affectCache.at || 0) < 10 * 60 * 1000 ? stA.affectCache : null;
      if (!willInject) {
        used = 'rule-only(群聊不注入)';
      } else if (cached) {
        fused = cached.fused; used = 'cache';
      } else if (governor && !governor.canRun('background') && !directed) {
        // [RESOURCE-GOVERNOR] 设备忙且不是直接对她说：让出 3B/ONNX，只用规则结论。
        used = 'yield(设备忙)';
      } else if (shouldJudge(text, rule, { ruleMin: Number(a.ruleMin) || 0.5 })) {
        const ready = await local3bAlive(cfg);
        if (ready) {
          touchLocal3b();
          const t0 = Date.now();
          // [AFFECT] 先用本地嵌入找 2 条最像的手写示例（不新增模型；失败就空着）
          let examples = [];
          try { examples = await pickExamples(text, { embed: (t) => gateEmbedTexts(t), top: 2 }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:10845'); }
          const model = await judgeByModel({ baseUrl: local3bBase(cfg), text, examples, timeoutMs: Math.min(4000, Number(a.timeoutMs) || 4000), log });
          if (model) {
            // [DIRECTION] 冲她说的消息不可能"对别人"——按事实纠正，避免"倾诉/别人"这类自相矛盾
            const fixed = correctTarget(model, { directed });
            dirFixed = !!fixed?.corrected;
            fused = fuseJudgement(rule, fixed, { ruleMin: Number(a.ruleMin) || 0.5, modelMin: Number(a.modelMin) || 0.55 });
            used = `${fused.source}(${Date.now() - t0}ms)`;
          }
        } else {
          // [AFFECT-ONNX] 3B 冷启动/被回收时，用本地 ONNX 小分类器兜一次。
          // 实测 6 类 51~57%、二分类 68.6%：只在置信度高时采信，否则仍保持规则结论。
          if (a.onnxEnabled !== false) {
            const onnx = await classifyAffectOnnx(text, {
              url: a.onnxUrl || undefined,
              timeoutMs: Math.min(2000, Number(a.onnxTimeoutMs) || 1200),
            });
            if (shouldTrustOnnx(onnx, { minConfidence: Number(a.onnxMinConfidence) || 0.7, minMargin: Number(a.onnxMinMargin) || 0.15 })) {
              const fixed = correctTarget(onnxJudgement(onnx), { directed });
              dirFixed = !!fixed?.corrected;
              fused = fuseJudgement(rule, fixed, { ruleMin: Number(a.ruleMin) || 0.5, modelMin: Number(a.modelMin) || 0.55 });
              used = `onnx-fallback(${onnx.ms}ms)`;
            } else if (onnx) {
              used = `onnx-untrusted(${onnx.ms}ms)`;
            } else {
              ensureEmotionServer({ log });
            }
          }
          void ensureLocal3b(cfg, log).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/wake-affect-service.mjs:81'));
        }
      }
      // 群聊不注入时也写缓存？不：只有注入才缓存；但持久底色群聊也记。
      if (seqKey && willInject) stA.affectCache = { seq: seqKey, fused, at: Date.now() };
      // [EMOTION-VECTOR] 把这次判读写进持久底色（群聊也记，形成长期情绪底子）。
      try {
        if (fused && Number(fused.confidence) >= 0.25 && !/未知/.test(String(fused.affect || ''))) {
          // [STATE-HUB] 统一状态层优先：情绪底色只经单一写入者落盘；缺失时回退旧路径。
          if (stateHub && typeof stateHub.observeAffect === 'function') {
            stateHub.observeAffect(key, { affect: fused.affect, confidence: fused.confidence });
          } else {
            const v = loadEmotionVector();
            observeOtherAffect(v, key, { affect: fused.affect, confidence: fused.confidence });
            saveEmotionVector(v);
          }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:affect-vector'); }
      const who = affectWhoLabel(key);
      const minConfidence = isGroup
        ? (Number(a.groupMinConfidence) || 0.6)
        : (Number(a.minConfidence) || 0.55);
      let line = renderFeelHint({
        affect: fused.affect,
        confidence: fused.confidence,
        evidence: fused.evidence,
        intent: fused.intent || '不确定',
        note: fused.source === 'model' ? '按你自己的判断来，不对就当没看见' : (rule.note || ''),
      }, { who, minConfidence });
      // [AFFECT-HEDGE] 私聊低置信度不装死：给一条明确“不确定”的弱提示；
      // 群聊仍用更高门槛，避免把误判带进多人对话。
      let hedged = false;
      if (!line && !isGroup) {
        const hedgeMin = Number(a.hedgeMin) || 0.35;
        if (Number(fused.confidence) >= hedgeMin) {
          const weak = renderFeelHint({
            affect: fused.affect,
            confidence: fused.confidence,
            evidence: fused.evidence,
            intent: fused.intent || '不确定',
            note: rule.note || '线索很弱，别当结论',
          }, { who, minConfidence: hedgeMin });
          if (weak) { line = `（不确定）\n${weak}`; hedged = true; }
        }
      }
      const inject = !!line && (!isGroup || a.groupInject === true);
      stA.pendingFeel = inject ? { text: line, at: Date.now(), source: fused.source } : null;
      saveSocialV2State();
      log(`[affect] ${key} ${fused.affect}${fused.target ? '/' + fused.target : ''} conf=${Math.round((fused.confidence || 0) * 100)}% src=${fused.source}/${used}${dirFixed ? ' 方向已纠正' : ''} 注入=${inject ? '是' : '否'}${hedged ? '（弱提示）' : ''}${isGroup && !a.groupInject ? '（群聊只记日志）' : ''}`);
    } catch (error) { log(`[affect] 判读失败（忽略）: ${error?.message ?? error}`); }
  }
  // [SECRETARY] 唤醒前的语义门：用本地 3B（免费、已有）判断「这条是不是在跟她说话」。
  // 只处理非定向唤醒（概率/续聊/问到/提到她）；@/名字/被拍她本人直接放行。
  // 判不了（模型没起/超时/坏输出）一律放行——不拿故障当理由改变行为。
  async function secretaryJudgeForWake({ key, st, reason, sender, text }) {
    try {
      const sc = cfg.socialV2?.secretary ?? {};
      if (sc.enabled === false) return null;
      if (!shouldConsultSecretary(reason, { enabled: true })) return null;
      if (!(await local3bAlive(cfg))) { void ensureLocal3b(cfg, log).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/conversation/wake-affect-service.mjs:140')); return null; }
      const recent = (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
        .filter((m) => m && !m.isSelf && (m.text || m.plain))
        .slice(-8)
        .map((m) => ({ sender: m.sender, text: m.text || m.plain }));
      const prompt = buildSecretaryPrompt({ selfName: String(selfNickname ?? '').trim() || '', reason, sender, text, recent }, {
        recentLimit: Number(sc.recentLimit) || 8,
        msgChars: Number(sc.msgChars) || 80,
      });
      const t0 = Date.now();
      const raw = await completeLocal3b(cfg, {
        prompt,
        maxTokens: Number(sc.maxTokens) || 96,
        timeoutMs: Math.min(8000, Number(sc.timeoutMs) || 5000),
        temperature: 0,
        log,
      });
      const verdict = parseSecretaryVerdict(raw);
      if (verdict) {
        log(`[secretary] ${key} ${reason} → addressed=${verdict.addressed} should=${verdict.shouldReply ? '是' : '否'}（${verdict.topic || '-'} / ${verdict.why || '-'}，${Date.now() - t0}ms）`);
      } else if (raw) {
        log(`[secretary] ${key} 输出解析失败，放行：${String(raw).slice(0, 60)}`);
      }
      return verdict;
    } catch (error) {
      log(`[secretary] 判读异常（放行）: ${error?.message ?? error}`);
      return null;
    }
  }
  // [SECRETARY] 给 joinTopic / continueChat 这类"没有具体触发消息"的唤醒用的门：
  // 拿最近一条别人的话去问秘书；拦下就不派回合。判不了照旧放行。
  async function scheduleWakeWithSecretary(key, reason, st, text, sender) {
    try {
      if (shouldConsultSecretary(reason)) {
        const verdict = await secretaryJudgeForWake({ key, st, reason, sender, text });
        if (!secretaryAllows(verdict)) {
          log(`[secretary] ${key} 拦下唤醒 ${reason} → ${verdict?.addressed || '?'}/${verdict?.why || ''}`);
          return;
        }
      }
      scheduleWakeV2(key, reason);
    } catch (error) {
      log(`[secretary] 闸门异常（放行）: ${error?.message ?? error}`);
      try { scheduleWakeV2(key, reason); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:10943'); }
    }
  }
  // [DIALOG-STRUCT] 谁在对谁说 + 话题段落 + 「她上一条之后有没有人接」。
  // 全部是事实（引用/@/时间字段读出来的），不替她判断该不该开口。
  function dialogStructureBlock(st) {
    try {
      const pick = (arr) => (Array.isArray(arr) ? arr : []).filter((m) => m && !m.isSelf && (m.text || m.plain));
      const unread = pick(st?.unread).slice(-12);
      const msgs = unread.length >= 2 ? unread : pick(st?.recentMessages).slice(-12);
      if (msgs.length < 2) return '';
      let directed = 0;
      const rows = msgs.map((m, i) => {
        const raw = String(m.plain || m.text || '').replace(/\s+/g, ' ');
        let to = '群里';
        if (m.quoteTargetIsSelf) { to = '你（引用了你说的话）'; directed += 1; }
        else if (isDirectedAtAi(raw)) { to = '你（点了你）'; directed += 1; }
        else if (raw.includes('@')) to = '某个被@的人';
        return { t: Number(m.time) || 0, line: `#${i + 1} [${String(m.sender || '?').slice(0, 12)} → ${to}] ${raw.slice(0, 40)}` };
      });
      // [TOPIC-SEG] 话题段落：相邻两条间隔 > 3 分钟视为换了一段（最多 3 段，够看清"从A聊到B"）
      const segs = [];
      let cur = [];
      let prevT = 0;
      for (const r of rows) {
        if (cur.length && r.t && prevT && r.t - prevT > 3 * 60 * 1000) { segs.push(cur); cur = []; }
        cur.push(r);
        if (r.t) prevT = r.t;
      }
      if (cur.length) segs.push(cur);
      // 只留最近 3 段：再多就是流水账，不是"从 A 聊到 B 的场面"
      if (segs.length > 3) segs.splice(0, segs.length - 3);
      const segText = segs.length > 1
        ? segs.map((s, n) => `段${n + 1}（${s.length} 条）：\n${s.map((x) => x.line).join('\n')}`).join('\n')
        : segs[0].map((x) => x.line).join('\n');

      // [RECEPTION] 她上一条之后：有人回她 / 没人理她
      let reception = '';
      try {
        const all = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
        let lastSelfIdx = -1;
        for (let i = all.length - 1; i >= 0; i -= 1) { if (all[i]?.isSelf) { lastSelfIdx = i; break; } }
        if (lastSelfIdx >= 0) {
          const after = all.slice(lastSelfIdx + 1).filter((m) => m && !m.isSelf);
          if (after.length) {
            const back = after.filter((m) => m.quoteTargetIsSelf || isDirectedAtAi(String(m.plain || m.text || ''))).length;
            reception = back
              ? `【你上一条之后】${after.length} 条新消息，其中 ${back} 条是在回你。\n`
              : `【你上一条之后】${after.length} 条新消息，没有人在回你。\n`;
          } else {
            reception = '【你上一条之后】还没人说话。\n';
          }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:10996'); }

      // [TOPIC-STACK] 当前话题（最多 3 层）：给检索当 query 的一部分，跨话题不断线
      try {
        // 话题取"第一句真正的话"：跳过 [图片]/[拍一拍]/[表情] 这类事件行，否则话题栈会被系统事件污染
        const segRows = segs[segs.length - 1] || [];
        const readable = segRows
          .map((r) => r.line.replace(/^#\d+\s*\[[^\]]*\]\s*/, ''))
          .find((s) => s && !/^\[(图片|表情|拍一拍|视频|语音|链接)\]/.test(s));
        const gist = String(readable || '').slice(0, 40);
        if (gist) {
          const stack = Array.isArray(st.topicStack) ? st.topicStack : [];
          if (stack[0]?.gist !== gist) { stack.unshift({ gist, at: Date.now() }); st.topicStack = stack.slice(0, 3); }
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:11010'); }

      const fact = directed
        ? `这 ${msgs.length} 条里，直接对你的有 ${directed} 条。`
        : `这 ${msgs.length} 条里，没有一条是直接对你说的。`;

      // [OBS] 可机检证据 + 计数（供 scripts/report-group-precision.mjs 算率）
      try {
        const m = st.metrics = st.metrics || { wakes: 0, wakesDirected: 0, sends: 0, sendsUndirected: 0, pickedUp: 0, missedDirected: 0 };
        const now = Date.now();
        if (!st.lastStructAt || now - st.lastStructAt > 5000) {
          if (st.pendingDirectedWake && !st.sentAfterWake) m.missedDirected += 1;
          m.wakes += 1;
          if (directed) m.wakesDirected += 1;
          st.pendingDirectedWake = directed > 0;
          st.sentAfterWake = false;
          st.lastStructAt = now;
        }
        if (/是在回你/.test(reception) && st.awaitingPickup) { m.pickedUp += 1; st.awaitingPickup = false; }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:11029'); }
      try { log(`[dialog-struct] ${msgs.length} 条，直接对她 ${directed} 条，段数 ${segs.length}`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-affect-service.mjs:11030'); }

      return `【谁在对谁说】（关系是从引用/@字段读出来的，不是猜的）\n${segText}\n事实：${fact}\n${reception}\n`;
    } catch { return ''; }
  }

  // [SILENT-WAKE] 没有由头的唤醒（概率/恢复）：给事实+许可，不替她决定说不说。

  return { affectWhoLabel, prepareAffectHint, secretaryJudgeForWake, scheduleWakeWithSecretary, dialogStructureBlock };
}
