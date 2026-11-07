// inori-taskledger.js · 任务台账：交出去的活有登记、有结果回写
//
// [TASK-TRUTH 2026-10-31] 台账不再把“回合结束”当成功。
//   - status 只表示任务池生命周期：queued / running / finished / failed / expired
//   - outcome 表示事情本身：success / failed / blocked / unknown
//   - done 的语义 = status==='finished' && outcome==='success'，且 evidence 非空
//   - 失败/卡住带 nextAction，进入“待续”，下一次先接上，不从头重开
//
// 台账是排队的唯一真相源：queued 行按 at 升序就是 FIFO。

import fs from 'node:fs';
import path from 'node:path';
import { rewriteJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';
import { appendOutcome, createOutcome } from './inori-outcome.js';

const FILE = process.env.MZ_TASK_LEDGER || stateDataPath('task-ledger.jsonl');
const MAX_KEEP = 150;
const OUTCOMES = ['success', 'failed', 'blocked', 'unknown'];

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function rewrite(rows) {
  try {
    const r = rewriteJsonl(FILE, rows.slice(-MAX_KEEP), { source: 'bridge/task-ledger' });
    if (!r.ok) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, rows.slice(-MAX_KEEP).map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    }
  } catch (error) {
    try { console.error('[task-ledger] 写入失败:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-taskledger.js:37'); }
  }
}

let seq = 0;
function newId() { seq += 1; return 't' + Date.now().toString(36) + seq; }
const clip = (s, n) => [...String(s ?? '').replace(/\s+/g, ' ').trim()].slice(0, n).join('');

/** 证据强度：strong=可核对（文件/网址/命令/截图/他确认）；weak=一句空话；none=没写。 */
export function evidenceQuality(evidence = '') {
  const s = String(evidence ?? '').trim();
  if (!s) return 'none';
  const strong = /文件[:：]|路径[:：]|截图|图片|https?:\/\/|(?:^|[\s(（])data[\\/]|(?:^|[\s(（])media[\\/]|\.(?:png|jpe?g|webp|gif|md|json|log|txt|pdf|csv)\b|命令[:：]|exit\s*0|他确认|owner确认|你确认|机检|验收通过/i;
  return strong.test(s) ? 'strong' : 'weak';
}

/** 任务指纹：同一件事重复派活时用它找回旧任务（粗粒度、只看目标文本）。 */
export function fingerprintOf(task = '') {
  return String(task ?? '')
    .replace(/【分身工作[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

/**
 * 交付时登记。status：'running'（已拿到会话）| 'queued'（池满排队）。
 * outcome 默认 unknown；只有显式回写才变 success。
 */
export function appendTask({
  task = '', reportTo = '', sessionId = '', status = 'running', ownerRequested = false,
  acceptance = '', fingerprint = '', outcome = 'unknown', evidence = '', attempts = 0,
  lastError = '', nextAction = '', intentionId = '',
} = {}) {
  const rows = readAll();
  const row = {
    id: newId(),
    at: new Date().toISOString(),
    task: String(task || '').replace(/\s+/g, ' ').slice(0, 160),
    taskFull: String(task || '').slice(0, 2000),
    reportTo: String(reportTo || ''),
    sessionId: String(sessionId || ''),
    status: status === 'queued' ? 'queued' : 'running',
    ownerRequested: !!ownerRequested,
    acceptance: clip(acceptance, 200),
    fingerprint: String(fingerprint || fingerprintOf(task)),
    outcome: OUTCOMES.includes(outcome) ? outcome : 'unknown',
    evidence: clip(evidence, 300),
    evidenceQuality: evidenceQuality(evidence),
    attempts: Math.max(0, Number(attempts) || 0),
    lastError: clip(lastError, 200),
    nextAction: clip(nextAction, 200),
    intentionId: String(intentionId || ''),
    lastAttemptAt: '',
  };
  rows.push(row);
  rewrite(rows);
  return row;
}

/** 队列出队：queued → running（拿到会话时）。找不到该行（已重写/已终态）返回 null。 */
export function promoteTask(taskId, sessionId) {
  const rows = readAll();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.id === taskId && r.status === 'queued') {
      r.status = 'running';
      r.sessionId = String(sessionId || '');
      r.promotedAt = new Date().toISOString();
      rewrite(rows);
      return r;
    }
  }
  return null;
}

/** 看门狗判超时：未终态 → expired（failed + 超时原因）。 */
export function expireTask(taskId, note = 'task timeout') {
  const rows = readAll();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.id === taskId && (r.status === 'queued' || r.status === 'running' || r.status === 'dispatched')) {
      r.status = 'expired';
      r.outcome = 'failed';
      r.finishedAt = new Date().toISOString();
      r.note = String(note || '').replace(/\s+/g, ' ').slice(0, 200);
      r.nextAction = r.nextAction || '超时了：下次先看环境是否可用，再把范围缩小一点。';
      rewrite(rows);
      return r;
    }
  }
  return null;
}

/** 投递失败/旧会话收尾回退：未开跑 → queued（保留原 at，不跳队）。 */
export function retaskToQueued(taskId) {
  const rows = readAll();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.id === taskId && ['running', 'dispatched'].includes(r.status)) {
      r.status = 'queued';
      r.sessionId = '';
      rewrite(rows);
      return r;
    }
  }
  return null;
}

