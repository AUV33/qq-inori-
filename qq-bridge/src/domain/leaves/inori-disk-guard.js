// inori-disk-guard.js · 磁盘资源门：系统盘水位与 DSH 临时快照
//
// 为什么要有它（2026-10-31 事故）：
//   DSH 的 workspace-changes 插件每个会话在 %TEMP% 建一个影子 git 对象库，
//   每回合 `git add --all` 给整个工作区做快照。工作区里一旦有未忽略的大文件
//   （这次是 tools/sd-models 下 3.7GB 模型权重），每次都会压到 30 秒超时被 kill，
//   写了一半的 tmp_obj 留在 objects/ 里，一天堆了 89GB，C 盘从 100GB 掉到 23GB。
//   插件自己的 sweep 只清 12 小时前的目录，挡不住当天暴涨。
//
// 设计纪律（沿用 resource-gate.js 的四条）：
//   1. 阈值必须可配、可关；
//   2. 默认只观察（只记日志，不删不挡）；
//   3. 不新增常驻进程——一个 unref 的定时器，采样用 fs.statfsSync + readdir；
//   4. 只做资源观测，不参与说话/记忆/人格任何判断。
//
// 与 resource-gate 的分工：那个管内存/CPU，决定低优先级后台让不让路；
// 这个管磁盘，只报告水位并（显式开启时）清过期临时快照。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TEMP_PREFIX = 'dsh-workspace-changes-';
export const DEFAULT_THRESHOLDS = Object.freeze({
  minFreeGB: 20,
  maxSnapshotGB: 12,
  maxAgeHours: 12,
});

/** 统计一个目录的递归字节数；读不到的文件跳过，不让统计失败。 */
export function dirBytes(dir) {
  let total = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          files += 1;
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-disk-guard.js:48'); }
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

/**
 * 列出临时根下指定前缀的快照目录。
 * 只认目录、只认前缀，别的任何东西都不碰。
 */
export function listSnapshotDirs({ tempRoot = os.tmpdir(), prefix = DEFAULT_TEMP_PREFIX } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const dir = path.join(tempRoot, entry.name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    const { bytes, files } = dirBytes(dir);
    out.push({ name: entry.name, path: dir, bytes, files, mtimeMs: stat.mtimeMs });
  }
  return out;
}

/** 汇总快照目录：个数 + 总字节。 */
export function summarizeSnapshots(dirs = []) {
  const rows = Array.isArray(dirs) ? dirs : [];
  return {
    count: rows.length,
    bytes: rows.reduce((sum, d) => sum + (Number(d?.bytes) || 0), 0),
  };
}

/** 读系统盘可用空间；读不到返回 null（调用方按“未知”处理，不误报）。 */
export function readDiskSpace(target = os.tmpdir(), statfs = fs.statfsSync) {
  try {
    const s = statfs(target);
    const bsize = Number(s.bsize) || 0;
    const total = bsize * (Number(s.blocks) || 0);
    const free = bsize * (Number(s.bavail ?? s.bfree) || 0);
    if (!(total > 0)) return null;
    return { total, free };
  } catch {
    return null;
  }
}

/**
 * 判级：ok / warn / critical。
 * warn 是提前量（还没到红线），critical 才值得喊人。
 */
export function evaluateDiskState({
  freeBytes = null,
  totalBytes = null,
  snapshotBytes = 0,
  minFreeGB = DEFAULT_THRESHOLDS.minFreeGB,
  maxSnapshotGB = DEFAULT_THRESHOLDS.maxSnapshotGB,
} = {}) {
  const reasons = [];
  const freeGB = Number.isFinite(freeBytes) ? freeBytes / 1024 ** 3 : null;
  const snapshotGB = (Number(snapshotBytes) || 0) / 1024 ** 3;
  let level = 'ok';

  if (freeGB !== null && freeGB < minFreeGB) {
    level = 'critical';
    reasons.push(`C 盘可用 ${freeGB.toFixed(1)}GB < ${minFreeGB}GB`);
  } else if (freeGB !== null && freeGB < minFreeGB * 1.5) {
    level = 'warn';
    reasons.push(`C 盘可用 ${freeGB.toFixed(1)}GB 接近下限 ${minFreeGB}GB`);
  }

  if (snapshotGB > maxSnapshotGB * 2) {
    level = 'critical';
    reasons.push(`TEMP 快照 ${snapshotGB.toFixed(1)}GB > ${maxSnapshotGB * 2}GB`);
  } else if (snapshotGB > maxSnapshotGB) {
    if (level === 'ok') level = 'warn';
    reasons.push(`TEMP 快照 ${snapshotGB.toFixed(1)}GB > ${maxSnapshotGB}GB`);
  }

  return {
    level,
    reasons,
    freeGB,
    totalGB: Number.isFinite(totalBytes) ? totalBytes / 1024 ** 3 : null,
    snapshotGB,
  };
}

/** 挑出超过 maxAgeMs 没动过的快照目录（按 mtime，不按创建时间）。 */
export function selectStaleDirs(dirs = [], { maxAgeMs = 12 * 3600 * 1000, now = Date.now() } = {}) {
  return (Array.isArray(dirs) ? dirs : [])
    .filter((d) => Number.isFinite(d?.mtimeMs) && d.mtimeMs < now - maxAgeMs);
}

/**
 * 删除过期快照目录。调用方负责先 selectStaleDirs，且只有显式开启时才调。
 * 双保险：只删 prefix 匹配的目录，避免 path 拼错误删。
 */
export function removeSnapshotDirs(dirs = [], { tempRoot = os.tmpdir(), prefix = DEFAULT_TEMP_PREFIX, remove = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }) } = {}) {
  const removed = [];
  const failed = [];
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    const name = String(dir?.name ?? '');
    const full = String(dir?.path ?? '');
    if (!name.startsWith(prefix) || path.dirname(full) !== tempRoot) {
      failed.push({ name, error: '路径不匹配前缀或不在临时根下' });
      continue;
    }
    try {
      remove(full);
      removed.push({ name, bytes: Number(dir.bytes) || 0 });
    } catch (error) {
      failed.push({ name, error: String(error?.message ?? error) });
    }
  }
  return { removed, failed, freedBytes: removed.reduce((s, r) => s + r.bytes, 0) };
}

