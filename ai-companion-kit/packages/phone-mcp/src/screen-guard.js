// screen-guard.js · 截图前的「眼睛保护」：先让屏幕醒着，再确认画面不是黑的。
//
// 问题（2026-10-29 00:21 实机）：`adb exec-out screencap -p` 在屏幕熄灭/锁屏时返回**全黑图**。
// phone_look / phone_ocr / phone_find_template / phone_tap_desc 原来截屏前不唤醒、截完也不判黑帧，
// 直接把黑图递给她——她能看，但看到的是黑的，于是她说「屏幕亮着但滑不动」「我这边只能看着」，
// 主人反过来以为她的视觉坏了。
//
// 纪律：这里只做「让眼睛能睁开」的最小动作——确认屏幕醒着（不醒就按一次 KEYCODE_WAKEUP），
// 黑帧重试一次，仍黑就**明确说清楚**（熄屏/锁着，先去解锁），不猜、不编、不把黑图当画面。
// 纯函数（parseWakefulness / isBlackFrame）可直接单测；IO 通过注入的 shell 走，测试可替换。

import { pngLuma } from './png-scale.js';

/** 平均亮度 ≤ 6 且最亮像素 ≤ 24 才认定为「全黑」——深色界面/黑底白字不会被误判。 */
export const BLACK_MEAN_MAX = 6;
export const BLACK_MAX_MAX = 24;

/**
 * 从 `dumpsys power` 的输出里读屏幕状态。
 * @param {string} out
 * @returns {'Awake'|'Asleep'|'Dozing'|'Dreaming'|''} 读不到返回空串
 */
export function parseWakefulness(out) {
  const m = /mWakefulness=(\w+)/.exec(String(out ?? ''));
  return m ? m[1] : '';
}

/**
 * 这一帧是不是黑的（截图全黑 = 屏幕熄了/锁着，不是画面）。
 * 拿不到亮度统计（格式不支持）时按「不是黑帧」，绝不误伤正常截图。
 * @param {{mean:number,max:number}|null} stats
 */
export function isBlackFrame(stats) {
  if (!stats || !Number.isFinite(Number(stats.mean)) || !Number.isFinite(Number(stats.max))) return false;
  return Number(stats.mean) <= BLACK_MEAN_MAX && Number(stats.max) <= BLACK_MAX_MAX;
}

/** 黑帧时给她的统一说法：事实 + 该做什么，不猜画面内容。 */
export function blackFrameReason() {
  return '屏幕是黑的：截图全黑，说明手机屏幕熄了或还锁着。先按电源键亮屏、解锁，再让我看——这不是画面内容。';
}

/** 截一张图并算亮度：take() 返回 PNG Buffer。 */
export async function grabWithLuma(take) {
  const buf = await take();
  if (!Buffer.isBuffer(buf) || !buf.length) return { buf: null, stats: null };
  return { buf, stats: pngLuma(buf) };
}

/**
 * 读屏幕状态。shell(cmd) 返回命令输出字符串。
 * @returns {Promise<'awake'|'asleep'|'unknown'>}
 */
export async function screenAwake(shell) {
  try {
    const out = await shell('dumpsys power | grep -m1 mWakefulness=');
    const state = parseWakefulness(out);
    if (!state) return 'unknown';
    return state === 'Awake' ? 'awake' : 'asleep';
  } catch {
    return 'unknown';
  }
}

/** 按一次电源键（KEYCODE_WAKEUP），屏幕已醒也能安全调用。 */
export async function wakeKey(shell) {
  try {
    await shell('input keyevent KEYCODE_WAKEUP');
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保屏幕醒着：查状态 → 睡着就按一次电源键 → 等它亮 → 再看一眼。
 * @param {(cmd:string)=>Promise<string>} shell
 * @param {(ms:number)=>Promise<void>} [sleep]
 * @returns {Promise<'awake'|'woke'|'wake-failed'|'unknown'>}
 */
export async function ensureAwake(shell, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const before = await screenAwake(shell);
  if (before === 'awake' || before === 'unknown') return before;
  await wakeKey(shell);
  await sleep(400);
  const after = await screenAwake(shell);
  if (after === 'awake') return 'woke';
  if (after === 'unknown') return 'unknown';
  return 'wake-failed';
}
