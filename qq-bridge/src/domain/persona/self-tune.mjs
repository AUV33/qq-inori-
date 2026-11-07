// self-tune.mjs · 她调自己行为参数的唯一通道（2026-10-28）
//
// 为什么要有它：审计结论是「她有能力改代码，但没有一条能验证的自我调整通路」。
// owner 拍板「只要不崩溃且合理，她想干什么都行」——于是给她一条**参数**通道：
//   · 只能改白名单里的参数，每项有硬边界（写不进去 = 不会崩）；
//   · 写入原子化（tmp+rename）+ 保留上一版 .bak + 每次改动记 tuning.jsonl；
//   · 运行时热生效：下一次 floor 判定就读到新值，不需要重启。
//
// 这不是「代码自改」通道：她不能借它跑命令、改路径、碰白名单外的键。
// 边界值刻意留得宽（minReply 0.05–0.60、holdScale 0.5–2）——她想怎么调都行，只要还在这个区间。

import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

export const TUNE_PARAMS = Object.freeze({
  'floor.minReply': {
    type: 'number', min: 0.05, max: 0.6,
    describe: '低于这个就这轮不开口（0.05 几乎都说，0.60 很挑）',
  },
  'floor.adaptive': {
    type: 'boolean',
    describe: '是否让系统按「被接住率」自动微调阈值（关掉就只听你自己的）',
  },
  'floor.holdScale': {
    type: 'number', min: 0.5, max: 2,
    describe: '开口前停顿的倍数（0.5 更急，2 更慢）',
  },
  // [PROMPT-TIER] 提示词的"装饰层"（兴趣/黑话/失败/奇遇/语域…）至少留多少字。
  // 以前写死 7600 上限、而基础层实测已 10.6k，结果是装饰块每轮全被裁光——这个旋钮给你自己定：
  // 0 = 全裁（只要事实），2000 = 尽量都留。改完下一次唤醒生效，不用重启。
  'prompt.decoFloor': {
    type: 'number', min: 0, max: 2000,
    describe: '提示词装饰层至少留多少字（0=全裁，2000=尽量都留）',
  },
});

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** 单个参数是否合法；返回 {ok, value} 或 {ok:false, error}。 */
export function validateUpdate(name, value) {
  const spec = TUNE_PARAMS[name];
  if (!spec) return { ok: false, error: `不认识的参数：${name}（可调：${Object.keys(TUNE_PARAMS).join(', ')}）` };
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `${name} 需要 true/false` };
    return { ok: true, value };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false, error: `${name} 需要数字` };
  if (n < spec.min || n > spec.max) return { ok: false, error: `${name} 超出范围 ${spec.min}–${spec.max}（收到 ${n}）` };
  return { ok: true, value: n };
}

/** 读当前 tuning（坏文件/越界值一律忽略，回落默认）。 */
export function readTuningFile(file) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-tune.mjs:49'); }
  const src = raw && typeof raw === 'object' ? raw.params ?? {} : {};
  const params = {};
  for (const [name, value] of Object.entries(src)) {
    const v = validateUpdate(name, value);
    if (v.ok) params[name] = v.value;
  }
  return { params, updatedAt: raw?.updatedAt ?? null, by: raw?.by ?? null };
}

/**
 * 校验并写入一次调整。任何一项不合法 → 整批拒绝（不做半套）。
 * @returns {{ok:true, next:object, applied:object}|{ok:false, error:string}}
 */
export function applyTuning(current, updates, { by = 'her', reason = '', file, logFile, now = new Date() } = {}) {
  if (!updates || typeof updates !== 'object' || !Object.keys(updates).length) {
    return { ok: false, error: 'updates 不能为空（形如 {"floor.minReply": 0.3}）' };
  }
  const base = current && typeof current === 'object' ? current.params ?? {} : {};
  const next = { ...base };
  const applied = {};
  for (const [name, value] of Object.entries(updates)) {
    const v = validateUpdate(name, value);
    if (!v.ok) return { ok: false, error: v.error };
    next[name] = v.value;
    applied[name] = v.value;
  }
  const document = { version: 1, updatedAt: now.toISOString(), by, reason: String(reason || ''), params: next };
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf8');
      try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-tune.mjs:82'); }
      renameWithRetry(tmp, file);
    } catch (error) {
      return { ok: false, error: `写入失败：${error?.message ?? error}` };
    }
  }
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({ at: document.updatedAt, by, reason: document.reason, applied, next }) + '\n', 'utf8');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'self-tune.mjs:92'); }
  }
  return { ok: true, next: document, applied };
}

/**
 * 运行时读取器：按 mtime 缓存，避免每次 floor 判定都读盘。
 * 返回扁平 params 对象（如 {'floor.minReply': 0.3}）；文件不存在时返回空对象。
 */
export function createTuningReader(file) {
  let cachedMtime = -1;
  let cached = {};
  return function readTuning() {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== cachedMtime) {
        cachedMtime = st.mtimeMs;
        cached = readTuningFile(file).params;
      }
      return cached;
    } catch {
      cachedMtime = -1;
      cached = {};
      return cached;
    }
  };
}
