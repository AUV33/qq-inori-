// ownlife 队列投递：忙时排队、失败重投、按优先级 drain。
//
// 从 app.mjs 的 main() 搬出（P3-RW-55，2026-11-01）。ownlifeQueue 数组与持久化函数
// 由 app 持有（同一实例）；投递仍走 deliverToIsolated。
/**
 * @param {object} ctx
 */
export function createOwnLifeDispatch(ctx) {
  const {
    cfg, log, ownlifeQueue, persistOwnlifeQueue, ensureIsolatedSession, turnDispatch,
    getPhoneProbe, renderPhoneLine, activityMenuLine, practiceSlotLine, deliverToIsolated,
    // [WIRING-FIX] 重投判断要读 main() 的「回合起点」表（原来裸引用 → 自主时间重投每次都炸）
    getLastTurnStartAt,
    // [REBUILD] 投递成功但 DSH 迟迟不开始回合，往往是会话在 DSH 侧被归档/blocked；
    // 标记 dead 后 deliverToIsolated 会强制重建，而不是继续往死会话里投。
    isolatedDead = null,
    saveIsolatedDead = null,
  } = ctx;
  async function dispatchOwnlifeUnified(reason, text, { scheduleRetry = true } = {}) {
    try {
      const sid = await ensureIsolatedSession('ownlife');
      if (sid && turnDispatch.isActive(sid)) {
        if (!ownlifeQueue.some((q) => q.reason === reason)) {
          ownlifeQueue.push({ reason, text, at: Date.now() });
          if (ownlifeQueue.length > 3) ownlifeQueue.shift();
          persistOwnlifeQueue();
        }
        log(`[scheduler] ownlife 正忙，排队 ${reason}（队列 ${ownlifeQueue.length}）`);
        return false;
      }
      // [SCHEDULER-FIX] ownerKey 是 startOwnLife 的局部 const，这里作用域里没有它（上午 free-tick/own-life 全报 ownerKey is not defined）。
      const ownerKey = 'private:' + String(cfg.ownerQQ ?? '');
      // [PRACTICE] 独处时把「学过但没做成」的摆到眼前（只给事实+许可）。
      // [ACTIVITY-MENU] 同时递「你能挑的活动」（可选，不是任务）。
      // [PHONE-STATE] 手机要是明显连不上，先把这条事实说清楚（只给事实和许可，不指使她干什么）
      let phoneLine = '';
      if (reason === 'own-life') {
        try {
          const ps = await getPhoneProbe().get();
          const pl = renderPhoneLine(ps);
          if (pl) {
            phoneLine = '\n\n' + pl;
            log(`[phone] ownlife 手机不可用（${ps.reason}），说了这一句`);
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-dispatch-service.mjs:8117'); }
      }
      const outText = reason === 'own-life' ? text + activityMenuLine() + practiceSlotLine() + phoneLine : text;
      const startedAt = Date.now();
      await deliverToIsolated('ownlife', outText, { key: ownerKey, reason });
      // [OWNLIFE-RETRY] 投递成功但 DSH 没开始回合（槽位被 60 秒租约回收）→ 90 秒后重投一次，
      // 否则她这一小时就是白醒（2026-10-30 02:23 / 13:12 各丢了一轮）。
      // [RETRY-ONCE] 重投时不能再排一条新链：dispatch 自己也会 schedule，会把 attempt 重置回 1，
      // 结果变成每 90 秒无限重投同一段 prompt（本来就只允许补一次）。重投的计数交给外层链。
      if (scheduleRetry) scheduleOwnlifeRetry(reason, text, sid, startedAt, 1);
      return true;
    } catch (error) {
      log(`[scheduler] ${reason} 投递失败: ${error?.message ?? error}`);
      // [REQUEUE] 失败不吞：放回队列等下次 drain（同 reason 去重、上限 3）
      try {
        if (!ownlifeQueue.some((q) => q.reason === reason)) {
          ownlifeQueue.push({ reason, text, at: Date.now() });
          if (ownlifeQueue.length > 3) ownlifeQueue.shift();
          persistOwnlifeQueue();
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-dispatch-service.mjs:8135'); }
      return false;
    }
  }

  function scheduleOwnlifeRetry(reason, text, sid, startedAt, attempt) {
    try {
      const timer = setTimeout(() => {
        try {
          if (!sid) return;
          if (turnDispatch.isActive(String(sid))) return;
          if ((getLastTurnStartAt().get(String(sid)) ?? 0) >= startedAt) return;
          if (attempt >= 2) {
            try { isolatedDead?.add?.('ownlife'); saveIsolatedDead?.(); } catch { /* 标记失败不影响放弃 */ }
            log(`[sched] ${reason} 重投后仍没开始回合，这一轮放弃（会话已标记重建）`);
            return;
          }
          // [REBUILD-LATE] 不在第一次重投前标记重建：很多“没看到 turn/start”其实是事件漏了、
          // 回合还在跑（14:01 实测：重投时才发现 ownlife 正忙）。标记重建会让会话上下文白丢。
          // 第一次仍用原会话重投；只有“重投后仍没开始”才判定会话失效，交给下一轮重建。
          log(`[sched] ${reason} 投递 90 秒仍没开始回合，重投一次`);
          void dispatchOwnlifeUnified(reason, text, { scheduleRetry: false }).then((ok) => {
            if (ok) scheduleOwnlifeRetry(reason, text, sid, Date.now(), attempt + 1);
          }).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/social/ownlife-dispatch-service.mjs:88'));
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-dispatch-service.mjs:8156'); }
      }, 90_000);
      timer?.unref?.();
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'ownlife-dispatch-service.mjs:8159'); }
  }

  function drainOwnlifeQueue() {    if (!ownlifeQueue.length) return;
    const pri = (r) => ({ 'own-life': 0, boredom: 1, 'free-tick': 2 }[r] ?? 9);
    ownlifeQueue.sort((a, b) => pri(a.reason) - pri(b.reason));
    const next = ownlifeQueue.shift();
    persistOwnlifeQueue();
    void dispatchOwnlifeUnified(next.reason, next.text);
  }

  return { dispatchOwnlifeUnified, scheduleOwnlifeRetry, drainOwnlifeQueue };
}
