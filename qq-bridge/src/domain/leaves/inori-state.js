// inori-state.js · 她自己的状态（温度 / 精力），借鉴 mizuse 的 1a 温度惯性 + 1b 短即冷
//
// 设计约束（都来自 mizuse 的踩坑）：
//   1) **有界**：所有值恒在 [0,1]，不出现「情绪失控」式自激
//   2) **有惯性**：不是每轮重置，随时间向基线衰减（1a），半衰期可测
//   3) **短即冷**：她回得越短，温度越低（1b）；回长句/接住话题会回一点
//   4) **可关**：enabled=false 时 summary() 返回空串、不落盘
//   5) **可复现**：state 落盘为 JSON，读回一致；tick 只依赖 (state, now)，不依赖随机
//   6) 本模块**不知道 QQ 这回事**，只是「状态」；谁调用它、注入到哪，由上层决定
//
// 2026-10-29 两处改法（对着权威项目的做法改的，见 plans/2026-10-29T*）：
//   · 增量改成**向端点收缩**（+= (1-x)·k / -= x·k）：越接近 0/1 走得越慢，不再顶死；
//   · 加 **perKey**（对某个会话的温度）：她的温度不再是一个全局值，
//     `stateWithKey(state, key)` 合成「体质全局 45% + 对这个会话 55%」给上层用。
//
// 落盘：data/state/inori_state.json
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath } from '../shared/project-paths.js';

const DEFAULT_PATH = stateDataPath('inori_state.json');
const BASELINE = { warmth: 0.5, energy: 0.6 };
const HALF_LIFE_MS = 2 * 3600 * 1000;        // 全局温度/精力：2 小时后向基线走完一半
const PERKEY_HALF_LIFE_MS = 6 * 3600 * 1000; // 对某个人的态度更黏：6 小时半衰
const SHORT_REPLY_CHARS = 6;                 // ≤6 字算「短」（取自本尊语料 58.2% 的阈值）
const MAX_PERKEY = 20;                       // 最多记 20 个会话的态度，按最近互动淘汰

// 旧测试/外部脚本读 CONSTS.BASELINE；导出只读快照，避免为了一个常量再复制一份。
export const CONSTS = Object.freeze({ BASELINE, HALF_LIFE_MS, PERKEY_HALF_LIFE_MS, SHORT_REPLY_CHARS, MAX_PERKEY });

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function normalizePerKey(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!k || !v || typeof v !== 'object') continue;
    out[String(k)] = { warmth: clamp01(Number(v.warmth ?? BASELINE.warmth)), at: Number(v.at ?? 0) };
  }
  return out;
}

function prunePerKey(perKey) {
  const entries = Object.entries(perKey);
  if (entries.length <= MAX_PERKEY) return perKey;
  const keep = entries.sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0)).slice(0, MAX_PERKEY);
  return Object.fromEntries(keep);
}

export function loadState(file = DEFAULT_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      enabled: j.enabled !== false,
      warmth: clamp01(Number(j.warmth ?? BASELINE.warmth)),
      energy: clamp01(Number(j.energy ?? BASELINE.energy)),
      at: Number(j.at ?? Date.now()),
      replies: Number(j.replies ?? 0),
      shortStreak: Number(j.shortStreak ?? 0),
      longStreak: Number(j.longStreak ?? 0),
      lastTalkAt: Number(j.lastTalkAt ?? 0),
      perKey: prunePerKey(normalizePerKey(j.perKey)),
    };
  } catch {
    return {
      enabled: true, warmth: BASELINE.warmth, energy: BASELINE.energy, at: Date.now(),
      replies: 0, shortStreak: 0, longStreak: 0, lastTalkAt: 0, perKey: {},
    };
  }
}

export function saveState(state, file = DEFAULT_PATH) {
  if (state.enabled === false) return;
  // 原子写（tmp+rename）：崩溃不留半截 JSON
  const r = writeJsonDocument(file, state, { source: 'bridge/inori-state' });
  if (!r.ok) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8'); } catch (error) { console.error(`[state] 保存失败: ${file}｜${error?.message ?? error}`); }
  }
}

