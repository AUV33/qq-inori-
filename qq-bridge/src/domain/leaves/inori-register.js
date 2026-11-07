// inori-register.js · 语言风格的"学习"：从场合里量出目标，再看自己偏了多少
//
// 分工（2026-10-25 owner 定案：她应该是个自由的孩子，规矩少一点，判定权归她）：
//   结构（多长、几条、打不打标点）→ 确定性量出，给档位提示（机械层，不涉及人格）。
//   语气词/口癖 → **可以学**，不再禁止：统计层把"场合常用 vs 我自己常用"当事实递出
//   （computeStyleStats.particleRate + 群成员画像 voice 层），学不学、学哪个全凭她自己判断。
//   脚手架只递事实，不做家长。
//
// 判据全部可算：
//   - 场合目标：取对方/群里最近 N 条，算平均句长与短句率
//   - 自己的现状：取自己最近 M 条，算同样的指标
//   - 差距：自己比场合长多少字 → 给一条具体的提示（不是"你要像人一点"这种没法执行的空话）

export const DEFAULTS = {
  sceneSample: 12,      // 取多少条别人说的话
  selfSample: 20,       // 取多少条自己说的话
  shortMax: 6,          // "短句"的阈值（真人基线：≤6 字占 58.2%）
  longGapChars: 2.5,    // 自己平均比场合长多少字才提醒
  minSamples: 4,        // 样本太少不下结论
  targetFloor: 5,       // 目标句长下限
  targetCeil: 14,       // 目标句长上限
  shortRatioGap: 0.25,  // 对方短句率比自己高这么多就算"太长"（只看平均句长会漏判）
  // [Q] 问句维度（2026-10-26 优化）：场合问句率高、她几乎不问 → 给一句软提示。
  // 只上这一维：语气词/表情容易催成"表演味"，先不动。
  questionSceneMin: 0.12, // 场合至少 12% 的消息是问句，才谈得上"该问一句"
  questionMineMax: 0.03,   // 她近 20 条里问句 ≤3% 才算"不问"
  questionMinSamples: 8,   // 两边样本都要够，别拿三条话下结论
};

const len = (t) => [...String(t ?? '')].length;

/** 一组消息的结构统计 */
export function computeStyleStats(texts, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const arr = (texts ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!arr.length) return { n: 0 };
  const lens = arr.map(len).sort((a, b) => a - b);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const median = lens[Math.floor(lens.length / 2)];
  const short = arr.filter((t) => len(t) <= o.shortMax).length;
  const multiComma = arr.filter((t) => (t.match(/[，,、]/g) ?? []).length >= 2).length;
  // [Q] 中文疑问句大多不带问号（「你几点睡」「这个怎么弄」），只认 ? 会把问句率压到 0。
  const QRE = /[?？]|吗|呢|怎么|为什么|什么|哪个|哪里|哪儿|哪|谁|多少|几点|几个|几天|是不是|能不能|会不会|有没有|要不要|好不好|行不行/;
  const question = arr.filter((t) => QRE.test(t)).length;
  const emoji = arr.filter((t) => /[\u{1F300}-\u{1FAFF}]/u.test(t)).length;
  // [PARTICLE] 语气词事实层：以常见语气词收尾的消息占比（只递事实，学不学是她的事）
  const PARTICLES = new Set(['吧', '呢', '嘛', '哦', '啦', '呀', '咯', '呗', '啊', '嗯', '哈', '哒', '喔']);
  const particle = arr.filter((t) => PARTICLES.has([...t].pop())).length;
  return {
    n: arr.length,
    avgLen: +avg.toFixed(1),
    medianLen: median,
    shortRatio: +(short / arr.length).toFixed(3),
    multiCommaRatio: +(multiComma / arr.length).toFixed(3),
    questionRate: +(question / arr.length).toFixed(3),
    emojiRate: +(emoji / arr.length).toFixed(3),
    particleRate: +(particle / arr.length).toFixed(3),
  };
}

