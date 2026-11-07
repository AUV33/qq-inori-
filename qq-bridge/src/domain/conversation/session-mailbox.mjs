// [M3+M5] 会话流水线核心：每会话一个轻量「邮箱」，串行消费整条处理链（M3）；
// 失败时只隔离自己这一桶（写入 crashed 标记、暂停自动消费、孤儿事件暂存），
// 其他桶继续；崩溃桶可经 recoverMailbox 恢复并重放孤儿事件（M5 失败域）。
// 设计文档：层 2 邮箱模型（事件按 channel 路由到 mailbox，串行消费）；
// 层 4 失败域（分桶隔离 + 错误边界 + 崩溃恢复 + 心跳）。
const chains = new Map();      // key -> 当前链尾 Promise
const crashed = new Map();     // key -> Error（桶已崩溃，暂停自动消费）
const orphans = new Map();     // key -> Array<{fn, resolve, reject}>（崩溃期间暂存的孤儿事件）
let onCrashed = null;          // (key, error) => void 可选崩溃回调（诊断/自动恢复）

// 注册崩溃回调（如写日志 / 触发自动恢复）。重复调用覆盖；传非函数则清除。
export function setCrashHandler(fn) { onCrashed = typeof fn === 'function' ? fn : null; }

// 把事件暂存为孤儿（崩溃态期间来的新事件），返回该事件的 Promise（恢复重放时 settle）。
function parkOrphan(key, fn) {
  const entry = { fn };
  const p = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
  const bucket = orphans.get(key) || [];
  bucket.push(entry);
  orphans.set(key, bucket);
  return p;
}

// [M3] 软失败：异常不中断邮箱链，后续项仍执行（链结构不损坏，无 unhandled rejection）。
// 保留此入口以兼容「希望失败后继续尝试」的场景；失败域隔离请用 runIsolated。
export function run(key, fn) {
  if (!key) return Promise.resolve().then(fn);
  const prev = chains.get(key) || Promise.resolve();
  // 无论前一项 fulfilled 还是 rejected，都继续推进下一项 → 单会话事件流不卡死。
  const task = prev.then(() => fn(), () => fn());
  const tail = task.then(
    (v) => { if (chains.get(key) === task) chains.delete(key); return v; },
    (e) => { if (chains.get(key) === task) chains.delete(key); throw e; }
  );
  chains.set(key, task);
  return tail;
}

// [M5] 失败域执行：异常只标记自己这一桶（crashed），链上遗留项跳过，使桶冻结。
function isolatedDrive(key, fn) {
  const exec = async () => {
    if (crashed.has(key)) return; // 桶已冻结：链上遗留项直接跳过，不再执行业务
    try {
      await fn();
    } catch (error) {
      // 失败域隔离：只标记自己这一桶，不影响其他桶；调用方也不被异常波及。
      crashed.set(key, error);
      if (onCrashed) try { onCrashed(key, error); } catch { /* ignore */ }
    }
  };
  const prev = chains.get(key) || Promise.resolve();
  const task = prev.then(exec, exec);
  const tail = task.then(
    (v) => { if (chains.get(key) === task) chains.delete(key); return v; },
    (e) => { if (chains.get(key) === task) chains.delete(key); throw e; }
  );
  chains.set(key, task);
  return tail;
}

// [M5] 失败域入口：健康态入链串行执行；崩溃态将事件暂存为孤儿，等恢复后重放。
export function runIsolated(key, fn) {
  if (!key) return Promise.resolve().then(fn);
  if (crashed.has(key)) return parkOrphan(key, fn);
  return isolatedDrive(key, fn);
}

// [M5] 恢复一个崩溃桶：清除 crashed 标记，按序重放孤儿事件（重放中途再崩则剩余转暂存）。
export async function recoverMailbox(key) {
  const bucket = orphans.get(key);
  if (!bucket || bucket.length === 0) { crashed.delete(key); return; }
  crashed.delete(key);
  orphans.delete(key);
  for (const entry of bucket) {
    if (crashed.has(key)) {
      // 重放中途该桶再次崩溃：剩余孤儿原样暂存（复用其 promise），结束本轮。
      const rest = orphans.get(key) || [];
      rest.push(entry);
      orphans.set(key, rest);
      continue;
    }
    try {
      const r = await runIsolated(key, entry.fn);
      entry.resolve(r);
    } catch (error) {
      entry.reject(error);
    }
  }
}

// [M5] 恢复所有崩溃桶（心跳 / 运维入口）。
export async function recoverAll() {
  for (const key of [...crashed.keys()]) await recoverMailbox(key);
}

// 仅用于测试 / 诊断
export function pendingCount() { return chains.size; }
export function crashedKeys() { return [...crashed.keys()]; }
export function orphanCount(key) { return (orphans.get(key) || []).length; }
