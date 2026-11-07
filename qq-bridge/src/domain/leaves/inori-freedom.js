// inori-freedom.js · 自由度策略（纯函数，P1 观测层）
//
// 目标不是“多开工具”，而是把“她现在可以选什么”变成可计算、可记录的事实：
//   reply    : 可回 / 可等 / 可沉默
//   initiate : 可主动开口的次数还剩多少
//   explore  : 自己的时间可以选什么事、还剩多少
//   selfEdit : 能不能改自己
//   manageGroup: 能不能管理群
//
// 当前只输出策略和日志，不改 prompt、不放宽任何权限；等真实日志确认后再接提示词。
// 本文件不读文件、不依赖 app.mjs，保持可单测。

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function classifyTrust(key, ownerQQ) {
  const k = String(key || '');
  if (k === `private:${String(ownerQQ ?? '')}`) return 'owner';
  if (k.startsWith('group:')) return 'group';
  if (k.startsWith('isolated:') || k.startsWith('task:') || k.startsWith('gate:')) return 'isolated';
  if (k.startsWith('private:')) return 'private';
  return 'unknown';
}

/**
 * @param {{key:string, mode:string, ownerQQ?:string, cfg?:object, state?:object, now?:number}} opts
 */
export function buildFreedomPolicy({ key = '', mode = '', ownerQQ = '', cfg = {}, state = {}, now = Date.now() } = {}) {
  const trust = classifyTrust(key, ownerQQ);
  const isolated = trust === 'isolated';
  const social = isPlainObject(cfg.socialV2) ? cfg.socialV2 : {};
  const wake = isPlainObject(social.wake) ? social.wake : {};
  const ownLife = isPlainObject(cfg.ownLife) ? cfg.ownLife : {};
  const tools = isPlainObject(social.tools) ? social.tools : {};
  const st = isPlainObject(state) ? state : {};

  const maxWakePerHour = Math.max(0, Number(wake.maxWakePerHour) || 0);
  const wakeTimes = Array.isArray(st.wakeTimes) ? st.wakeTimes : [];
  const wakeUsed = wakeTimes.filter((t) => now - Number(t) < 3600000).length;
  // 0 = 不设上限（沿用现有语义），不能把“0”误读成“一次都不许”。
  const initiateRemaining = maxWakePerHour === 0 ? 9999 : Math.max(0, maxWakePerHour - wakeUsed);

  // ownLife.maxPerDay 口径（与 ownlife-service.mjs 的 [OPEN-CAP] 一致）：
  //   · 未配置 ⇒ 默认 6；
  //   · 显式 0 ⇒ 不设每日上限（以前 `Number(0) || 6` 把它吞成 6，等于主人写"不限"却悄悄限成 6 次）；
  //   · 负数/非法 ⇒ 按 0 次处理（明确关掉，而不是回落默认）。
  const rawMaxOwn = ownLife.maxPerDay;
  const ownUnlimited = rawMaxOwn !== undefined && rawMaxOwn !== null && Number(rawMaxOwn) === 0;
  const maxOwnPerDay = ownUnlimited
    ? null
    : (rawMaxOwn === undefined || rawMaxOwn === null || !Number.isFinite(Number(rawMaxOwn))
      ? 6
      : Math.max(0, Number(rawMaxOwn)));
  const ownUsed = Math.max(0, Number(st.ownLifeCount) || 0);
  const exploreRemaining = ownUnlimited ? null : Math.max(0, (maxOwnPerDay ?? 0) - ownUsed);

  const reply = isolated
    ? { can: false, options: [], reason: 'isolated-session-no-agent-token' }
    : { can: true, options: ['reply', 'wait', 'silence'], reason: 'chat-session' };

  const initiate = {
    can: !isolated && mode === 'reserved2' && social.enabled !== false && social.paused !== true && initiateRemaining > 0,
    remaining: initiateRemaining,
    max: maxWakePerHour,
    reason: isolated ? 'isolated-session-no-agent-token' : (mode !== 'reserved2' ? 'not-reserved2' : (initiateRemaining > 0 ? 'budget-available' : 'budget-exhausted')),
  };

  const explore = {
    can: trust === 'isolated' && ownLife.enabled !== false && (ownUnlimited || exploreRemaining > 0),
    budgetLeft: exploreRemaining, // null = 不限量
    unlimited: ownUnlimited,
    max: maxOwnPerDay, // null = 不限量
    options: ['curiosity', 'practice', 'day-plan', 'idle'],
    reason: trust !== 'isolated' ? 'not-own-time' : ((ownUnlimited || exploreRemaining > 0) ? 'budget-available' : 'budget-exhausted'),
  };

  const selfEdit = {
    can: trust === 'owner',
    reason: trust === 'owner' ? 'owner-private' : 'owner-private-only',
  };

  const manageGroup = {
    can: trust === 'owner' && tools.groupAdmin === true,
    reason: tools.groupAdmin !== true ? 'group-admin-disabled' : (trust === 'owner' ? 'owner-private' : 'owner-private-only'),
  };

  return { key, mode, trust, reply, initiate, explore, selfEdit, manageGroup };
}

/**
 * 把策略渲染成一句“许可”，不是命令。
 * 只给：可以回/可以等/可以沉默 + 主动预算 + 自己时间的可选数量。
 */
export function renderFreedomPermission(policy) {
  const p = policy || {};
  const bits = [];
  // 以前这里是 `if (!p.reply?.can) return ''`：隔离会话（自己的时间）reply.can 恒 false，
  // 于是下面的"自己时间还能选几件事"永远渲染不出来——整段是死分支。
  // 现在按块拼：哪个许可成立就渲染哪块，一块都没有才返回空串。
  if (p.reply?.can) bits.push('回、等、沉默都可以；不想接就收');
  if (p.initiate?.can && Number(p.initiate.remaining) > 0) {
    bits.push(`今天还能主动开口 ${Number(p.initiate.remaining)} 次`);
  }
  if (p.explore?.can) {
    if (p.explore.unlimited || p.explore.budgetLeft === null) bits.push('自己的时间不限量，也可以什么都不做');
    else if (Number(p.explore.budgetLeft) > 0) bits.push(`自己的时间还能选 ${Number(p.explore.budgetLeft)} 件事，也可以什么都不做`);
  }
  if (!bits.length) return '';
  return `【你现在可以】${bits.join('；')}。`;
}

export function formatFreedomLog(policy) {
  const p = policy || {};
  return `[freedom] ${p.key || '-'} trust=${p.trust || '-'} reply=${!!p.reply?.can} initiate=${!!p.initiate?.can}(${p.initiate?.remaining ?? 0}/${p.initiate?.max ?? 0}) explore=${!!p.explore?.can}(${p.explore?.budgetLeft ?? 0}/${p.explore?.max ?? 0}) selfEdit=${!!p.selfEdit?.can} manageGroup=${!!p.manageGroup?.can}`;
}