/** 纯函数：把状态从它自己的 at 推进到 now —— 向基线指数衰减（1a 温度惯性） */
export function tick(state, now = Date.now()) {
  const dt = Math.max(0, now - state.at);
  if (!state.perKey || typeof state.perKey !== 'object') state.perKey = {};
  if (dt > 0) {
    const k = Math.pow(0.5, dt / HALF_LIFE_MS); // 剩余差距保留比例
    state.warmth = clamp01(BASELINE.warmth + (state.warmth - BASELINE.warmth) * k);
    state.energy = clamp01(BASELINE.energy + (state.energy - BASELINE.energy) * k);
    const pk = Math.pow(0.5, dt / PERKEY_HALF_LIFE_MS);
    for (const [key, row] of Object.entries(state.perKey)) {
      if (!row || typeof row !== 'object') { delete state.perKey[key]; continue; }
      row.warmth = clamp01(BASELINE.warmth + (Number(row.warmth ?? BASELINE.warmth) - BASELINE.warmth) * pk);
    }
    state.at = now;
  }
  state.perKey = prunePerKey(state.perKey);
  return state;
}

/** 对某个会话的温度：体质（全局）45% + 对这个会话 55%；没记录过就用全局值 */
export function effectiveWarmth(state, key = '') {
  const k = String(key || '');
  const row = k && state.perKey ? state.perKey[k] : null;
  const w = Number(state.warmth ?? BASELINE.warmth);
  if (!row || !Number.isFinite(Number(row.warmth))) return clamp01(w);
  return clamp01(w * 0.45 + Number(row.warmth) * 0.55);
}

/** 给上层用的「这个会话里的她」：warmth 已按 key 合成，其它字段不变（浅拷贝，不改原 state） */
export function stateWithKey(state, key = '') {
  return { ...state, warmth: effectiveWarmth(state, key) };
}

/** 她发出一条回复后调用：短即冷（1b）；长回复消耗精力但轻微回暖（增量向端点收缩，不顶死） */
export function noteReply(state, text, now = Date.now(), key = '') {
  tick(state, now);
  const len = [...String(text ?? '')].length;
  state.replies += 1;
  const k = String(key || '');
  let pk = null;
  if (k) {
    if (!state.perKey || typeof state.perKey !== 'object') state.perKey = {};
    if (!state.perKey[k]) state.perKey[k] = { warmth: Number(state.warmth ?? BASELINE.warmth), at: now };
    pk = state.perKey[k];
    pk.at = now;
  }
  if (len <= SHORT_REPLY_CHARS) {
    state.shortStreak += 1;
    state.longStreak = 0;
    // 连短才明显冷：第 1 条 3%、连续第 3 条 9%（乘当前值 → 越冷越难再冷，不会归零）
    const loss = 0.03 * Math.min(3, state.shortStreak);
    state.warmth = clamp01(state.warmth - state.warmth * loss);
    if (pk) pk.warmth = clamp01(pk.warmth - pk.warmth * (loss * 1.6));
  } else {
    state.shortStreak = 0;
    state.longStreak += 1;
    // 回暖按 (1-当前) 比例 → 0.9 时只回一点点，接不到 1.00
    const gain = 0.02 * Math.min(3, state.longStreak);
    state.warmth = clamp01(state.warmth + (1 - state.warmth) * gain);
    if (pk) pk.warmth = clamp01(pk.warmth + (1 - pk.warmth) * (gain * 1.5));
    state.energy = clamp01(state.energy - 0.01 * Math.min(5, len / 20));
  }
  state.perKey = prunePerKey(state.perKey);
  return state;
}

/** 给模型看的一句话摘要；enabled=false 时返回空串。key 给了就用「对这个会话的温度」 */
/** 温度/精力 → 发言节奏（旧接口；只看方向，不参与硬权限）。 */
export function pacingMultiplier(state = {}) {
  const warmth = Math.max(0, Math.min(1, Number(state.warmth ?? BASELINE.warmth)));
  const energy = Math.max(0, Math.min(1, Number(state.energy ?? BASELINE.energy)));
  return {
    maxBurst: Math.max(1, Math.round(1 + warmth * 2)),
    gapScale: Number((1.4 - warmth * 0.6 - (energy - 0.5) * 0.2).toFixed(2)),
  };
}

export function summary(state, now = Date.now(), key = '') {
  if (state.enabled === false) return '';
  tick(state, now);
  const wv = effectiveWarmth(state, key);
  const w = wv < 0.4 ? '偏冷' : wv > 0.65 ? '偏暖' : '平';
  const e = state.energy < 0.4 ? '有点累' : state.energy > 0.65 ? '有精神' : '一般';
  const mins = Math.round((now - (state.lastTalkAt ?? state.at)) / 60000);
  const gap = mins >= 1 ? `距上次说话 ${mins} 分钟` : '刚说完话';
  return `现在的你：温度 ${wv.toFixed(2)}（${w}），精力 ${state.energy.toFixed(2)}（${e}）；${gap}。`;
}

/** 按状态影响发送节奏：temper 越低，越少分条、越慢开口 */
