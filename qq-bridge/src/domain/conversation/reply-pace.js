// [PACE] 场景化回复节奏：按"谁在等、多急、她什么状态、群里多热闹、几点"算一个延迟因子
// 只输出三个数：debounceFactor（唤醒前合批窗口的倍数）、holdMs（真正开口前的停顿）、scene（可日志追溯）
// 设计纪律：纯函数、可单测；不碰 prompt 内容，只碰"多快开口"。

export const PACE_DEFAULTS = {
  baseDebounceMs: 3000,
  baseHoldMs: 1200,
  minDebounceMs: 800,
  maxDebounceMs: 20000,
  minHoldMs: 250,
  maxHoldMs: 9000,
};

const DIRECTED = new Set(['atMention', 'nameMention', 'question', 'poke', 'keyword', 'aboutSelf', 'topicMention', 'atSplit']);
const CASUAL = new Set(['probability', 'anyMessage', 'continueChat', 'joinTopic', 'speaker', 'replyCheck']);
const BACKGROUNDISH = new Set(['recovery', 'timeout', 'proactiveCheck']);

/** 唤醒原因去掉 'reason:extra' 尾巴 */
export function reasonRoot(reason) {
  return String(reason || '').split(':')[0];
}

/**
 * @param {object} ctx
 * @param {'private'|'group'} ctx.kind
 * @param {string} ctx.reason
 * @param {boolean} [ctx.asleep]
 * @param {number} [ctx.energy] 0..1
 * @param {number} [ctx.groupRatePerMin] 最近 10 分钟群消息/分钟
 * @param {number} [ctx.hour] 0..23
 * @returns {{scene:string, factor:number, debounceFactor:number, holdMs:number, why:string}}
 */
export function computeReplyPace(ctx = {}) {
  const kind = ctx.kind === 'private' ? 'private' : 'group';
  const root = reasonRoot(ctx.reason);
  const hour = Number.isFinite(Number(ctx.hour)) ? Number(ctx.hour) : new Date().getHours();
  const energy = Number.isFinite(Number(ctx.energy)) ? Math.max(0, Math.min(1, Number(ctx.energy))) : 0.5;
  const rate = Number.isFinite(Number(ctx.groupRatePerMin)) ? Math.max(0, Number(ctx.groupRatePerMin)) : 0;
  const directed = DIRECTED.has(root);
  const casual = CASUAL.has(root);
  const backgroundish = BACKGROUNDISH.has(root);

  let scene;
  let factor = 1;
  const why = [];

  // ① 基线：谁在等
  if (kind === 'private' && directed) { scene = 'private-urgent'; factor = 0.25; why.push('主人私聊且点名/提问'); }
  else if (kind === 'private') { scene = 'private'; factor = 0.5; why.push('私聊'); }
  else if (directed) { scene = 'group-directed'; factor = 0.6; why.push('群里点她'); }
  else if (casual) { scene = 'group-casual'; factor = 1.8; why.push('群里闲聊/接话，不急着插'); }
  else if (backgroundish) { scene = 'recovery'; factor = 1.2; why.push('补唤醒/超时，不急'); }
  else { scene = 'group-other'; factor = 1.0; why.push('其他'); }

  // ② 夜里：整体放慢（但私聊被点名只放慢一点，别让人等）
  const night = hour >= 0 && hour < 7;
  if (night) {
    const nightFactor = (kind === 'private' && directed) ? 1.4 : 2.0;
    factor *= nightFactor;
    why.push(`凌晨×${nightFactor}`);
  }

  // ③ 她睡着了：更慢；私聊点名仍然要能叫醒（×2 而不是 ×3）
  if (ctx.asleep) {
    const asleepFactor = (kind === 'private' && directed) ? 2.0 : 3.0;
    factor *= asleepFactor;
    why.push(`睡着×${asleepFactor}`);
  }

  // ④ 精力：低精力更慢；高精力且被点名可以更快
  if (energy < 0.25) { factor *= 1.6; why.push('精力低×1.6'); }
  else if (energy > 0.7 && directed) { factor *= 0.85; why.push('精力足×0.85'); }

  // ⑤ 群很热闹：被点名要快点（不然被刷过去）；闲聊别凑热闹
  if (kind === 'group' && rate >= 6) {
    if (directed) { factor *= 0.8; why.push('群速高且点她×0.8'); }
    else if (casual) { factor *= 1.2; why.push('群速高闲聊×1.2'); }
  }

  // ⑥ 她自己刚说了多少（[RHYTHM] 节奏的来源）：说完要让出回合。
  // 实测 2026-10-28 13:06–13:09 三分钟她发了 11 条——因为旧公式里完全没有"我刚说过"这一项。
  // 注意：这里只放慢"多快开口"，不是硬配额，也不吞消息（延迟另有 20s 上限）。
  const sentRecently = Number.isFinite(Number(ctx.recentSendCount)) ? Math.max(0, Number(ctx.recentSendCount)) : 0;
  const sinceSend = Number.isFinite(Number(ctx.lastSendAgoMs)) ? Number(ctx.lastSendAgoMs) : Infinity;
  if (sentRecently >= 1) {
    if (kind === 'group') {
      if (sinceSend < 45_000) { factor *= 2.2; why.push('刚说过话×2.2'); }
      else if (sinceSend < 120_000) { factor *= 1.5; why.push('两分钟内说过×1.5'); }
      if (sentRecently >= 3) { factor *= 1.6; why.push(`三分钟内已说${sentRecently}条×1.6`); }
    } else if (sentRecently >= 2) {
      factor *= 1.4;
      why.push('私聊刚连说×1.4');
    }
  }

  factor = Math.max(0.15, Math.min(6, factor));
  const { minDebounceMs, maxDebounceMs, minHoldMs, maxHoldMs, baseDebounceMs } = PACE_DEFAULTS;
  const debounceMs = Math.max(minDebounceMs, Math.min(maxDebounceMs, Math.round(baseDebounceMs * factor)));
  const holdMs = Math.max(minHoldMs, Math.min(maxHoldMs, Math.round(PACE_DEFAULTS.baseHoldMs * factor)));

  return { scene, factor: Math.round(factor * 100) / 100, debounceFactor: factor, holdMs, debounceMs, why: why.join('，') };
}

