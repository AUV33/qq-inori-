// turn-taking.js · 运行时「轮到谁了」判断（floor control），替代人设卡里的节奏死规矩
//
// 依据（2026-10 调研）：
//   · 文本多 party 的正解是 addressee recognition（这句冲谁说）+ turn-taking（现在轮不轮到我）；
//     MADNet（arXiv 2305.12733）/ EMNLP 2024《Multi-Party Hangover》（arXiv 2409.18602，
//     代码 github.com/dhfbk/MPH）都在这条线上；语音侧 pipecat smart-turn 不适用。
//   · MPH 的结论对我们有直接指导：**addressee 靠结构（谁回谁、reply 链），response 靠文本**。
//     所以 2026-10-28 完善版补了结构信号（replyToHer / othersReplied / 实际接话间隔分位），
//     并把「被接住率」接回来自适应开口阈值——原来阈值 0.22 是拍脑袋常数。
//   · 可参考的现成中文文本 turn 模型：github.com/xcc-zach/xturnix（keep/start/stop），
//     但引入 0.6B 推理前应先用群历史离线评测，不在本模块里做。
//
// 设计纪律：
//   · 纯函数、零 IO、零随机（随机由 shouldWake 注入），可单测；
//   · 只回答「该不该接 / 等多久」，不碰说什么、不碰人设；
//   · 被点名/被引用永远放行（directed 不受任何降权影响）；
//   · 新增输入一律可选：不传就回落到旧行为，线上/单测不会因为缺字段变样。

export const FLOOR_DEFAULTS = Object.freeze({
  minReply: 0.22,       // 低于这个就这轮不开口（消息留未读，下次还有机会）
  maxHoldMs: 12000,     // 开口前停顿上限
  // 自适应阈值的边界：被接住率高 → 更愿意开口；低 → 更保守。别让它在极端数据上跑飞。
  // [THRESHOLD-CAP] 上限不能高于「群里没点她」的日常基数 0.28（见 decideFloor ①）：
  // 旧值 0.45 在 hits=0 时把阈值抬到 0.35 > 0.28，群里除「点她」外一律不可能开口
  // （group:123456789 2026-10-30 实测：sends=51/pickedUp=0，17:46 起连续 0 开口）。
  minReplyFloor: 0.12,
  minReplyCeil: 0.26,
  adaptMinSamples: 5,   // 少于 5 个样本不改阈值（小样本噪声大）
  fastGapFallbackMs: 45_000,
  slowGapFallbackMs: 120_000,
});

const DIRECTED_REASONS = new Set(['atMention', 'nameMention', 'poke', 'atSplit', 'keyword', 'aboutSelf']);
const QUESTION_REASONS = new Set(['question']);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * @param {object} ctx
 * @param {'private'|'group'} [ctx.kind]
 * @param {string} [ctx.reason] 唤醒原因（atMention/question/probability/continueChat…）
 * @param {boolean} [ctx.directed] 是否点她；不传则按 reason 推
 * @param {string} [ctx.addressee] local-judge 的 target：你|别人|自己|无
 * @param {number} [ctx.sameSenderBurst] 同一人最近 30 秒发了几条
 * @param {number} [ctx.herRecentSends] 她最近 3 分钟发了几条
 * @param {number} [ctx.sinceHerSendMs] 距她上次发言多久
 * @param {boolean} [ctx.othersReplied] 她上次发言之后，有没有别人接过话
 * @param {boolean} [ctx.replyToHer] 最新这条是不是**直接回她**（引用/回复了她）——结构信号
 * @param {number} [ctx.gapP50Ms] 群里「她说完 → 有人接」的中位间隔（数据来自实际 sendTimes×消息）
 * @param {number} [ctx.gapP75Ms] 同一分布的 75 分位
 * @param {number} [ctx.hitRate] 最近她的开口被接住的比例 0..1（自适应阈值用）
 * @param {number} [ctx.hitSamples] 上述比例的样本数（< adaptMinSamples 不调阈值）
 * @param {number} [ctx.groupRatePerMin] 最近 10 分钟群消息/分钟
 * @param {number} [ctx.minReplyOverride] 她自己调的阈值（self-tune，优先于自适应/默认）
 * @param {number} [ctx.holdScale] 她自己调的停顿倍数（0.5–2）
 * @param {number} [ctx.hour] 0..23
 * @param {boolean} [ctx.asleep]
 * @returns {{attend:number, reply:number, holdMs:number, minReply:number, why:string, directed:boolean}}
 */
