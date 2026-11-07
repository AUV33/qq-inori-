// style-baseline.mjs · 宪章 A1/G10：她自己的文风基线 + 漂移步长（≤5%）
//
// 干什么：从她历史发出的 utterance 里算风格指纹（复用 living-eval），存基线；
//   比较当前与基线的漂移；给“单次漂移 ≤5%”的步长计划（不直接改任何人格参数）。
// 为什么：没有基线，风格漂移只能靠感觉；没有步长，一次改太多等于人格突变。
// 输入输出：纯函数 + 文件读取由脚本负责；不调模型、不写人格。
// 失败模式：样本不足返回 null/samples 0；坏行跳过。
// 不做什么：不自动应用漂移、不覆盖手写人格；diff 只给 owner/她审阅。

import { styleFingerprint, styleDrift } from './living-eval.mjs';

export const STYLE_BASELINE_VERSION = 1;
export const MIN_SAMPLES = 10;
export const MAX_STEP = 0.05;

/** 从 JSONL 行对象里收她自己的话（kind=utterance，有 text）。 */
export function collectUtterances(rows, { now = Date.now(), days = 90 } = {}) {
  const cutoff = Number(now) - Number(days) * 86400000;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.kind !== 'utterance') continue;
    const text = String(row.text ?? '').trim();
    if (!text) continue;
    const at = Number(row.time ?? row.recordedAt ?? row.at) || 0;
    if (at && at < cutoff) continue;
    out.push(text);
  }
  return out;
}

export function buildStyleBaseline(texts, { now = Date.now(), source = 'utterance' } = {}) {
  const list = (Array.isArray(texts) ? texts : []).filter((t) => String(t ?? '').trim());
  if (list.length < MIN_SAMPLES) return { v: STYLE_BASELINE_VERSION, at: Number(now), source, samples: list.length, insufficient: true, metrics: styleFingerprint(list) };
  return { v: STYLE_BASELINE_VERSION, at: Number(now), source, samples: list.length, insufficient: false, metrics: styleFingerprint(list) };
}

/**
 * 单次漂移计划：每个指标最多移动 maxStep（相对），返回 next 与每项实际步长。
 * 不写盘；只是“如果要靠近 current，下一步最多走到哪”。
 */
export function planStyleStep(baseline, current, { maxStep = MAX_STEP } = {}) {
  const base = baseline?.metrics || baseline || {};
  const cur = current?.metrics || current || {};
  const keys = ['avgChars', 'emojiRate', 'questionRate', 'exclaimRate', 'firstPersonRate', 'cjkRate'];
  const next = { ...base };
  const steps = {};
  for (const key of keys) {
    const b = Number(base[key]);
    const c = Number(cur[key]);
    if (!Number.isFinite(b) || !Number.isFinite(c)) continue;
    const denom = Math.max(1, Math.abs(b));
    const delta = (c - b) / denom;
    const step = Math.max(-maxStep, Math.min(maxStep, delta));
    // 零基线没有“相对 5%”：用 5 个百分点作为绝对上限，避免 0 永远动不了。
    next[key] = b === 0
      ? Math.round((Math.sign(c) * maxStep) * 1000) / 1000
      : Math.round((b * (1 + step)) * 1000) / 1000;
    steps[key] = { from: b, to: next[key], target: c, step: Math.round(step * 1000) / 1000 };
  }
  return { v: STYLE_BASELINE_VERSION, maxStep, next, steps, drift: styleDrift(base, cur) };
}