// ── [WAIT-NEXT] 要不要等对方下一句再回 ─────────────────────────────────────
// 场景/话题判断：认真说事、直接提问 → 立刻回；句子没说完、对方在连发 → 等一句再回。
const SERIOUS_RE = /分手|绝交|离婚|死|病了|住院|难过|崩溃|哭|对不起|道歉|生气|失望|离开|讨厌我|不想活|自杀|抑郁|吵架|不理我/;
const CONTINUE_TAIL_RE = /[，,、…～~\-—]$|(然后|而且|就是|因为|所以|还有|但是|不过|的话|比如|例如|感觉|像是|那个|这个)$/;
const QUESTION_RE = /[？?]|吗[。！!]?$|呢[。？?]?$|吧[？?]?$/;
// 没有问号也算提问：今天几号 / 你叫什么 / 怎么弄 / 为什么 / 多久
const QUESTION_WORD_RE = /(几|什么|谁|哪|怎么|为什么|为啥|多久|多少|是不是|能不能|要不要|有没有|可不可以|啥)/;
const BURST_FRAGMENT_RE = /^(那个|就是|然后|而且|还有|对了|诶|哎|话说|我跟你说|你猜)/;
const PHATIC_RE = /^(哈+|呵+|嗯+|哦+|喔+|好+|行+|在吗|在不在|草|233+|6+|awsl|？+|\?+)[。！!？?~～]*$/;

/** 去掉引用块/@/CQ 码/首尾空白，取最后一句用于判断 */
export function cleanIncoming(text) {
  return String(text || '')
    .replace(/\[引用[^\]]*\]/g, '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/@\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} ctx
 * @param {'private'|'group'} ctx.kind
 * @param {string} ctx.text 对方最后一条
 * @param {string} [ctx.topic] 当前话题（daily/emotional/…）
 * @param {number} [ctx.senderRecent15s] 同一人最近 15 秒发了多少条
 * @param {boolean} [ctx.directed] 这条是否在点她
 * @param {number} [ctx.maxWaitMs]
 * @returns {{wait:boolean, waitMs:number, why:string}}
 */
export function assumeMoreComing(ctx = {}) {
  const kind = ctx.kind === 'private' ? 'private' : 'group';
  const text = cleanIncoming(ctx.text);
  const maxWait = Math.min(12000, Math.max(0, Number(ctx.maxWaitMs) || 9000));
  const burst = Number(ctx.senderRecent15s) || 0;

  if (!text) return { wait: false, waitMs: 0, why: '没内容' };
  if (SERIOUS_RE.test(text) || String(ctx.topic || '') === 'emotional') {
    return { wait: false, waitMs: 0, why: '话题重，不让人等' };
  }
  if ((QUESTION_RE.test(text) || (QUESTION_WORD_RE.test(text) && text.length <= 12)) && !CONTINUE_TAIL_RE.test(text)) {
    return { wait: false, waitMs: 0, why: '问句完整，直接回' };
  }
  // 语气/应答类短句（哈哈、嗯、好、在吗）本身就是完整回合一拍，不等
  if (PHATIC_RE.test(text)) return { wait: false, waitMs: 0, why: '语气短句，直接回' };
  // 对方已经在连发：等他这一串说完（比"句子像没说完"更明确，先判）
  if (burst >= 2) {
    const base = kind === 'private' ? 4000 : 3000;
    return { wait: true, waitMs: Math.min(maxWait, base), why: '对方在连发，等他发完' };
  }
  if (CONTINUE_TAIL_RE.test(text) || BURST_FRAGMENT_RE.test(text) || text.length <= 4) {
    // [PACE-2026-11-05] 用户明确嫌慢：私聊碎句 6s→3s，群 4.5s→2.5s；连发路径仍有 3–4s 兜底。
    const base = kind === 'private' ? 3000 : 2500;
    return { wait: true, waitMs: Math.min(maxWait, base), why: '句子像没说完，等下一句' };
  }
  if (kind === 'group') return { wait: false, waitMs: 0, why: '群聊不占着等' };
  return { wait: false, waitMs: 0, why: '没信号，直接回' };
}