/** 从场合统计推出"这时该多长" */
export function targetFromScene(scene, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!scene || !scene.n || scene.n < o.minSamples) return null;
  // 略高于场合本身：她可以比对方稍完整一点，但不该长一倍
  const targetAvg = Math.min(o.targetCeil, Math.max(o.targetFloor, +(scene.avgLen * 1.15).toFixed(1)));
  const targetShort = Math.min(0.8, Math.max(0.2, scene.shortRatio));
  return { targetAvg, targetShort, targetMedian: Math.max(3, Math.round(scene.medianLen * 1.1)), targetQuestion: Number(scene.questionRate) || 0 };
}

/**
 * 比较自己 vs 目标，给一句能执行的话
 * @returns {{ok:boolean, gap:number, verdict:'too_long'|'ok'|'too_short'|'no_data', hint:string}|null}
 */
export function evaluateStyle(mine, target, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!mine || mine.n < o.minSamples || !target) return { ok: false, verdict: 'no_data', gap: 0, hint: '' };
  const gap = +(mine.avgLen - target.targetAvg).toFixed(1);
  const shortGap = +(target.targetShort - (mine.shortRatio ?? 0)).toFixed(3);
  // 只看平均句长会漏判：群里场合短句率 58%、她 0%，平均却可能只差 0.7 字。
  // 所以短句率差得太多也算"太长"，提示落在"多分条、多短句"而不是"字数"上。
  if (gap > o.longGapChars) {
    return {
      ok: true, gap, shortGap, verdict: 'too_long',
      hint: `这会儿一句平均 ${target.targetAvg} 字，你现在平均 ${mine.avgLen} 字。短一点：一句话一条，长的拆开说。`,
    };
  }
  if (shortGap > o.shortRatioGap) {
    return {
      ok: true, gap, shortGap, verdict: 'too_long',
      hint: `这会儿大家说话一半都是几个字的短句，你的话偏整。多断几句：一句话一条，别攒成一段。`,
    };
  }
  if (gap < -o.longGapChars) {
    return { ok: true, gap, shortGap, verdict: 'too_short', hint: `这会儿大家一句平均 ${target.targetAvg} 字，你现在平均 ${mine.avgLen} 字——短了。这次可以说得完整一点，不用一句就停。` };
  }
  return { ok: true, gap, shortGap, verdict: 'ok', hint: '' };
}

/**
 * [Q] 问句维度的软提示：场合问得多、她几乎不问时给一句。
 * 只递事实 + 许可，不催；样本不够/场合本来就不问 → 返回 null（不造暗示）。
 */
export function questionHint(scene, mine, target, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!scene || !mine || !target) return null;
  if (Number(scene.n) < Number(o.questionMinSamples) || Number(mine.n) < Number(o.questionMinSamples)) return null;
  const sq = Number(target.targetQuestion ?? scene.questionRate ?? 0);
  const mq = Number(mine.questionRate ?? 0);
  if (!(sq >= Number(o.questionSceneMin))) return null;
  if (!(mq <= Number(o.questionMineMax))) return null;
  return `这会儿群里大约 ${Math.round(sq * 100)}% 的话是问句，你最近 ${mine.n} 条里 ${Math.round(mq * 100)}%。真有想问的就问一句，不用等着被问；没想问的就不用硬问。`;
}

/** 一行日志用 */
export function describeStyle(scene, mine, evalResult) {
  const s = scene?.n ? `场合 ${scene.n} 条/平均 ${scene.avgLen} 字` : '场合样本不足';
  const m = mine?.n ? `我 ${mine.n} 条/平均 ${mine.avgLen} 字` : '我没有样本';
  const v = evalResult?.verdict ?? 'no_data';
  return `${s} · ${m} · ${v}${evalResult?.gap ? `（差 ${evalResult.gap} 字）` : ''}`;
}
