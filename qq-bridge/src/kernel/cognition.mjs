// kernel/cognition.mjs · 决策与反思：让"想过的事"真的改变下一次行为。
//
// 干什么：decide() 从当前状态选出内生意图（不是只被消息触发）；reflect() 从窗口事件
//         提炼经验（lesson），并把它交给下一次 decide 引用，引用次数可度量。
// 为什么：旧系统 lesson 有 35 条、反思整夜零产出，且 lesson 注入与决策之间没有证据链，
//         "经验改变行为"(R7) 无法证明。这里把闭环做成纯函数：反思 → lesson → 决策引用 → 行为不同。
// 输入输出：纯函数；不调模型（模型只负责把 intention 变成话，属于 act 端口）。
// 失败模式：空窗口不硬凑 lesson（"今天没有"就是没有）；无匹配经验不伪造引用。
// 不做什么：不写状态（由 kernel 把结果作为事件交给 reducer）、不生成回复文本。

import { normalizeState } from './state.mjs';

export const INTENTIONS = Object.freeze([
  'reply', 'initiate', 'continue', 'repair', 'reflect', 'consolidate', 'learn', 'explore', 'rest', 'selfcare', 'plan',
]);

/**
 * 意图优先级：满足生理需要 > 兑现关系 > 回应 > 内生动机 > 成长。
 * opts.model 可选注入（同步函数，入参为状态快照与规则给出的候选）；返回 null/非法值即回退规则，
 * 保证离线确定性与可测性。模型只参与判断，不负责生成回复文本（那是 act 端口）。
 */
export function decide(state, opts = {}) {
  const s = normalizeState(state);
  const now = Number(opts.now) || s.at;
  const unread = s.unread.length;
  const finish = (chosen) => {
    if (typeof opts.model === 'function') {
      try {
        const m = opts.model({ state: s, rule: chosen, lessons: s.lessons, contextText: opts.contextText || '' });
        if (m && typeof m === 'object' && INTENTIONS.includes(m.selected)) {
          return {
            selected: m.selected,
            reason: String(m.reason || `模型判断（规则建议 ${chosen.selected}）`),
            at: now,
            usedLessonId: m.usedLessonId ?? chosen.usedLessonId,
            usedLessonText: m.usedLessonText ?? chosen.usedLessonText,
            explainable: true,
            source: 'model',
            ...(chosen.goalId ? { goalId: chosen.goalId, goalText: chosen.goalText } : {}),
          };
        }
      } catch { /* 模型失败一律回退规则，绝不让内核卡住 */ }
    }
    return { ...chosen, source: 'rule' };
  };

  // 1) 有限性优先：累了必须休息。这是硬约束，模型不得覆盖（不让她被"想聊天"抽干）。
  if (s.sleeping || s.energy < 0.18 || s.sleepDebt > 0.8) {
    return { ...intention('rest', '精力不足/睡眠债过高', null, now), source: 'vital' };
  }
  // 1b) 注意力见底：不是故障，是她此刻真的转不动（§5.19 注意力是可耗竭资源）。
  if (s.attention < 0.12) return { ...intention('rest', `注意力见底 ${s.attention.toFixed(2)}`, null, now), source: 'vital' };
  // 2) 经验真的改变行为：命中"主动找人没被接住"时，先自省而不是继续打扰。
  // 要在**全部经验**里找这一条，而不是只看"最新一条"——否则后面形成的目标/承诺经验
  // 会把这条挤掉，闭环在真实序列里又会退化成无引用。
  const noReplyLesson = (s.lessons || []).find((l) => /没被接住|缓一缓|别连着发/.test(String(l?.text || '')));
  const initiateAge = s.lastInitiateAt > 0 ? now - s.lastInitiateAt : Infinity;
  const recentlyHeld = (s.lessonRefs || []).some((ref) => ref.id === noReplyLesson?.id && now - ref.at < 24 * 3600000);
  if (noReplyLesson && s.socialHunger > 0.5 && initiateAge < 24 * 3600000 && !recentlyHeld) {
    return finish(intention('reflect', `经验「${noReplyLesson.text}」改变了原本的主动发起`, noReplyLesson, now));
  }
  // 3) 关系兑现：有人等着就回。
  if (unread > 0) return finish(intention('reply', `${unread} 条未回应`, null, now));
  // 4) 内生动机：没有消息，她也会因为孤独/好奇/累而自己想做点什么。
  if (s.socialHunger > 0.62) return finish(intention('initiate', `社交饥饿 ${s.socialHunger.toFixed(2)}`, null, now));
  if (s.curiosity > 0.72) return finish(intention('explore', `好奇 ${s.curiosity.toFixed(2)}`, null, now));
  // 4b) 她自己立的目标：不需要系统催，挂着的目标本身就是动机（L2 欲望层）。
  const activeGoal = (s.goals || []).find((g) => g.status === 'active' && !g.stale);
  const activePlan = (s.plans || []).find((p) => p.status === 'active');
  // [G1] 推进目标需要多步规划时，进入 plan 意图（由 DSH 执行循环逐步完成），而非只探索一下。
  // 仅当没有进行中的 plan 时才触发，避免每拍重复开新 plan 把状态打爆。
  // 目标动机不是经验命中：不能把"最新一条经验"挂到这个决策上（P2-10，R7 指标要真）。
  if (activeGoal && s.energy > 0.35 && !activePlan) {
    const planIntent = intention('plan', `推进目标「${activeGoal.text}」需分步规划`, null, now);
    planIntent.goalId = activeGoal.id;
    planIntent.goalText = activeGoal.text;
    return finish(planIntent);
  }
  // 4c) 自我信任低且压力大：先照顾自己，而不是继续产出（§5.3）。
  if (s.selfTrust < 0.3 && s.stress > 0.4) return finish(intention('selfcare', `自我信任 ${s.selfTrust.toFixed(2)} 偏低`, null, now));
  if (s.errors > 0 && s.stress > 0.3) return finish(intention('selfcare', '最近出错且压力大', null, now));
  if (s.ticks > 0 && now - s.lastReflectAt > 20 * 3600000) return finish(intention('reflect', '距上次反思已逾 20h', null, now));
  if (s.lessons.length > 12) return finish(intention('consolidate', '经验过多需整理', null, now));
  return finish(intention('rest', '此刻没有更强动机', null, now));
}

