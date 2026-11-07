// 会话遥测：模型选择记录、token 账本摄入、断线后 in-flight 回合重建。
//
// 从 app.mjs 的 main() 搬出（P3-RW-8，2026-10-31）。sessionModels 状态留在服务闭包；
// collectors / v2TurnStartAt 仍由 app 持有（发送与 busy 判定共用），通过注入的 Map 读写。
import { unwrap } from '../leaves/dsh-envelope.mjs'; // [WIRING-FIX] 抽离时漏了：断线重建 in-flight 回合时 unwrap 未定义
/**
 * @param {object} ctx
 * @param {object} ctx.cfg
 * @param {(...args:any[])=>void} ctx.log
 * @param {object} ctx.tokenLedger
 * @param {()=>object} ctx.createTurnCollector
 * @param {Map<string,any>} ctx.collectors
 * @param {Map<string,number>} ctx.v2TurnStartAt
 * @param {object} ctx.api
 */
export function createSessionTelemetry({ cfg, log, tokenLedger, createTurnCollector, collectors, v2TurnStartAt, api, onTurnRecovered = null }) {
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // [STALE-TURN] 与 armPendingWakeLease 同源的兜底：作者只给 pendingWakeKeys 加了租约，
    // 没给 collectors 加。于是「DSH 重启把某个回合拦腰截断」之后，这条幽灵回合会在每次
    // 重连时被 rebuildInFlightCollector 重新装回来，isConversationBusyV2 永远为 true，
    // 会话永久卡在"繁忙"——新消息只进队列，永远等不到那个不会到来的 turn/end。
    // 这里加一个看门狗：恢复的回合若在 STALE_TURN_MS 内仍没结束，就解除 busy。
    // 判定用「collector 还是当初那个实例」，避免误删期间新建立的正常回合。
    const STALE_TURN_MS = 2 * 60 * 1000; // [STALE-TURN] 5min→2min（只作用于重启后恢复的幽灵回合）
    const watchdog = setTimeout(() => {
      try {
        if (collectors.get(sessionId) === collector) {
          collectors.delete(sessionId);
          try { v2TurnStartAt.delete(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'session-telemetry.mjs:4071'); }
          log(`[stale-turn] 恢复的回合（turn ${[...open].join(',')}）${Math.round(STALE_TURN_MS / 60000)} 分钟内没有结束，已解除 busy —— 该回合在 DSH 侧已不存在，新消息不再排队`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'session-telemetry.mjs:4074'); }
    }, STALE_TURN_MS);
    watchdog.unref?.();
    // [STALE-TURN] 快速判定：20 秒后问一次 DSH「这个会话到底在不在跑」。
    // 幽灵回合的特征是 DSH 侧 running=false —— 那就没必要干等 5 分钟看门狗。
    // 只在仍是我们这个 collector 时才动手，避免误删期间新建的正常回合。
    const probe = setTimeout(async () => {
      try {
        const list = unwrap(await api.sessions.list({}), 'session.list');
        const items = Array.isArray(list) ? list : (list?.items ?? []);
        const me = items.find((s) => s?.sessionId === sessionId);
        if (me && me.running !== true && collectors.get(sessionId) === collector) {
          collectors.delete(sessionId);
          try { v2TurnStartAt.delete(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'session-telemetry.mjs:4087'); }
          log(`[stale-turn] DSH 报该会话 running=false，立刻解除 busy（不必等 5 分钟看门狗）`);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'session-telemetry.mjs:4090'); }
    }, 20000);
    probe.unref?.();
    // [RECOVERED-GRANT] 断线期间 turn/start 可能已经发生：恢复回合时通知调度器消费令牌，
    // 否则 turnDispatch 只看到“发了槽没开始”，60 秒后误回收并对 ownlife 重投（重复花钱）。
    try { onTurnRecovered?.(sessionId); } catch { /* 通知失败不影响恢复 */ }
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  return {
    rememberModel,
    recordSessionUsage,
    recordSessionSnapshot,
    rebuildInFlightCollector,
    getMap: () => sessionModels,
    forgetSession: (sessionId) => { sessionModels.delete(sessionId); },
  };
}
