// inori-emotion-vector.js · 她的「多情绪底色」持久层（可衰减、按会话隔离）
//
// 为什么单独一层：
//   inori-affect 判「对方此刻像什么」，inori-self-emotion 判「这件事落到她身上她什么感觉」；
//   两者此前都是瞬时/会话态，关掉页面就没了。本模块把六个维度落成可衰减的底色：
//     joy 开心 / sadness 低落 / anger 烦躁 / fear 不安 / affection 亲近 / curiosity 好奇
//
// 纪律：
//   · 所有值 [0,1]，半衰期 6h，不做自激；
//   · 每次只加一小步（0.03~0.2，按置信度），不把一句话变成情绪结论；
//   · 只记「情绪底色」，不记病名、不替代 inori-affect 的假设；
//   · 按会话 key 隔离，最多保留 30 个最近会话；
//   · 读盘失败/坏文件一律回空态，绝不让情绪层炸掉唤醒。
import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../shared/project-paths.js';

export const EMOTION_DIMENSIONS = Object.freeze([
  'joy', 'sadness', 'anger', 'fear', 'affection', 'curiosity',
]);
export const EMOTION_LABELS = Object.freeze({
  joy: '开心', sadness: '低落', anger: '烦躁', fear: '不安', affection: '亲近', curiosity: '好奇',
});
export const EMOTION_VECTOR_FILE = stateDataPath('emotion-vector.json');
export const SELF_EMOTION_FILE = stateDataPath('self-emotion.jsonl');
const HALF_LIFE_MS = 6 * 3600 * 1000;
const MAX_KEYS = 30;
const VERSION = 1;

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
function text(v) { return String(v ?? '').trim(); }

function emptyKey(now = Date.now()) {
  const k = { at: now };
  for (const d of EMOTION_DIMENSIONS) k[d] = 0;
  return k;
}

/** 读取；坏文件/不存在都回空态。 */
export function loadEmotionVector(file = EMOTION_VECTOR_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = {};
    for (const [key, row] of Object.entries(j?.keys ?? {})) {
      if (!row || typeof row !== 'object') continue;
      const k = emptyKey(Number(row.at) || Date.now());
      for (const d of EMOTION_DIMENSIONS) k[d] = clamp01(row[d]);
      keys[String(key)] = k;
    }
    return { version: VERSION, updatedAt: Number(j?.updatedAt) || 0, keys };
  } catch {
    return { version: VERSION, updatedAt: 0, keys: {} };
  }
}

/** 原子写：tmp + rename；失败只返回 false，不抛。 */
export function saveEmotionVector(state, file = EMOTION_VECTOR_FILE) {
  try {
    const out = { version: VERSION, updatedAt: Date.now(), keys: state?.keys ?? {} };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** 按半衰期衰减 + 淘汰太久没动的 key；返回同一个对象（便于链式）。 */
export function decayEmotionVector(state, now = Date.now()) {
  const keys = state?.keys ?? {};
  const entries = Object.entries(keys)
    .map(([key, row]) => [key, row, Number(row?.at) || 0])
    .sort((a, b) => b[2] - a[2]);
  for (const [key, row] of entries.slice(MAX_KEYS)) delete keys[key];
  for (const row of Object.values(keys)) {
    const dt = Math.max(0, now - (Number(row?.at) || now));
    const factor = Math.pow(0.5, dt / HALF_LIFE_MS);
    for (const d of EMOTION_DIMENSIONS) row[d] = clamp01((Number(row?.[d]) || 0) * factor);
    row.at = now;
  }
  return state;
}

export function emotionVectorFor(state, key, now = Date.now()) {
  if (!state.keys) state.keys = {};
  // 先衰减/淘汰，再补当前 key：否则第 31 个新 key 的 at 和旧 key 一样新，
  // 在淘汰排序里可能被当成最旧删掉，返回 undefined。
  decayEmotionVector(state, now);
  if (!state.keys[key]) state.keys[key] = emptyKey(now);
  pruneKeys(state.keys, key);
  return state.keys[key];
}

function pruneKeys(keys, keepKey = null) {
  const entries = Object.entries(keys).sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0));
  for (const [key] of entries) {
    if (Object.keys(keys).length <= MAX_KEYS) break;
    if (key === keepKey) continue;
    delete keys[key];
  }
}

