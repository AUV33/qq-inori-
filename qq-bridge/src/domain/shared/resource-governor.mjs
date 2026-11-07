// resource-governor.mjs · 设备感知资源治理（E0）
//
// 目标：主人用电脑时，后台任务让路；实时回消息不受影响。零新增进程、零新增依赖。
// busy 判定优先级：环境变量 QQ_DEVICE_BUSY=1 > 你自备的 device-busy.flag（mtime 在窗口内）> 默认空闲。
// 你可以在打游戏/渲染时让外部脚本 touch 一下 flag，Hub/后台任务就会自动让路。

import fs from 'node:fs';

export const RESOURCE_GOVERNOR_VERSION = 1;
export const DEFAULT_BUSY_WINDOW_MS = 10 * 60 * 1000;

/** 零依赖的设备忙闲传感器（可选 flag 文件）。 */
export function createDeviceIdleSensor({ flagFile, idleWindowMs = DEFAULT_BUSY_WINDOW_MS, now = Date.now, fsImpl = fs } = {}) {
  return function isDeviceBusy() {
    if (String(process.env.QQ_DEVICE_BUSY || '') === '1') return true;
    if (!flagFile) return false;
    try {
      const st = fsImpl.statSync(flagFile);
      return now() - Number(st.mtimeMs || 0) < idleWindowMs;
    } catch {
      return false;
    }
  };
}

/**
 * @param {{isDeviceBusy?:Function, now?:Function, log?:Function, mode?:'normal'|'powersave'}} opts
 */
export function createResourceGovernor({ isDeviceBusy, now = Date.now, log = () => {}, mode = 'normal' } = {}) {
  let currentMode = mode === 'powersave' ? 'powersave' : 'normal';
  let ran = 0;
  let skipped = 0;

  function busy() {
    try { return typeof isDeviceBusy === 'function' ? !!isDeviceBusy() : false; }
    catch { return false; }
  }

  /** realtime 永远放行；background 在 busy / powersave 时让路。 */
  function canRun(kind = 'background') {
    if (kind === 'realtime') return true;
    if (currentMode === 'powersave') return false;
    return !busy();
  }

  /** 后台模型/重计算统一入口：busy 时直接跳过，不唤醒模型。 */
  async function requestModel(kind, fn) {
    if (!canRun(kind)) {
      skipped += 1;
      return { skipped: true, reason: currentMode === 'powersave' ? 'powersave' : 'device-busy' };
    }
    ran += 1;
    try {
      return { skipped: false, value: await fn() };
    } catch (error) {
      log(`[governor] 任务失败（忽略）: ${error?.message ?? error}`);
      return { skipped: false, value: undefined, error };
    }
  }

  function setMode(m) { currentMode = m === 'powersave' ? 'powersave' : 'normal'; }
  function status() { return { v: RESOURCE_GOVERNOR_VERSION, mode: currentMode, busy: busy(), ran, skipped }; }

  return { canRun, requestModel, setMode, status };
}
