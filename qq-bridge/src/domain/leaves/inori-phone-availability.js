// inori-phone-availability.js · 「手机现在能不能用」的运行时事实（60 秒缓存，只查 adb devices）
//
// 为什么需要：自主时间/唤醒里没有任何「手机连不上」的事实，她会先规划手机上的事、
// 试两下失败，一小时就过去了（2026-10-30 实测：练手位把她推去开明日方舟）。
// 这里只做一件事：问 adb「现在有设备吗」，能确定没设备时给一句事实+许可，
// 不指示她干什么（活动菜单的纪律：只当备选、不催促）。
//
// 纪律：纯逻辑 + 注入 exec，不读盘不联网；缓存 60 秒；查不清就返回 unknown（不瞎说）。
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVICE_TTL_MS = 60_000;
// 仓库根（本文件在 qq-bridge/src/domain/leaves）→ tools/platform-tools/adb.exe
const REPO_ROOT = pathDefault.resolve(pathDefault.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const DEFAULT_ADB = pathDefault.join(REPO_ROOT, 'tools', 'platform-tools', 'adb.exe');

/** 选 adb 路径：cfg.phone.adb → cfg.socialV2.phone.adb → env.PHONE_ADB → 默认路径（存在才用） */
export function selectAdb(cfg = {}, { env = process.env, exists = fsDefault.existsSync, path = pathDefault } = {}) {
  const candidates = [
    cfg?.phone?.adb,
    cfg?.socialV2?.phone?.adb,
    env?.PHONE_ADB,
    DEFAULT_ADB,
  ].filter(Boolean).map(String);
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-phone-availability.js:24'); }
  }
  return '';
}

/** 解析 `adb devices` 输出：只数状态为 device 的行（offline/unauthorized 不算可用） */
export function parseDevices(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let device = 0, offline = 0, unauthorized = 0;
  for (const l of lines) {
    if (/^List of devices/i.test(l) || l.startsWith('*')) continue;
    const [serial, state] = l.split(/\s+/);
    if (!serial || !state) continue;
    if (state === 'device') device += 1;
    else if (state === 'offline') offline += 1;
    else if (state === 'unauthorized') unauthorized += 1;
  }
  return { device, offline, unauthorized, total: device + offline + unauthorized };
}

/**
 * 探一次：返回 { state: 'available'|'unavailable'|'unknown', count, reason }
 * - available：确实有设备
 * - unavailable：adb 能跑但 0 个可用设备（offline/unauthorized 也归不可用，但 reason 不同）
 * - unknown：adb 跑不了/超时/输出看不懂（不拿故障当「手机不在」）
 */
export async function probePhone({ adbPath = DEFAULT_ADB, execFile, timeoutMs = 5000 } = {}) {
  if (typeof execFile !== 'function') return { state: 'unknown', count: 0, reason: 'no-exec' };
  if (!adbPath) return { state: 'unknown', count: 0, reason: 'no-adb' };
  try {
    const out = await new Promise((resolve) => {
      execFile(adbPath, ['devices'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? '' : String(stdout ?? ''));
      });
    });
    if (!out) return { state: 'unknown', count: 0, reason: 'adb-error' };
    const parsed = parseDevices(out);
    if (parsed.device > 0) return { state: 'available', count: parsed.device, reason: '' };
    if (parsed.offline > 0) return { state: 'unavailable', count: 0, reason: 'offline' };
    if (parsed.unauthorized > 0) return { state: 'unavailable', count: 0, reason: 'unauthorized' };
    return { state: 'unavailable', count: 0, reason: 'no-device' };
  } catch {
    return { state: 'unknown', count: 0, reason: 'exception' };
  }
}

/** 带 60 秒缓存的探测器；并发只探一次 */
export function createPhoneProbe({ adbPath, execFile, ttlMs = DEVICE_TTL_MS, now = () => Date.now() } = {}) {
  let cached = null; // { at, result }
  let inflight = null;
  async function get() {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.result;
    if (inflight) return inflight;
    inflight = (async () => {
      const result = await probePhone({ adbPath, execFile });
      cached = { at: now(), result };
      inflight = null;
      return result;
    })();
    return inflight;
  }
  return { get, peek: () => cached?.result ?? null, invalidate: () => { cached = null; } };
}

/** 只有确定「没设备」时才给这句话；不指使她干什么 */
export function renderPhoneLine(result) {
  if (!result || result.state !== 'unavailable') return null;
  const why = result.reason === 'offline'
    ? '设备显示 offline'
    : result.reason === 'unauthorized'
      ? '设备没授权（USB 调试没点允许）'
      : 'adb 里没有已连接的设备';
  return `【手机现在连不上】${why}。想做的事要是非得用手机，先放着；今天别把时间花在手机上。`;
}
