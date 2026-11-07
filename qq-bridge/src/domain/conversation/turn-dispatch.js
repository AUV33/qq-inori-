// turn-dispatch.js · 并发回合调度：等待队列、已发槽令牌、活跃回合、同会话串行
//
// 从 bridge.js 抽出的调度状态机（原 [SCHED] 段）。bridge 只注入三样东西：
//   maxConcurrent / reserveForChat（读配置）、log（日志）、plan/score（策略与评分，来自 turn-scheduler.js）
// 其余（排队、令牌租约、超时兜底、占用快照、同会话串行）都在这里，可单测。
//
// 不变量（历史事故换来的）：
//   1. 已发槽但 turn/start 还没到的令牌也算占用——否则会超发；
//   2. 同一 label 同时只能有一个在跑或已发槽等待开始；
//   3. 拿槽 60 秒没开始回合 → 回收令牌，避免泄漏；
//   4. 排队 20 秒 → 强制放行（宁可短暂超额，也不把消息卡死）。

export function createTurnDispatch(deps) {
  const {
    maxConcurrent = () => 3,
    reserveForChat = () => 2,
    log = () => {},
    plan,
    score,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
    snapshotMs = 60000,
    queueTimeoutMs = 20000,
    leaseMs = 60000,
    // [P2-1] 后台小时预算：{maxPerHour, windowMs, queueTimeoutMs}；maxPerHour<=0 表示不限制。
    budget = () => ({}),
    // [P2-2] 资源门：返回 true 的 waiter 本轮不派发（observeOnly 时由门自己只记不打）。
    shouldHold = () => false,
    // [P2-2] 优先级：后台按 kind 分层（gate/vision 高、intake/slang/groupfact 低）。
    priorityOf = (kind, label) => basePriority(kind, label),
    // [P2-1] 预算丢弃记账回调（桥接写 background-drops.jsonl）。
    onDrop = () => {},
  } = deps ?? {};
  if (typeof plan !== 'function') throw new Error('turn-dispatch 需要 planTurnGrants');

  const active = new Set();          // sessionId -> 正在跑
  const activeLabels = new Map();    // sessionId -> label（同会话串行）
  const grants = new Set();          // 令牌：已发槽，turn/start 还没到
  const waiters = [];                // {label, kind, priority, at, resolve, timer}
  const backgroundGrants = [];       // [P2-1] 后台派发时间戳（滑窗计数）

  const max = () => Math.max(1, Number(maxConcurrent()) || 3);
  const bgLimit = () => Math.max(1, max() - Math.max(0, Math.min(max() - 1, Number(reserveForChat()) || 0)));
  const occupancy = () => active.size + grants.size;

  function basePriority(kind, label) {
    if (kind === 'chat') return String(label).startsWith('private:') ? 100 : 60;
    return 20;
  }

  // [P2-1] 预算配置与滑窗：每次只读一次，坏配置降级成「不限制」，绝不挡调度。
  function budgetConf() {
    try {
      const b = budget?.() ?? {};
      return {
        maxPerHour: Math.max(0, Number(b.maxPerHour) || 0),
        windowMs: Math.max(1000, Number(b.windowMs) || 60 * 60 * 1000),
        queueTimeoutMs: Math.max(1000, Number(b.queueTimeoutMs) || 120000),
        // 豁免名单：gate 这类「聊天路径上的后台」不能被小时预算卡住，否则群里会没人回话。
        exemptKinds: Array.isArray(b.exemptKinds) ? b.exemptKinds.map(String) : [],
      };
    } catch {
      return { maxPerHour: 0, windowMs: 60 * 60 * 1000, queueTimeoutMs: 120000, exemptKinds: [] };
    }
  }

  function budgetExempt(label, conf = budgetConf()) {
    if (!conf.exemptKinds.length) return false;
    const kindName = String(label).replace(/^isolated:/, '').replace(/[:#].*$/, '');
    return conf.exemptKinds.includes(kindName);
  }

  function bgUsedInWindow(conf = budgetConf()) {
    const t = now();
    while (backgroundGrants.length && t - backgroundGrants[0] >= conf.windowMs) backgroundGrants.shift();
    return backgroundGrants.length;
  }

  function budgetHasRoom(conf = budgetConf()) {
    return conf.maxPerHour <= 0 || bgUsedInWindow(conf) < conf.maxPerHour;
  }

  function pump() {
    try {
      if (!waiters.length) return;
      const busyLabels = new Set([...[...grants].map((t) => t.label), ...activeLabels.values()]);
      const eligible = waiters.filter((w) => !busyLabels.has(w.label) && !shouldHold(w));
      if (!eligible.length) return;
      const picked = plan(eligible, { max: max(), bgLimit: bgLimit(), occupancy: occupancy() })
        .map((idx) => eligible[idx])
        .filter(Boolean);
      // [F20] 不变量 #2：同一 label 一次 pump 只发一个槽。plan() 可能一次挑中多个「都还没
      // granted/active」的同 label waiter，这里保证只发第一个，其余留到本 label 的回合
      // 结束（finish → pump）后再串行派发，绝不并发两个同会话回合。
      const grantedLabels = new Set();
      const chosen = picked.filter((w) => {
        if (grantedLabels.has(w.label)) return false;
        grantedLabels.add(w.label);
        return true;
      });
      const conf = budgetConf();
      for (const w of chosen) {
        const exempt = w.kind === 'background' && budgetExempt(w.label, conf);
        // [P2-1] 后台小时预算：超额就留在队列，不超发；聊天与豁免 kind（gate）不受影响。
        if (w.kind === 'background' && !exempt && !budgetHasRoom(conf)) {
          const used = bgUsedInWindow(conf);
          log(`[sched] 后台小时预算已满（${used}/${conf.maxPerHour}），${w.label} 继续排队`);
          continue;
        }
        const at = waiters.indexOf(w);
        if (at >= 0) waiters.splice(at, 1);
        const token = { label: w.label, kind: w.kind, sessionId: null, grantedAt: now(), lease: null };
        grants.add(token);
        if (w.kind === 'background' && !exempt) backgroundGrants.push(now());
        token.lease = setTimer(() => {
          if (grants.delete(token)) {
            log(`[sched] ${w.label} 拿到槽但 60 秒内没开始回合，回收（避免槽位泄漏）`);
            pump();
          }
        }, leaseMs);
        token.lease?.unref?.();
        if (w.timer) clearTimer(w.timer);
        const waited = now() - w.at;
        log(`[sched] 派发 ${w.label}（${w.kind}，等了 ${waited}ms，占用 ${occupancy()}/${max()}，剩余排队 ${waiters.length}）`);
        w.resolve({ ok: true, waitedMs: waited, kind: w.kind, grantToken: token });
      }
    } catch (error) {
      log(`[sched] 派发异常（已忽略）: ${error?.message ?? error}`);
    }
  }

  /** 申请一个回合槽位；聊天排队 20 秒兜底强制放行，后台超时按预算丢弃并记账。 */
  function acquire(label = '', opts = {}) {
    const kind = opts.kind || (String(label).startsWith('private:') || String(label).startsWith('group:') ? 'chat' : 'background');
    const priority = Number.isFinite(Number(opts.priority)) ? Number(opts.priority) : priorityOf(kind, label);
    const at = now();
    const conf = budgetConf();
    const timerMs = kind === 'background' ? conf.queueTimeoutMs : queueTimeoutMs;
    return new Promise((resolve) => {
      const waiter = { label, kind, priority, at, resolve, timer: null };
      waiter.timer = setTimer(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        // [P2-1] 后台：排队等不到且预算仍满 → 丢弃并记账（不绕过预算硬跑）。
        // 豁免 kind（gate）永远不走丢弃分支：它是聊天路径的前置。
        if (kind === 'background' && !budgetExempt(label, conf) && !budgetHasRoom()) {
          const waitedMs = now() - at;
          const used = bgUsedInWindow();
          log(`[sched] ${label} 排队 ${Math.round(waitedMs / 1000)}s 超时且后台预算已满（${used}/${conf.maxPerHour}），丢弃并记账`);
          const task = String(label).replace(/^isolated:/, '').split(':')[0];
          try { onDrop({ label, kind, task, waitedMs, reason: 'hourly_budget', maxPerHour: conf.maxPerHour, used }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'turn-dispatch.js:142'); }
          resolve({ ok: false, dropped: true, reason: 'hourly_budget', waitedMs, kind });
          return;
        }
        // [F20] 兜底放行也不能破坏不变量 #2：若同 label 已有 grant/活跃，不再发第二个槽，
        // 直接按「已串行化」丢弃本 waiter（该 label 现有回合结束后会由 pump 继续派发）。
        const labelBusy = [...grants].some((t) => t.label === label) || [...activeLabels.values()].includes(label);
        if (labelBusy) {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve({ ok: false, dropped: true, reason: 'serialized', waitedMs: now() - at, kind });
          return;
        }
        const token = { label, kind, sessionId: null, grantedAt: now(), forced: true, lease: null };
        grants.add(token);
        if (kind === 'background' && !budgetExempt(label, conf)) backgroundGrants.push(now());
        token.lease = setTimer(() => {
          if (grants.delete(token)) pump();
        }, leaseMs);
        token.lease?.unref?.();
        log(`[sched] ${label} 排队超时（占用 ${occupancy()}/${max()}，排队 ${waiters.length}），按兜底放行`);
        resolve({ ok: false, forced: true, waitedMs: now() - at, kind, grantToken: token });
      }, timerMs);
      waiter.timer?.unref?.();
      // 同 label 去重在 pump 层保证（见 chosen 过滤）：一次 pump 只为同一 label 发一个槽，
      // 已持有 grant/活跃 的 label 也由 busyLabels 排除。此处不再做无用的 O(n) 全扫描。
      waiters.push(waiter);
      pump();
    });
  }

  /** 回合真正开始前，把令牌和 sessionId 绑起来。 */
  function bind(grant, sessionId) {
    const token = grant?.grantToken;
    if (!token || !grants.has(token)) return false;
    token.sessionId = String(sessionId);
    return true;
  }

  /** 投递失败/命令回执：立刻还槽。 */
  function release(grant) {
    const token = grant?.grantToken;
    if (!token || !grants.delete(token)) return false;
    if (token.lease) clearTimer(token.lease);
    pump();
    return true;
  }

  /** turn/start：令牌转为活跃回合（会话开始跑）。 */
  function begin(sessionId) {
    const sid = String(sessionId);
    active.add(sid);
    let consumed = false;
    for (const token of grants) {
      if (token.sessionId !== sid) continue;
      if (token.lease) clearTimer(token.lease);
      grants.delete(token);
      activeLabels.set(sid, token.label);
      consumed = true;
      break;
    }
    return consumed;
  }

  /** turn/end：释放活跃回合，按优先级派给等待者。 */
  function finish(sessionId) {
    const sid = String(sessionId);
    const had = active.delete(sid);
    activeLabels.delete(sid);
    pump();
    return had;
  }

  const isActive = (sessionId) => active.has(String(sessionId));
  const stats = () => ({ active: active.size, granted: grants.size, queued: waiters.length, max: max() });
  const budgetStats = () => {
    const conf = budgetConf();
    return { maxPerHour: conf.maxPerHour, used: bgUsedInWindow(conf), windowMs: conf.windowMs };
  };

  // [SCHED-SNAP] 每分钟一条占用快照（只在有占用时打，避免日志噪声）
  const snapshot = setInterval(() => {
    try {
      if (!active.size && !grants.size && !waiters.length) return;
      const chatQ = waiters.filter((w) => w.kind === 'chat').length;
      const bgQ = waiters.length - chatQ;
      const oldest = waiters.length ? Math.round((now() - Math.min(...waiters.map((w) => w.at))) / 1000) : 0;
      log(`[sched] 快照 活跃=${active.size} 已发未开始=${grants.size} 上限=${max()} 排队=chat:${chatQ}/bg:${bgQ} 最久等待=${oldest}s`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'turn-dispatch.js:223'); }
  }, snapshotMs);
  snapshot?.unref?.();

  return { acquire, bind, release, begin, finish, pump, isActive, stats, budgetStats, occupancy, max, basePriority };
}