function intention(selected, reason, lesson, now) {
  return {
    selected,
    reason,
    at: now,
    usedLessonId: lesson ? lesson.id : null,
    usedLessonText: lesson ? lesson.text : null,
    explainable: true,
  };
}

/**
 * 按 trigger 匹配经验；没有上下文时让最新一条经验"常驻在场"（与既有 lessons 常驻注入同义）。
 * 这条兜底是闭环的关键：反思刚形成的经验必须能被下一次决策引用，而不是等到一个恰好命中 trigger 的上下文。
 */
export function matchLesson(state, contextText) {
  const s = normalizeState(state);
  if (!s.lessons.length) return null;
  const ctx = String(contextText || '');
  const hit = s.lessons.find((l) => l.trigger && ctx.includes(l.trigger));
  return hit || (ctx ? null : s.lessons[s.lessons.length - 1]);
}

/**
 * 反思：只从窗口事件里提炼"被现实验证过"的经验，不硬凑、不调模型。
 * 判据可机检：连续多次主动发起却没收到回应 → 形成"别连着发"的经验。
 */
export function reflect(state, windowEvents, opts = {}) {
  const s = normalizeState(state);
  const now = Number(opts.now) || s.at;
  const rows = Array.isArray(windowEvents) ? windowEvents : [];
  const initiated = rows.filter((e) => e.type === 'action.taken' && e.payload?.intention === 'initiate').length;
  // "没被接住"要看她**真的发出去的**消息有没有得到回应，而不是数意图：
  // 意图 ≠ 发出，且真实一天里主动发起往往只有 1 次，用意图计数会让反思恒为空产出。
  const sent = rows.filter((e) => e.type === 'message.sent').length;
  const received = rows.filter((e) => e.type === 'message.received').length;
  const errors = rows.filter((e) => e.type === 'error.observed').length;

  const lessons = [];
  const already = new Set(s.lessons.map((l) => String(l.id)));
  const promisesBroken = rows.filter((e) => e.type === 'commitment.broken').length;
  const staleGoals = rows.filter((e) => e.type === 'goal.stale').length;
  if (sent >= 2 && received < sent && !already.has('l-no-reply')) {
    lessons.push({ id: 'l-no-reply', text: '主动找人没被接住时，先缓一缓', trigger: '主动', at: now });
  }
  if (errors >= 2 && !already.has('l-errors')) {
    lessons.push({ id: 'l-errors', text: '反复出错时先停下来查原因，别硬试', trigger: '出错', at: now });
  }
  if (promisesBroken > 0 && !already.has('l-promise-broken')) {
    lessons.push({ id: 'l-promise-broken', text: '答应过的事没做到，要么补上，要么早点说清楚', trigger: '答应', at: now });
  }
  if (staleGoals > 0 && !already.has('l-goal-stale')) {
    lessons.push({ id: 'l-goal-stale', text: '挂着的目标要么往前推一点，要么放下', trigger: '目标', at: now });
  }
  return {
    at: now,
    windowSize: rows.length,
    // 反思不只数事件，也读她此刻的感受：因果情绪要能被她自己看见（§5.2/§5.6）。
    evidence: { initiated, sent, received, errors, promisesBroken, staleGoals, valence: s.valence, mood: s.mood, affect: { ...s.affect } },
    lessons,
    // 空产出是诚实结果，不是失败：旧系统恰恰把"没产出"当成功，才让反思永远沉默。
    empty: lessons.length === 0,
    insight: lessons.length ? lessons.map((l) => l.text).join('；') : '今天没有',
  };
}