/**
 * 建磁盘守卫。所有外部依赖可注入，便于单测。
 * @returns {{sample:Function, state:Function, start:Function, stop:Function}}
 */
export function createDiskGuard({
  enabled = true,
  observeOnly = true,
  cleanup = false,
  sampleMs = 10 * 60 * 1000,
  minFreeGB = DEFAULT_THRESHOLDS.minFreeGB,
  maxSnapshotGB = DEFAULT_THRESHOLDS.maxSnapshotGB,
  maxAgeHours = DEFAULT_THRESHOLDS.maxAgeHours,
  tempRoot = os.tmpdir(),
  prefix = DEFAULT_TEMP_PREFIX,
  log = () => {},
  now = () => Date.now(),
  list = listSnapshotDirs,
  statfs = fs.statfsSync,
  remove = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (t) => clearInterval(t),
} = {}) {
  let last = null;
  let lastLevel = null;
  let lastLogAt = 0;
  let timer = null;

  function sample() {
    if (!enabled) return last;
    const space = readDiskSpace(tempRoot, statfs);
    const dirs = list({ tempRoot, prefix });
    const snapshots = summarizeSnapshots(dirs);
    const state = evaluateDiskState({
      freeBytes: space?.free ?? null,
      totalBytes: space?.total ?? null,
      snapshotBytes: snapshots.bytes,
      minFreeGB,
      maxSnapshotGB,
    });
    const at = now();
    const next = {
      ...state,
      at,
      snapshotCount: snapshots.count,
      tempRoot,
      cleaned: null,
    };

    const changed = state.level !== lastLevel;
    const heartbeatDue = at - lastLogAt >= 60 * 60 * 1000;
    if (changed || (state.level !== 'ok' && heartbeatDue) || lastLogAt === 0) {
      const free = state.freeGB === null ? '?' : state.freeGB.toFixed(1);
      const line = `[disk] C: ${free}GB 可用 / TEMP 快照 ${state.snapshotGB.toFixed(1)}GB(${snapshots.count} 个) · ${state.level}${state.reasons.length ? ` · ${state.reasons.join('；')}` : ''}`;
      log(line);
      lastLogAt = at;
    }

    // 清理是显式开关：cleanup=true 且非 observeOnly 才动手，且只清过期目录。
    if (cleanup && !observeOnly && state.level !== 'ok') {
      const stale = selectStaleDirs(dirs, { maxAgeMs: maxAgeHours * 3600 * 1000, now: at });
      if (stale.length) {
        const result = removeSnapshotDirs(stale, { tempRoot, prefix, remove });
        next.cleaned = { count: result.removed.length, freedBytes: result.freedBytes, failed: result.failed.length };
        log(`[disk] 清理过期快照 ${result.removed.length} 个，释放 ${(result.freedBytes / 1024 ** 3).toFixed(1)}GB${result.failed.length ? `，失败 ${result.failed.length} 个` : ''}`);
      }
    }

    last = next;
    lastLevel = state.level;
    return next;
  }

  function start() {
    if (!enabled || timer) return;
    // 首次采样推迟 10 秒：不挡桥接启动，也避开启动时的高峰 IO。
    const kick = setTimeout(() => {
      try {
        sample();
      } catch (error) {
        log(`[disk] 采样异常：${String(error?.message ?? error)}`);
      }
    }, 10_000);
    kick?.unref?.();
    timer = setTimer(() => {
      try {
        sample();
      } catch (error) {
        log(`[disk] 采样异常：${String(error?.message ?? error)}`);
      }
    }, sampleMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { sample, state: () => last, start, stop };
}
