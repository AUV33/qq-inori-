// inori-selfmodel.js · 自我模型：把散落的经验/话风/参数汇成「她最近的样子」
//
// 为什么需要它：lessons/skills/style 都是碎片，她看得见教训，却看不见「我」——
// 不知道自己最近话变短了、不知道追人回报率多少、不知道哪些经验真的在用。
// 这个模块把碎片汇成一段自我认识，每轮注入，让她能基于「我现在的样子」说话/行动。
//
// 设计约束：
// - 纯函数、零依赖：输入都是普通对象，输出普通对象/字符串，便于测试与替换。
// - 只陈述可测的量（字数/回报率/条数/失败次数），不编情绪。
// - 不替她下结论式自我评价（"我很差"），只给事实和"在改什么"。

/** 话风：和场合比是偏短还是偏长 */
export function describeVoice(styleEntry) {
  if (!styleEntry || !styleEntry.mine || !styleEntry.scene) return null;
  const mine = Number(styleEntry.mine.avgLen) || 0;
  const scene = Number(styleEntry.scene.avgLen) || 0;
  if (!mine || !scene) return null;
  const gap = +(mine - scene).toFixed(1);
  let verdict = '差不多';
  if (gap < -3) verdict = '偏短';
  else if (gap > 3) verdict = '偏长';
  return {
    mine: +mine.toFixed(1),
    scene: +scene.toFixed(1),
    gap,
    verdict,
  };
}

/** 追人：今天的次数与回报率 */
export function describeChase(chase, adapt) {
  const c = chase ?? {};
  const count = Math.max(0, Number(c.count) || 0);
  const un = Math.max(0, Number(c.unanswered) || 0);
  const answered = Math.max(0, count - un);
  const rate = count > 0 ? answered / count : 0;
  return {
    count,
    unanswered: un,
    answered,
    rate: +(rate * 100).toFixed(0),
    maxPerDay: Math.max(1, Number(adapt?.maxPerDay) || 3),
  };
}

/** 做事：最近失败与常见失败点（从 traces 里取） */
export function describeWork(traces) {
  const list = Array.isArray(traces) ? traces : [];
  // [SELF-MODEL-FIX] 轨迹写的是 'likely_failed'/'success'/'unknown'（inori-activity），
  // 原来只认 'failed' → 失败数恒 0，「做事」层永远看着一片大好
  const isFail = (t) => t && (t.result === 'failed' || t.result === 'likely_failed' || t.ok === false);
  const isOk = (t) => t && (t.result === 'success' || t.ok === true);
  const failed = list.filter(isFail);
  const ok = list.filter(isOk);
  return {
    total: list.length,
    ok: ok.length,
    failed: failed.length,
    recentFailures: failed.slice(-3).map((t) => ({
      goal: String(t.app ?? t.goal ?? t.task ?? '').slice(0, 40),
      note: t.stuck ? '卡住（同一点位重复点）' : String(t.note ?? t.error ?? '').slice(0, 60),
    })),
  };
}

/**
 * 汇总自我模型。
 * @param {object} input { styleEntry, chase, adapt, traces, lessons }
 * @returns {object} 可直接 JSON 序列化的自我模型
 */
export function buildSelfModel(input = {}) {
  const voice = describeVoice(input.styleEntry);
  const chase = describeChase(input.chase, input.adapt);
  const work = describeWork(input.traces);
  const lessons = Array.isArray(input.lessons) ? input.lessons : [];
  const recentLessons = lessons.slice(-3).map((l) => String(l.text ?? '').slice(0, 60));
  return {
    at: new Date().toISOString(),
    voice,
    chase,
    work,
    lessonCount: lessons.length,
    recentLessons,
  };
}

/** 渲染成给她的 prompt 片段（只陈述事实，不替她评价自己） */
export function renderSelfModel(model) {
  if (!model) return '';
  const lines = [];
  if (model.voice) {
    // [NO-LENGTH-JUDGE] 只报字数事实，不再下"偏短/偏长"的判断、也不再给"说完整一点"的指令。
    const v = model.voice;
    lines.push(`说话：最近一句平均 ${v.mine} 字，这个场合平均 ${v.scene} 字。`);
  }
  if (model.chase && model.chase.count > 0) {
    lines.push(`追人：今天追了 ${model.chase.count} 次，对方回了 ${model.chase.answered} 次（回报率 ${model.chase.rate}%）。`);
  }
  if (model.work && model.work.total > 0) {
    lines.push(`做事：最近 ${model.work.total} 件里成 ${model.work.ok}、败 ${model.work.failed}。`);
    for (const f of model.work.recentFailures) {
      lines.push(`　没做成：${f.goal}${f.note ? '（' + f.note + '）' : ''}`);
    }
  }
  if (model.lessonCount > 0) {
    lines.push(`经验：攒了 ${model.lessonCount} 条。`);
    for (const t of model.recentLessons) lines.push(`　- ${t}`);
  }
  if (!lines.length) return '';
  return `【你最近的样子（从数据里算出来的，不是别人评价你）】\n${lines.join('\n')}`;
}

/**
 * 这条记录是不是「本地时间的今天」。
 *
 * 为什么要有它：evolution.jsonl 里的 `at` 是 UTC ISO（2026-10-28T00:05:25.295Z），
 * 而 dayKey 是本地日期（toLocaleDateString('sv-SE') → 2026-10-28）。
 * 本地 00:00–08:00 之间 UTC 还停在昨天，直接 startsWith 永远对不上 ——
 * 结果每次唤醒都写一条 self_model_snapshot，一天几百条。
 *
 * @param {string} atIso 记录里的 at 字段（ISO 字符串）
 * @param {string} dayKey 本地日期，形如 "2026-10-28"
 * @returns {boolean}
 */
export function isSameLocalDay(atIso, dayKey) {
  if (!atIso || !dayKey) return false;
  const d = new Date(atIso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toLocaleDateString('sv-SE') === String(dayKey);
}