/** 把一条待续任务重新放回队列，下次派活时带“上次/下一步”。 */
export function resumeTask(taskId) {
  const rows = readAll();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.id === taskId && ['failed', 'expired', 'finished'].includes(r.status) && r.outcome !== 'success') {
      r.status = 'queued';
      r.sessionId = '';
      r.finishedAt = '';
      r.outcome = 'unknown';
      r.promotedAt = '';
      rewrite(rows);
      return r;
    }
  }
  return null;
}

/**
 * 解析任务收尾的显式结果行。只认这一种格式（避免再把“完成”当成功）：
 *   【任务结果】成功|失败|卡住|未知｜证据：...｜下一步：...
 * 也兼容「结果：成功」开头。
 */
export function parseTaskResult(text = '') {
  const s = String(text ?? '');
  const m = /【任务结果】\s*(成功|失败|卡住|未知)\s*(?:[｜|]\s*证据[：:]\s*([^｜|\n]*))?\s*(?:[｜|]\s*下一步[：:]\s*([^\n]*))?/.exec(s)
    || /(?:^|\n)\s*结果[：:]\s*(成功|失败|卡住|未知)\s*(?:[｜|]\s*证据[：:]\s*([^｜|\n]*))?\s*(?:[｜|]\s*下一步[：:]\s*([^\n]*))?/.exec(s);
  if (!m) return null;
  const map = { 成功: 'success', 失败: 'failed', 卡住: 'blocked', 未知: 'unknown' };
  return {
    outcome: map[m[1]] || 'unknown',
    evidence: clip(m[2] || '', 300),
    nextAction: clip(m[3] || '', 200),
  };
}

/**
 * 任务会话 turn 结束时回写。
 * outcome 必须显式传；旧调用只传 ok 的，按 unknown 记账（不再冒充成功）。
 * @returns {{row, idempotent}}
 */
export function finishTask(taskId, { ok, outcome = 'unknown', note = '', evidence = '', nextAction = '', lastError = '', bySessionId = '' } = {}) {
  const rows = readAll();
  let row = null;
  if (taskId) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].id === taskId) { row = rows[i]; break; }
    }
  }
  if (!row && bySessionId) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r && r.sessionId === String(bySessionId)
          && (r.status === 'dispatched' || r.status === 'running' || r.status === 'queued')) {
        row = r; break;
      }
    }
  }
  if (!row || !['dispatched', 'running', 'queued'].includes(row.status)) {
    return { row: null, idempotent: true };
  }
  // 兼容旧调用：只给 ok 的，true 也只代表“回合结束”，不再代表 success。
  if (ok !== undefined && outcome === 'unknown' && ok === false) outcome = 'failed';
  row.outcome = OUTCOMES.includes(outcome) ? outcome : 'unknown';
  row.status = row.outcome === 'success' ? 'finished' : 'failed';
  row.finishedAt = new Date().toISOString();
  row.lastAttemptAt = row.finishedAt;
  row.attempts = Math.max(0, Number(row.attempts) || 0) + 1;
  row.note = String(note || '').replace(/\s+/g, ' ').slice(0, 300);
  if (evidence) row.evidence = clip(evidence, 300);
  if (nextAction) row.nextAction = clip(nextAction, 200);
  if (lastError) row.lastError = clip(lastError, 200);
  // done 必须有可核对证据；空话（weak）也不算成功。
  row.evidenceQuality = evidenceQuality(row.evidence);
  if (row.outcome === 'success' && row.evidenceQuality !== 'strong') {
    row.outcome = 'blocked';
    row.status = 'failed';
    row.nextAction = row.nextAction || (row.evidenceQuality === 'weak'
      ? '证据太虚：补文件/截图/网址/机检结果，或写“他确认”。'
      : '还没写证据：补一张截图/一句机检结果，再算做成。');
  }
  if (row.outcome !== 'success' && !String(row.nextAction || row.lastError || '').trim()) {
    row.nextAction = '还没写下一步：先想清楚卡在哪，再做一次。';
  }
  rewrite(rows);
  // [INTENTION-OUTCOME] 任务若挂了 intentionId，结束自动落一条 outcome；不重复造经验。
  if (row.intentionId && ['success', 'failed', 'blocked'].includes(row.outcome)) {
    try {
      appendOutcome(stateDataPath('outcomes.jsonl'), createOutcome({
        intentionId: row.intentionId,
        expected: row.acceptance || '',
        actual: row.evidence || row.note || '',
        result: row.outcome === 'success' ? 'success' : 'failed',
        evidence: row.evidence || '',
      }));
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-taskledger.js:242'); }
  }
  return { row, idempotent: false };
}

