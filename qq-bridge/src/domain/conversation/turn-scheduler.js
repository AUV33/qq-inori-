// [SCHED] 并发槽派发策略（纯函数，便于测试）
// 设计目标（2026-10-27 用户要求：分流 + 负载平衡 + 连贯性）：
//  1. 分流：对话（chat：私聊/群）优先于后台（background：own-life/reflect/diary/vision/gate/task）
//  2. 负载平衡：后台最多占 max - reserve 个槽，永远给对话留位；aging 让等久的不被饿死
//  3. 连贯性：同一个会话在队列里只允许一条（由调用方保证），且这里不会同时放行同 label 两次

/** 优先级分：base + aging（每秒 +1，封顶 30） */
export function turnScore(waiter, now = Date.now()) {
  const waitedSec = Math.max(0, now - Number(waiter?.at || now)) / 1000;
  return Number(waiter?.priority || 0) + Math.min(30, waitedSec);
}

/**
 * 计算这一轮该放行谁。
 * @param {{label:string, kind:'chat'|'background', priority:number, at:number}[]} waiters
 * @param {{max:number, bgLimit:number, occupancy:number, now?:number}} opts
 * @returns {number[]} 要放行的 waiter 下标（按分数从高到低）
 */
export function planGrants(waiters, { max, bgLimit, occupancy, now = Date.now() } = {}) {
  const capMax = Math.max(1, Number(max) || 1);
  const capBg = Math.max(1, Math.min(capMax, Number(bgLimit) || capMax));
  let occ = Math.max(0, Number(occupancy) || 0);

  const scored = (Array.isArray(waiters) ? waiters : [])
    .map((w, i) => ({ w, i, score: turnScore(w, now) }))
    .sort((a, b) => b.score - a.score || Number(a.w?.at || 0) - Number(b.w?.at || 0));

  const grants = [];
  const grantedLabels = new Set();
  for (const item of scored) {
    const label = String(item.w?.label ?? '');
    if (grantedLabels.has(label)) continue;
    const chat = item.w?.kind === 'chat';
    const limit = chat ? capMax : capBg;
    if (occ >= limit) continue;          // 满了就跳过，继续看下一个（可能还有 chat 能进）
    grants.push(item.i);
    grantedLabels.add(label);
    occ += 1;
  }
  return grants;
}
