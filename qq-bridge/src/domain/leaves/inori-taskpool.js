// inori-taskpool.js · 任务池状态机（纯函数 + 薄持久化，桥接只接线）
//
// 背景：handoff 任务以前全部挤在**一个**共享任务会话里——多任务串行、上下文互相污染、
// 台账挂单。现在改成「一个任务一个会话」的池：
//   - 在跑数 < 上限（默认 2）→ 立即开新会话并行跑
//   - 池满 → 任务进队列（台账 status=queued），任一会话完成/超时自动 drain 下一个
//   - 单任务超过 taskMaxMs（默认 30 分钟）→ 台账回写 failed(timeout) + 归档会话 + drain
//
// 台账（task-ledger.jsonl）是排队的唯一真相源：queued 行按 at 升序就是 FIFO。
// 本模块只存 running 映射（sessionId ↔ taskId），供 turn/end 回写与归档定位。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_PARALLEL = 2;
export const DEFAULT_TASK_MAX_MS = 30 * 60 * 1000;
export const DEFAULT_QUEUE_MAX = 8;

/** 池并行上限（>=1）。 */
export function poolCap(cfg = {}) {
  const n = Number(cfg?.socialV2?.taskPool?.maxParallel ?? DEFAULT_MAX_PARALLEL);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_PARALLEL;
}

/** 单任务超时（毫秒，>=60s 兜底防配置写错）。 */
export function taskMaxMs(cfg = {}) {
  const n = Number(cfg?.socialV2?.taskPool?.taskMaxMs ?? DEFAULT_TASK_MAX_MS);
  return Number.isFinite(n) && n >= 60000 ? n : DEFAULT_TASK_MAX_MS;
}

/** 队列上限（超限的任务直接拒收，让上报方知道不是无限排队）。 */
export function queueMax(cfg = {}) {
  const n = Number(cfg?.socialV2?.taskPool?.queueMax ?? DEFAULT_QUEUE_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_QUEUE_MAX;
}

/** running 中是否有槽位可派。 */
export function canDispatch(runningCount, cfg = {}) {
  return runningCount < poolCap(cfg);
}

/** 从台账行里挑下一条该跑的 queued（at 最旧；同 at 按 id 稳定序）。 */
export function pickNextQueued(rows = []) {
  // [NULL-SAFE] 默认参数只兜 undefined；调用方从 JSON 读出来可能是 null
  const q = (Array.isArray(rows) ? rows : []).filter((r) => r && r.status === 'queued');
  if (!q.length) return null;
  q.sort((a, b) => {
    const da = String(a.at || ''), db = String(b.at || '');
    if (da !== db) return da < db ? -1 : 1;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  return q[0];
}

/** 超时的 running 条目（now - dispatchAt > limitMs）。 */
export function expiredRunning(running = [], nowMs, limitMs) {
  return (Array.isArray(running) ? running : []).filter((r) => r && r.sessionId && nowMs - Number(r.dispatchAt || 0) > limitMs);
}

/** 池状态渲染（注入她 + 控制台）：空池返回 ''（不造暗示，纪律同其他注入层）。 */
export function renderPoolLine(running = [], queuedCount = 0) {
  const r = (Array.isArray(running) ? running : []).filter(Boolean);
  const q = Math.max(0, Number(queuedCount) || 0);
  if (!r.length && !q) return '';
  const lines = [];
  if (r.length) {
    lines.push(`【任务池】${r.length} 件在跑：` + r.map((x) => x.taskShort || x.taskId).join('、'));
  }
  if (q) lines.push(`另有 ${q} 件排队（池空了会自动接着跑，不用你盯）。`);
  return lines.join('\n');
}

// ── 持久化：state/task-pool.json = { running: [{taskId, sessionId, dispatchAt, taskShort, reportTo}] } ──

export function loadPool(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.running)) return { running: [] };
    return { running: j.running.filter((x) => x && typeof x.sessionId === 'string' && x.sessionId) };
  } catch { return { running: [] }; }
}

export function savePool(file, running) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ running }, null, 1), 'utf8');
    return true;
  } catch { return false; }
}