/** 未终态（queued + running + 旧 dispatched 全算在跑/在排）。 */
export function pendingTasks() {
  return readAll().filter((r) => r && ['queued', 'running', 'dispatched'].includes(r.status));
}

/** 队列里的任务（at 升序 = 排队顺序）。 */
export function queuedTasks() {
  return readAll().filter((r) => r && r.status === 'queued')
    .sort((a, b) => (String(a.at || '') < String(b.at || '') ? -1 : 1));
}

export function queuedCount() {
  return readAll().filter((r) => r && r.status === 'queued').length;
}

export function runningCount() {
  return readAll().filter((r) => r && ['running', 'dispatched'].includes(r.status)).length;
}

/** 待续：失败/卡住/未知，且有下一步；不自动重跑，只在唤醒里递给她。 */
export function resumableTasks({ now = Date.now(), days = 14, limit = 5 } = {}) {
  const cutoff = now - Math.max(1, Number(days) || 14) * 86400000;
  return readAll()
    .filter((r) => r && ['failed', 'expired'].includes(r.status) && ['failed', 'blocked', 'unknown'].includes(r.outcome))
    .filter((r) => (Date.parse(r.finishedAt || r.at || '') || 0) >= cutoff)
    .filter((r) => String(r.nextAction || r.lastError || '').trim())
    .sort((a, b) => String(b.finishedAt || b.at || '').localeCompare(String(a.finishedAt || a.at || '')))
    .slice(0, Math.max(1, Number(limit) || 5));
}

/** 找到同指纹的待续任务（用于“先接上旧的，不新建”）。 */
export function findResumableTask(fingerprint, { now = Date.now(), days = 14 } = {}) {
  const fp = String(fingerprint || '').trim();
  if (!fp) return null;
  return resumableTasks({ now, days, limit: 20 }).find((r) => String(r.fingerprint || '') === fp) || null;
}

/** 渲染成唤醒提示：在跑/排队 + 待续（上次做到哪、下一步）。 */
export function renderLedger() {
  const rows = pendingTasks();
  const resumable = resumableTasks({ limit: 3 });
  if (!rows.length && !resumable.length) return '';
  const out = [];
  const running = rows.filter((r) => r.status !== 'queued');
  const queued = rows.filter((r) => r.status === 'queued');
  if (running.length) {
    out.push(`【手头在跑的事 ${running.length} 件】\n` + running.slice(-3).map((r) => `- ${r.task.slice(0, 50)}`).join('\n'));
  }
  if (queued.length) {
    out.push(`【排队等着干的事 ${queued.length} 件】\n` + queued.slice(-3).map((r) => `- ${r.task.slice(0, 50)}`).join('\n'));
  }
  if (resumable.length) {
    out.push('【上次没做完、还留着的事】\n' + resumable.map((r) => {
      const last = r.lastError ? `上次卡在：${r.lastError}` : (r.note ? `上次：${r.note}` : '上次没有结论');
      const next = r.nextAction ? `；下一步：${r.nextAction}` : '';
      return `- ${r.task.slice(0, 44)}｜${last}${next}`;
    }).join('\n'));
    out.push('（这些不是现在的命令；想接着做就接着做，不想做了就明确放下。别从零重开。）');
  }
  out.push('（做完/失败了记得交代一句，别让它一直挂着。）');
  return out.join('\n');
}
