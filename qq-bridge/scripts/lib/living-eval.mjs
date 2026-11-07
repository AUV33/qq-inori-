// living-eval.mjs · 宪章 M4/G10：把"像不像她"从观察者感觉变成可回归的场景集
//
// 干什么：场景（输入 + 期望的指代/动作/表达）→ 跑策略 → 逐条断言 → 通过率；
//   以及风格指纹（句长/表情/问句/感叹/第一人称）与基线漂移。
// 为什么：M4 要求"每次人格/风格变更跑回归，指标化"；没有 replay 集，所有"世界级"都只是叙事。
// 输入输出：纯函数；不调模型、不联网、不读盘（runner 注入）。
// 失败模式：缺期望字段跳过该断言；坏场景计失败并带原因。
// 不做什么：不生成文本、不评分"好坏"；只对照声明的期望。

export const LIVING_EVAL_VERSION = 1;

/** 单场景断言：只检查 scenario.expect 里声明了的字段。 */
export function evaluateScenario(scenario, actual = {}) {
  const failures = [];
  const expect = scenario?.expect || {};
  const seen = {
    addressee: actual.addressee ?? actual.perception?.addressee,
    speechAct: actual.speechAct ?? actual.perception?.speechAct,
    move: actual.move ?? actual.move?.move,
    text: actual.text,
    ambiguity: actual.ambiguity ?? actual.perception?.ambiguity,
  };
  for (const key of ['addressee', 'speechAct', 'move']) {
    if (expect[key] !== undefined && seen[key] !== expect[key]) failures.push({ field: key, expected: expect[key], actual: seen[key] });
  }
  if (expect.maxAmbiguity !== undefined && Number(seen.ambiguity) > Number(expect.maxAmbiguity)) {
    failures.push({ field: 'ambiguity', expected: `<=${expect.maxAmbiguity}`, actual: seen.ambiguity });
  }
  for (const part of Array.isArray(expect.contains) ? expect.contains : []) {
    if (!String(seen.text ?? '').includes(part)) failures.push({ field: 'contains', expected: part });
  }
  for (const part of Array.isArray(expect.notContains) ? expect.notContains : []) {
    if (String(seen.text ?? '').includes(part)) failures.push({ field: 'notContains', expected: part });
  }
  return { id: scenario?.id || '(无 id)', ok: failures.length === 0, failures };
}

export function runLivingEval({ scenarios, runner } = {}) {
  const rows = [];
  for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
    try {
      const actual = runner(scenario);
      rows.push(evaluateScenario(scenario, actual));
    } catch (error) {
      rows.push({ id: scenario?.id || '(无 id)', ok: false, failures: [{ field: 'runner', expected: '不抛错', actual: String(error?.message ?? error) }] });
    }
  }
  const passed = rows.filter((r) => r.ok).length;
  return {
    v: LIVING_EVAL_VERSION,
    total: rows.length,
    passed,
    failed: rows.length - passed,
    passRate: rows.length ? Math.round((passed / rows.length) * 1000) / 1000 : 0,
    rows,
  };
}

const CJK = /[\u4e00-\u9fff]/;
export function styleFingerprint(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).filter(Boolean);
  const total = list.length || 1;
  const chars = list.reduce((n, t) => n + [...t].length, 0);
  const count = (re) => list.filter((t) => re.test(t)).length / total;
  return {
    version: LIVING_EVAL_VERSION,
    samples: list.length,
    avgChars: Math.round((chars / total) * 100) / 100,
    emojiRate: Math.round(count(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u) * 1000) / 1000,
    questionRate: Math.round(count(/[?？]/) * 1000) / 1000,
    exclaimRate: Math.round(count(/[!！]/) * 1000) / 1000,
    firstPersonRate: Math.round(count(/^我|我(?:觉得|想|是)/) * 1000) / 1000,
    cjkRate: Math.round((list.filter((t) => CJK.test(t)).length / total) * 1000) / 1000,
  };
}

/**
 * 风格漂移：逐指标相对差值；超过 maxDelta 或任一指标越界则 drift=true。
 * @param {object} baseline
 * @param {object} current
 * @param {{maxDelta?:number}} [opts]
 */
export function styleDrift(baseline, current, { maxDelta = 0.25 } = {}) {
  const keys = ['avgChars', 'emojiRate', 'questionRate', 'exclaimRate', 'firstPersonRate', 'cjkRate'];
  const deltas = {};
  let worst = 0;
  for (const key of keys) {
    const b = Number(baseline?.[key]);
    const c = Number(current?.[key]);
    if (!Number.isFinite(b) || !Number.isFinite(c)) continue;
    const denom = Math.max(1, Math.abs(b));
    const delta = Math.round(((c - b) / denom) * 1000) / 1000;
    deltas[key] = delta;
    worst = Math.max(worst, Math.abs(delta));
  }
  return {
    version: LIVING_EVAL_VERSION,
    drift: worst > maxDelta,
    worst: Math.round(worst * 1000) / 1000,
    maxDelta,
    deltas,
  };
}
