// send-ledger.js · 发送幂等账本（跨重启）
//
// 问题：桥接被 self-edit 重启时，内存里的「本回合已用工具发过」标记全丢，
// 重启后同一句话会被自动转发再发一遍；工具重试也会重发。日志里的
// `成功 3/2 条`、`成功 4/2 条` 就是它。
//
// 做法：落盘一张 30 分钟的小账本，按 (key, 归一化文本) 记「谁发的、什么时候」。
//   - tool → auto：10 分钟内同一句，auto 让路（这是重复回复的主因）。
//   - tool → tool：10 分钟内同一句，第二次不发（重启后的重试）。
//   - auto → auto：**永不拦截**——她自己想重复说一句"嗯"，那是自由，不是 bug。
//
// 账本永远不挡发送：读写失败就当没有账本，宁可重复也不能哑火。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../shared/project-paths.js';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

const FILE = process.env.SEND_LEDGER_FILE || stateDataPath('send-ledger.json');
export const TTL_MS = 30 * 60 * 1000;
export const TOOL_WINDOW_MS = 10 * 60 * 1000;
const MAX_ITEMS = 600;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(raw?.items) ? raw.items : [];
  } catch { cache = []; }
  return cache;
}

function save(items) {
  cache = items;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }), 'utf8');
    renameWithRetry(tmp, FILE);
  } catch (error) {
    // 账本写不进仍不能挡发送，但必须留痕，否则重启后无法判断是否重复发送。
    console.error('[send-ledger] 写账本失败:', error?.message ?? error);
  }
}

/** 归一化：抹掉空白、markdown 记号和标点，让"工具发的原文"和"自动转发的 plain"能对上。
 *  只作用于 tool→auto / tool→tool 的 10 分钟窗口；auto→auto 不受影响，不会吞掉她正常的重复。 */
export function normalize(text) {
  return String(text ?? '').replace(/[\s*_~`#>]/g, '').replace(/\p{P}/gu, '');
}

export function fingerprint(key, text) {
  return crypto.createHash('sha1').update(`${key}\u0000${normalize(text)}`).digest('hex').slice(0, 16);
}

/** 这条要不要挡掉？path: 'tool' | 'auto' */
export function shouldSkip(key, text, path, now = Date.now()) {
  try {
    if (!text) return false;
    const h = fingerprint(key, text);
    for (const e of load()) {
      if (!e || e.k !== key || e.h !== h) continue;
      const age = now - Number(e.t || 0);
      if (path === 'auto' && e.p === 'tool' && age < TOOL_WINDOW_MS) return true;
      if (path === 'tool' && e.p === 'tool' && age < TOOL_WINDOW_MS) return true;
    }
    return false;
  } catch { return false; }
}

/** 记下"这句发出去了" */
export function note(key, text, path, now = Date.now()) {
  try {
    if (!text) return;
    const items = load().filter((e) => e && now - Number(e.t || 0) < TTL_MS);
    items.push({ k: key, h: fingerprint(key, text), p: path, t: now });
    save(items.slice(-MAX_ITEMS));
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'send-ledger.js:79'); }
}

/** 测试用：清空内存缓存 */

// 测试钩子：清掉进程内缓存，让每条用例从磁盘重新读（只给单测用）。
export function _resetCache() { cache = null; }