export function decideFloor(ctx = {}) {
  const kind = ctx.kind === 'private' ? 'private' : 'group';
  const reason = String(ctx.reason || '').split(':')[0];
  const directed = ctx.directed != null ? !!ctx.directed : DIRECTED_REASONS.has(reason);
  const question = QUESTION_REASONS.has(reason);
  const addressee = String(ctx.addressee || '');
  const burst = num(ctx.sameSenderBurst, 0);
  const herSends = num(ctx.herRecentSends, 0);
  const sinceSend = num(ctx.sinceHerSendMs, Infinity);
  const othersReplied = !!ctx.othersReplied;
  const replyToHer = !!ctx.replyToHer;
  const rate = num(ctx.groupRatePerMin, 0);
  const hour = num(ctx.hour, new Date().getHours());
  const asleep = !!ctx.asleep;
  const gapP50 = Number.isFinite(Number(ctx.gapP50Ms)) ? Number(ctx.gapP50Ms) : null;
  const gapP75 = Number.isFinite(Number(ctx.gapP75Ms)) ? Number(ctx.gapP75Ms) : null;
  const hitRate = Number.isFinite(Number(ctx.hitRate)) ? Number(ctx.hitRate) : null;
  const hitSamples = num(ctx.hitSamples, 0);
  // [SELF-TUNE] 她自己调的参数（白名单+硬边界在 self-tune.mjs；这里再夹一次，防坏文件）。
  const minReplyOverride = Number.isFinite(Number(ctx.minReplyOverride))
    ? clamp(Number(ctx.minReplyOverride), 0.05, 0.6)
    : null;
  const holdScale = Number.isFinite(Number(ctx.holdScale)) ? clamp(Number(ctx.holdScale), 0.5, 2) : 1;

  const why = [];
  let attend;
  let reply;
  let holdMs;

  // ① 基线：谁在等
  if (kind === 'private') {
    attend = 0.9; reply = 0.85; holdMs = 400; why.push('私聊');
    if (directed) { reply = 0.95; holdMs = 300; why.push('点她'); }
  } else if (directed) {
    attend = 0.95; reply = 0.85; holdMs = 900; why.push('群里点她');
  } else if (question) {
    attend = 0.7; reply = 0.5; holdMs = 2500; why.push('群里提问但没点她');
  } else {
    attend = 0.45; reply = 0.28; holdMs = 4000; why.push('群里没点她');
  }

  // ② 这句冲谁说（local-judge 的 target，没有就跳过）
  if (addressee === '别人') { reply *= 0.2; why.push('冲别人说的'); }
  else if (addressee === '你') { reply = Math.min(1, reply * 1.35); why.push('冲她说的'); }
  // ②b 结构信号：这条直接回她（引用/回复了她）。MPH 2024 的结论是 addressee 靠结构，
  //     文本 judge 常常看不出「回的是她」，但 quoteTargetIsSelf 是硬事实。
  if (replyToHer) { reply = Math.max(reply, 0.8); why.push('这条直接回她'); }

  // ③ 对方在连发：等他说完，别插半句
  if (burst >= 2) { holdMs += 2500; reply *= 0.75; why.push('对方连发，等他说完'); }

  // ④ 她自己刚说了多少（说完要让出回合）。
  //    旧实现用 45s / 120s 两个拍脑袋常数；有实测分位就用实测值（夹在 10s–10min 防脏数据）。
  const fastGap = clamp(gapP50 ?? FLOOR_DEFAULTS.fastGapFallbackMs, 10_000, 600_000);
  const slowGap = clamp(gapP75 ?? FLOOR_DEFAULTS.slowGapFallbackMs, fastGap, 600_000);
  if (herSends >= 1 && sinceSend < fastGap) {
    reply *= 0.35; holdMs += 3000;
    why.push(`${Math.round(fastGap / 1000)} 秒内刚说过${gapP50 != null ? '（实测中位）' : ''}`);
  } else if (herSends >= 1 && sinceSend < slowGap) {
    reply *= 0.65; holdMs += 1500;
    why.push(`${Math.round(slowGap / 1000)} 秒内说过${gapP75 != null ? '（实测 75 分位）' : ''}`);
  }
  if (herSends >= 3) { reply *= 0.6; why.push(`三分钟内已说 ${herSends} 条`); }

  // ⑤ 已经有人接他了：把场子让给别人。
  // [PRIVATE-FLOOR] 只对群聊生效（2026-10-30）：私聊里「她上次发言之后有人说过话」= 主人自己回了一句，
  // 那不是「别人接了他」，而是对话在继续。旧实现把它 ×0.45 → 私聊 reply 0.85→0.38，
  // 14:52 / 14:53 两次掷骰因此没过（p=0.60，r=0.88/0.67），加上 02:01 再叠「睡着×0.4」，
  // 私聊 13 条未读从 23:44 起一条没回。
  if (kind === 'group' && othersReplied) { reply *= 0.45; why.push('已经有人接他'); }

  // ⑥ 群很热闹且没点她：别凑
  if (kind === 'group' && rate >= 8 && !directed) { reply *= 0.6; why.push('群里很热闹'); }

  // ⑦ 凌晨 / 睡着
  if (kind === 'group' && (hour >= 0 && hour < 7)) { reply *= 0.6; holdMs *= 1.5; why.push('凌晨'); }
  // [PRIVATE-FLOOR] 私聊睡着只轻降（×0.7，不是 ×0.4）：主人半夜发消息是想她回，
  // 不是等她睡醒；0.85×0.7=0.595 仍远高于 0.22 阈值，p≈0.74。
  if (asleep && !directed) { reply *= kind === 'private' ? 0.7 : 0.4; holdMs *= 1.5; why.push('睡着'); }

  // 被点名：上面所有降权都不该把她按死
  if (directed) reply = Math.max(reply, 0.7);

  // ⑧ 自适应开口阈值（把「被接住率」接回来）：
  //    以前 0.22 是常数，没人知道为什么。现在用最近实际「她开口 → 有人接」的比例调：
  //    接住率高说明她开口是受欢迎的 → 阈值降；低 → 阈值升（宁可少说）。
  //    样本不足（< adaptMinSamples）或没给 hitRate 时保持默认，行为和旧版一致。
  let minReply = FLOOR_DEFAULTS.minReply;
  if (hitRate != null && hitSamples >= FLOOR_DEFAULTS.adaptMinSamples) {
    minReply = clamp(0.35 - 0.25 * clamp(hitRate, 0, 1), FLOOR_DEFAULTS.minReplyFloor, FLOOR_DEFAULTS.minReplyCeil);
    why.push(`阈值 ${minReply.toFixed(2)}（被接住 ${Math.round(hitRate * 100)}%/n=${hitSamples}）`);
  }
  // 她自己设的值优先于自适应/默认（她说了算；边界与白名单由 self-tune 把关）
  if (minReplyOverride != null) {
    minReply = minReplyOverride;
    why.push(`她自己把阈值调到 ${minReply.toFixed(2)}`);
  }

  const finalHold = Math.round(clamp(holdMs * holdScale, 0, FLOOR_DEFAULTS.maxHoldMs));
  if (holdScale !== 1) why.push(`停顿 ×${holdScale}`);

  return {
    attend: clamp(attend, 0, 1),
    reply: clamp(reply, 0, 0.95),
    holdMs: finalHold,
    minReply,
    directed,
    why: why.join('，'),
  };
}

