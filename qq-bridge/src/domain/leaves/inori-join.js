// inori-join.js · 活跃群里的两个"她自己开口"的判定（纯函数，零 IO）
//
// 背景（2026-10-25 用户拍板）：原先唯一的主动入口只认「群里安静 ≥15 分钟」，
// 而 656 群整晚都有人说话 → 主动通道全天 0 次触发。用户要的是：
//   群里活跃时，她也能按当前话题接话搭话，聊起来以后一直延续到没人接她的话为止；
//   不是所有人跟她说话都会 @ 她，所以能不能接由她自己按语义判断——harness 只负责把
//   "现在有话题、你插得进去"这个事实，在她真的插得进去的时机递给她。
//
// 两个判定：
//   decideJoin      群正热闹、她自己安静了一阵 → 给一次插话机会（高优先级唤醒 joinTopic）
//   decideContinue  她刚说过话、别人接着说 → 接着聊（唤醒 continueChat），这是"聊到没人理她为止"的延续
//
// 纪律（与其它容器一致）：只决定"要不要把事实递给她"，永不决定"她该说什么"；
// 空数据一律不开口（返回 ok:false），不制造暗示。

/** 插话（活跃群）默认参数 */
export const JOIN_DEFAULTS = {
  enabled: true,
  minOthers: 8,                 // 近 windowMs 内别人至少说了几条（不到就是不热闹）
  windowMs: 10 * 60 * 1000,
  silentMs: 10 * 60 * 1000,     // 她自己安静多久才算"该她接一句"
  minGapMs: 8 * 60 * 1000,      // 两次插话机会的最小间隔
  maxPerHour: 3,                // 每小时最多给几次插话机会（防刷屏）
  minAdaptive: 0.12,            // 水群适应度门槛（computeProactivity 的输出）
  baseProb: 0.30,
  maxProb: 0.6,
};

/** 接着聊（会话延续）默认参数 */
export const ENGAGE_DEFAULTS = {
  enabled: true,
  windowMs: 10 * 60 * 1000,     // 她开口后多久内算"还在聊"
  minGapMs: 45 * 1000,          // 同一次会话里两次延续的最小间隔
  maxPerHour: 12,               // 一小时最多延续几次（含她自己的回合）
  requireNewOthers: 1,          // 她说完之后别人至少又说了几条
};

const asInt = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const countSince = (times, now, ms) => (Array.isArray(times) ? times : []).filter((t) => now - asInt(t) < ms && asInt(t) > 0).length;

/**
 * 要不要给她一次"插话机会"。
 * @param {object} input { now, othersRecent, lastSelfAt, lastJoinAt, adaptive, joinTimes, random }
 * @param {object} opts JOIN_DEFAULTS 覆盖
 * @returns {{ok:boolean, why:string, p?:number}}
 */
export function decideJoin(input = {}, opts = {}) {
  const o = { ...JOIN_DEFAULTS, ...opts };
  const now = asInt(input.now) || Date.now();
  const random = typeof input.random === 'number' ? input.random : Math.random();
  if (o.enabled === false) return { ok: false, why: 'disabled' };
  const othersRecent = asInt(input.othersRecent);
  if (othersRecent < asInt(o.minOthers)) return { ok: false, why: 'group-not-active' };
  const lastSelfAt = asInt(input.lastSelfAt);
  if (lastSelfAt > 0 && now - lastSelfAt < asInt(o.silentMs)) return { ok: false, why: 'she-just-spoke' };
  const lastJoinAt = asInt(input.lastJoinAt);
  if (lastJoinAt > 0 && now - lastJoinAt < asInt(o.minGapMs)) return { ok: false, why: 'too-soon' };
  const inHour = countSince(input.joinTimes, now, 3600 * 1000);
  if (inHour >= asInt(o.maxPerHour)) return { ok: false, why: 'hour-cap' };
  const adaptive = Number(input.adaptive);
  if (!Number.isFinite(adaptive) || adaptive < Number(o.minAdaptive)) return { ok: false, why: 'low-adaptive' };
  // 热闹程度 + 适应度越高越容易放行；封顶 maxProb，避免"每条消息都想插话"
  const p = Math.min(Number(o.maxProb), Number(o.baseProb)
    + 0.03 * (othersRecent - asInt(o.minOthers))
    + 0.5 * (adaptive - Number(o.minAdaptive)));
  if (random >= p) return { ok: false, why: 'dice', p };
  return { ok: true, why: 'join', p };
}

/**
 * 她刚说过话、别人接着说了 → 要不要让她"接着聊"。
 * 不掷骰子：别人确实是冲着她那条在说，是否真的接由她那一轮决定；
 * 节流只靠 minGap 与每小时上限，保证"聊到没人理她为止"而不刷屏。
 * @param {object} input { now, lastSelfAt, newOthers, continueTimes }
 */
export function decideContinue(input = {}, opts = {}) {
  const o = { ...ENGAGE_DEFAULTS, ...opts };
  const now = asInt(input.now) || Date.now();
  if (o.enabled === false) return { ok: false, why: 'disabled' };
  const lastSelfAt = asInt(input.lastSelfAt);
  if (!(lastSelfAt > 0)) return { ok: false, why: 'never-spoke' };
  if (now - lastSelfAt > asInt(o.windowMs)) return { ok: false, why: 'window-over' };
  if (asInt(input.newOthers) < asInt(o.requireNewOthers)) return { ok: false, why: 'nothing-new' };
  const times = input.continueTimes;
  const lastAt = Math.max(0, ...(Array.isArray(times) ? times.map(asInt) : [0]));
  if (lastAt > 0 && now - lastAt < asInt(o.minGapMs)) return { ok: false, why: 'too-soon' };
  if (countSince(times, now, 3600 * 1000) >= asInt(o.maxPerHour)) return { ok: false, why: 'hour-cap' };
  return { ok: true, why: 'continue' };
}

/** 把最近消息压成"谁：说了什么"的清单（给唤醒提示词用，截断避免超长） */
export function renderRecentLines(messages, { max = 10, chars = 60 } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.text ?? '').trim());
  return rows.slice(-max).map((m) => `- ${m.isSelf ? '你' : (m.sender || '某人')}：${String(m.text).slice(0, chars)}`);
}
