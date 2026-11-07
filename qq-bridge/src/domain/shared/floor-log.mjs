// floor-log.mjs · 每次「该不该开口」判定的结构化落盘（2026-10-28）
//
// 为什么要有它：turn-taking 的阈值、实测间隔分位、被接住率都要用真实数据调，但以前
// 每次判定只有一行自然语言日志（`[floor] … reply=0.28｜群里没点她`），既不能按 reason
// 分组算开口率，也没法回算「她开口后有没有人接」。这个模块只做一件事：
// 把判定结果追加成一行 JSONL，带简单轮转，写失败绝不影响唤醒。
//
// 纪律：
//   · 只追加、不改状态；调用方传什么就记什么（schema 由调用方定）。
//   · 任何异常都吞掉——观测失败不能变成「她不该醒」或「进程崩」。
//   · 轮转只保留一份历史（.1），磁盘占用上限约 2 × maxBytes，不做 N 份。

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{file?: string, maxBytes?: number, rotateTo?: string}} opts
 * @returns {(row: object) => void}
 */
export function createFloorLog({ file, maxBytes = 8 * 1024 * 1024, rotateTo } = {}) {
  if (!file) return () => {};
  const backup = rotateTo || `${file}.1`;
  return function record(row) {
    if (!row || typeof row !== 'object') return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        const st = fs.statSync(file);
        if (st.size > maxBytes) {
          try { fs.rmSync(backup, { force: true }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'floor-log.mjs:30'); }
          fs.renameSync(file, backup);
        }
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'floor-log.mjs:33'); }
      fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'floor-log.mjs:35'); }
  };
}