/**
 * 这轮到底唤不唤醒。
 * 纪律：被点名一律唤醒；其余按 reply 概率 + 下限。消息不会被丢弃（留在未读里）。
 * 阈值优先级：显式 opts.minReply > floor.minReply（自适应）> FLOOR_DEFAULTS.minReply。
 * @param {{reply:number,directed:boolean,minReply?:number}} floor
 * @param {{minReply?:number, random?:()=>number}} [opts]
 * @returns {{wake:boolean, why:string}}
 */
export function shouldWake(floor, opts = {}) {
  const { random = Math.random } = opts;
  if (!floor || typeof floor.reply !== 'number') return { wake: true, why: '没有判断结果，照常唤醒' };
  if (floor.directed) return { wake: true, why: '点她，必醒' };
  const minReply = opts.minReply
    ?? (Number.isFinite(floor.minReply) ? floor.minReply : FLOOR_DEFAULTS.minReply);
  if (floor.reply < minReply) return { wake: false, why: `reply=${floor.reply.toFixed(2)} 低于 ${minReply.toFixed ? minReply.toFixed(2) : minReply}` };
  const p = clamp(0.35 + floor.reply * 0.65, 0, 0.95);
  const r = random();
  return { wake: r < p, why: `p=${p.toFixed(2)} r=${r.toFixed(2)} reply=${floor.reply.toFixed(2)}` };
}

