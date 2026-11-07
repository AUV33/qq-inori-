// freedom-monitor.js · 自由度观测的落盘/汇总/健康检查
//
// 观测层本身也要被监控：如果 [freedom] 只打文本日志，没人能回答
// “最近她还有没有选择权、预算是不是一直耗尽、群/私聊的分布对不对”。
// 这里把每次唤醒的策略快照追加到 state/freedom-log.jsonl，并提供：
//   summarizeFreedom(rows)        —— 计数，不评价
//   checkFreedomMonitor(rows)     —— 监控器自检：有没有记录、是否过期、字段是否完整
//   recordFreedomPolicy(policy)   —— 追加一条并做 5000 行上限
//
// 纪律：这里不读 prompt、不碰权限，只写观测数据。

import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_STALE_MS = 24 * 3600 * 1000;

export function toFreedomRow(policy = {}, now = Date.now()) {
  return {
    at: new Date(now).toISOString(),
    key: String(policy.key ?? ''),
    mode: String(policy.mode ?? ''),
    trust: String(policy.trust ?? 'unknown'),
    reply: !!policy.reply?.can,
    replyOptions: Array.isArray(policy.reply?.options) ? policy.reply.options.slice(0, 5) : [],
    initiate: !!policy.initiate?.can,
    initiateRemaining: Number(policy.initiate?.remaining) || 0,
    explore: !!policy.explore?.can,
    exploreRemaining: Number(policy.explore?.budgetLeft) || 0,
    selfEdit: !!policy.selfEdit?.can,
    manageGroup: !!policy.manageGroup?.can,
  };
}

export function recordFreedomPolicy(policy, { file, now = Date.now(), maxRows = DEFAULT_MAX_ROWS } = {}) {
  if (!file) return null;
  const row = toFreedomRow(policy, now);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    // 只保留最近 maxRows 行；读失败不挡观测。
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > maxRows) {
        // [AUDIT-FIX] 原子轮转：原地 writeFileSync 与并发 append 交错会静默丢行。
        // 先写唯一 tmp 再 rename，写失败清理 tmp，绝不半截覆盖观测数据。
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
          fs.writeFileSync(tmp, lines.slice(-maxRows).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
          renameWithRetry(tmp, file);
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
          throw e;
        }
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'freedom-monitor.js:47'); }
    return row;
  } catch {
    return null;
  }
}

export function summarizeFreedom(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const byTrust = {};
  let reply = 0, initiate = 0, explore = 0, selfEdit = 0, manageGroup = 0;
  let lastAt = 0;
  for (const r of list) {
    const trust = String(r?.trust ?? 'unknown');
    byTrust[trust] = (byTrust[trust] || 0) + 1;
    if (r?.reply) reply++;
    if (r?.initiate) initiate++;
    if (r?.explore) explore++;
    if (r?.selfEdit) selfEdit++;
    if (r?.manageGroup) manageGroup++;
    const t = Date.parse(String(r?.at ?? ''));
    if (Number.isFinite(t) && t > lastAt) lastAt = t;
  }
  return { total: list.length, byTrust, reply, initiate, explore, selfEdit, manageGroup, lastAt };
}

export function checkFreedomMonitor(rows = [], { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, reason: 'no-records', stale: true, total: 0 };
  const required = ['at', 'trust', 'reply', 'initiate', 'explore', 'selfEdit', 'manageGroup'];
  const bad = list.find((r) => !r || required.some((k) => !(k in r)));
  if (bad) return { ok: false, reason: 'schema-incomplete', stale: false, total: list.length, bad };
  const lastAt = Math.max(...list.map((r) => Date.parse(String(r.at ?? '')) || 0));
  const stale = !Number.isFinite(lastAt) || (now - lastAt > staleMs);
  return { ok: !stale, reason: stale ? 'stale' : 'ok', stale, total: list.length, lastAt };
}

export function formatFreedomSummary(summary = {}, health = {}) {
  const s = summary || {};
  return `[freedom-report] total=${s.total ?? 0} reply=${s.reply ?? 0} initiate=${s.initiate ?? 0} explore=${s.explore ?? 0} selfEdit=${s.selfEdit ?? 0} manageGroup=${s.manageGroup ?? 0} health=${health.ok ? 'ok' : health.reason || 'unknown'} stale=${!!health.stale}`;
}