/** 对方的情绪判读 → 底色小步更新。affect 用 inori-affect 的中文标签，允许未知。 */
export function observeOtherAffect(state, key, { affect = '未知', confidence = 0.5, valence = 0, now = Date.now() } = {}) {
  const row = emotionVectorFor(state, key, now);
  const a = text(affect);
  const w = 0.03 + 0.17 * clamp01(confidence);
  const add = (d, amount) => { row[d] = clamp01((Number(row[d]) || 0) + amount); };
  if (/试探|不安|确认|怀疑/.test(a)) { add('curiosity', w); add('fear', w * 0.6); }
  if (/烦躁|带火|生气|发火|愤怒/.test(a)) add('anger', w);
  if (/倾诉|低落|难受|不舒服|失望|委屈|内疚/.test(a)) add('sadness', w);
  if (/玩笑|放松|在玩|开心|心情不错/.test(a)) add('joy', w);
  if (/亲近|暖|靠近/.test(a)) add('affection', w);
  if (Number(valence) > 0.15) add('joy', w * 0.4);
  if (Number(valence) < -0.15) add('sadness', w * 0.4);
  row.at = now;
  return row;
}

/** 她自己的感受 → 底色更新。selfEmotion.label 用 inori-self-emotion 的英文标签。 */
export function observeSelfEmotion(state, key, selfEmotion = {}, { now = Date.now() } = {}) {
  const row = emotionVectorFor(state, key, now);
  const label = text(selfEmotion.label || 'neutral');
  const w = 0.05 + 0.18 * clamp01(selfEmotion.confidence ?? 0.4);
  const add = (d, amount) => { row[d] = clamp01((Number(row[d]) || 0) + amount); };
  if (label === 'warm' || label === 'amused') add('joy', w);
  if (label === 'warm') add('affection', w * 0.6);
  if (label === 'stung') { add('anger', w * 0.7); add('sadness', w * 0.4); }
  if (label === 'guarded') { add('fear', w * 0.8); add('curiosity', w * 0.2); }
  if (label === 'concerned') { add('sadness', w * 0.7); add('affection', w * 0.3); }
  if (label === 'tired') add('sadness', w * 0.5);
  if (label === 'focused') add('curiosity', w * 0.3);
  row.at = now;
  return row;
}

/** 给 floor 的微小偏置：正向底色 +，负向底色 −；最大 ±0.08，不压过 warmth/energy。 */
export function emotionBias(state, key, now = Date.now()) {
  const row = emotionVectorFor(state, key, now);
  const pos = (row.joy + row.affection) / 2;
  const neg = (row.anger + row.sadness + row.fear) / 3;
  const delta = Math.max(-0.08, Math.min(0.08, (pos - neg) * 0.12));
  return { delta: Number(delta.toFixed(3)), positive: Number(pos.toFixed(3)), negative: Number(neg.toFixed(3)) };
}

/** 渲染成一小段背景；全低于 0.15 时返回空串（不占 prompt）。 */
export function renderEmotionVector(state, key, { now = Date.now(), maxChars = 180 } = {}) {
  const row = emotionVectorFor(state, key, now);
  const ranked = EMOTION_DIMENSIONS
    .map((d) => ({ d, v: Number(row[d]) || 0 }))
    .filter((x) => x.v >= 0.15)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  if (!ranked.length) return '';
  const body = ranked.map((x) => `${EMOTION_LABELS[x.d]} ${x.v.toFixed(2)}`).join(' / ');
  const line = `【情绪底色】${body}（近 6 小时，会自然衰减；只是背景，不是结论）`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

/** 记录一次「她的感受」到 JSONL，供反思/自我模型回读；失败静默。 */
export function recordSelfEmotion({ key, selfEmotion = {}, empathy = null, now = Date.now(), file = SELF_EMOTION_FILE } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = {
      at: new Date(now).toISOString(),
      key: String(key || ''),
      label: text(selfEmotion.label || 'neutral'),
      valence: Number(selfEmotion.valence) || 0,
      arousal: Number(selfEmotion.arousal) || 0,
      confidence: Number(selfEmotion.confidence) || 0,
      reason: text(selfEmotion.reason || '').slice(0, 200),
      evidence: Array.isArray(selfEmotion.evidence) ? selfEmotion.evidence.slice(0, 3) : [],
      empathy: empathy ? {
        understanding: text(empathy.understanding).slice(0, 120),
        compassion: text(empathy.compassion).slice(0, 120),
        boundary: text(empathy.boundary).slice(0, 160),
      } : null,
    };
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch { return false; }
}