// ── [OTHERS-REPLIED] 「有人接了她这一句」的时间窗 ────────────────────────────
// 旧实现只问「她最后一条发出去之后，群里有没有人说过话」——在活跃群里恒为真，
// 于是 ×0.45 永久生效（日常 0.28→0.126、提问 0.5→0.225），再叠加自适应阈值 0.35
// 就变成「除非点她，否则永不开口」。这里改成「她发完 120 秒内有人接」才算：
// 超过两分钟才有人说话，那是新的对话，不是接她。
export const OTHERS_REPLIED_WINDOW_MS = 120_000;

/**
 * @param {number[]} incomingTimes 群友消息时间戳（不含她自己）
 * @param {number|null} lastSendAt 她最后一条的发送时间
 * @param {number} [windowMs]
 * @returns {boolean} 她发完之后 windowMs 内是否有人紧接着说过话
 */
export function othersRepliedSoon(incomingTimes, lastSendAt, windowMs = OTHERS_REPLIED_WINDOW_MS) {
  const last = Number(lastSendAt);
  if (!Number.isFinite(last)) return false;
  const next = (Array.isArray(incomingTimes) ? incomingTimes : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > last)
    .sort((a, b) => a - b)[0];
  return next != null && next - last <= windowMs;
}

// ── 自适应阈值的「阀门」──────────────────────────────────────────────────────
// 为什么单独抽出来：阈值自适应最怕两件事——①样本太少拿噪声当信号；②一次异常流量
// 把阈值甩到边界后再也回不来。这里把「什么时候才允许改」写成纯函数，线上/单测同一套规则。
export const ADAPTIVE_DEFAULTS = Object.freeze({
  minSamples: 5,   // 少于 5 次开口样本不动
  maxJump: 0.2,    // 与上次生效值相差 >20pp 视为突变，本轮不采纳
});

/**
 * @param {object} p
 * @param {number} [p.prevRate] 上一次**已生效**的命中率
 * @param {number} [p.prevSamples] 上一次的样本数
 * @param {number} [p.newRate] 这次算出来的命中率（pickedUp / sends）
 * @param {number} [p.samples] 这次算命中率的样本数（sends）
 * @param {boolean} [p.enabled] config.floor.adaptive（默认 true）
 * @param {number} [p.minSamples]
 * @param {number} [p.maxJump]
 * @returns {{rate:number|null, n:number, blocked:boolean, reason:'applied'|'disabled'|'samples'|'jump', prev:number|null, next:number|null, from?:number, to?:number}}
 */
export function applyAdaptiveGuard({
  prevRate,
  prevSamples = 0,
  newRate,
  samples = 0,
  enabled = true,
  minSamples = ADAPTIVE_DEFAULTS.minSamples,
  maxJump = ADAPTIVE_DEFAULTS.maxJump,
} = {}) {
  const prev = Number.isFinite(Number(prevRate)) ? clamp(Number(prevRate), 0, 1) : null;
  const prevN = Math.max(0, Number(prevSamples) || 0);
  if (!enabled) return { rate: null, n: 0, blocked: true, reason: 'disabled', prev, next: null };
  const next = Number.isFinite(Number(newRate)) ? clamp(Number(newRate), 0, 1) : null;
  if (next == null || Number(samples) < minSamples) {
    return { rate: prev, n: prev == null ? 0 : prevN, blocked: true, reason: 'samples', prev, next };
  }
  if (prev != null && Math.abs(next - prev) > maxJump) {
    return { rate: prev, n: prevN, blocked: true, reason: 'jump', prev, next, from: prev, to: next };
  }
  return { rate: next, n: Number(samples), blocked: false, reason: 'applied', prev, next };
}
