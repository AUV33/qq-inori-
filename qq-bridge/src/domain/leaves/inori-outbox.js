// inori-outbox.js · 没发出去的 QQ 消息（断线时不再静默丢掉）
//
// 为什么需要：桥接发送失败时只 `outgoing.markFailed(key)` + 打日志——消息就没了。
// 2026-10-30 SnowLuma 断线 10 小时里，她那几条回复全被静默丢弃，她自己也以为说出去了。
// 这里把失败的片段记到一个有界小账本里，下一次唤醒把「没发出去的话」告诉她（自己决定补不补），
// 过 TTL 自动作废（不催、不替她补发）。
//
// 纪律：纯函数 + 注入 fs/now，不读盘不联网；容量/时长都有上限。
import fsDefault from 'node:fs';
import { atomicWriteText } from '../../bootstrap/fs-utils.mjs';
import pathDefault from 'node:path';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAX_ITEMS = 50;

function readRows(file, fs) {
  try {
    // [ROBUST-JSONL] 逐行解析：以前整条 map(JSON.parse) 在一个 try 里，
    // 只要有一行被写坏（半截 JSON / 断电截断），**整个 outbox 都会读成空**，
    // 那几条没发出去的话就彻底看不到了。坏行跳过，好行照常返回。
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.text);
  } catch {
    return [];
  }
}

function keepFresh(rows, now, ttlMs) {
  const fresh = rows.filter((r) => now - Number(r.at || 0) <= ttlMs);
  return fresh.slice(-MAX_ITEMS);
}

function writeRows(file, rows, fs, path) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteText(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  } catch (error) {
    try { console.error('[outbox] 落盘失败（不挡发送）:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-outbox.js:33'); }
  }
}

/**
 * 记一条没发出去的话。
 * @param {{file:string, key:string, text:string, at?:number, fs?:any, path?:any, ttlMs?:number, now?:number}} p
 */
export function appendUndelivered({ file, key, text, at, fs = fsDefault, path = pathDefault, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  const clean = String(text ?? '').trim();
  if (!file || !clean) return null;
  const rows = keepFresh(readRows(file, fs), now, ttlMs);
  const dup = rows.find((r) => r.key === key && r.text === clean);
  if (dup) { dup.at = now; writeRows(file, rows, fs, path); return dup; }
  const row = { at: Number(at ?? now), key: String(key ?? ''), text: clean.slice(0, 200) };
  rows.push(row);
  writeRows(file, rows, fs, path);
  return row;
}

/** 取还新鲜的条目（默认 10 分钟内的） */
export function listUndelivered({ file, fs = fsDefault, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!file) return [];
  return keepFresh(readRows(file, fs), now, ttlMs);
}

/** 清掉（她补发成功 / TTL 过期后顺手清） */
export function clearUndelivered({ file, fs = fsDefault } = {}) {
  if (!file) return;
  writeRows(file, [], fs, pathDefault);
}

/**
 * 唤醒提示里的一行：只给事实 + 给许可，不催她。
 * 没东西返回 null（不造暗示）。
 */
export function renderUndeliveredLine(items) {
  const rows = Array.isArray(items) ? items.filter((r) => r && r.text) : [];
  if (!rows.length) return null;
  const lines = rows.slice(-3).map((r) => `- ${r.key ? `${r.key}：` : ''}${String(r.text).slice(0, 60)}`);
  return `【上次没发出去的话】\n这几句当时网关断着，没送到（${rows.length} 条）：\n${lines.join('\n')}\n想补就直接再说一遍；不想补就让它过去。`;
}
