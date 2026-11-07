// wake-judge.mjs · 用本地 3B（local-judge）判断一条消息是否"关于她 / 想让她回"
//
// 为什么存在：reserved2 的唤醒决策在 turn-taking.js 的 shouldWake 里是 Math.random() 掷骰，
// 只在"强指向"（@/名字/aboutSelf/提问）时确定性唤醒；其余弱指向消息（"大家觉得呢"、
// "你怎么看"这种没点名但其实是问她的）规则判不出 → 掷骰决定，于是"自主决策"名不副实。
//
// 这里把 local-judge 的 judgeByModel 复用起来：它返回的 target 字段（你/别人/自己/无）
// 正是"是否关于她"的信号。命中"你"且置信够高 → 确定性唤醒；命中"别人/无/自己"且够高
// → 静默；置信不足或本地 3B 不可用 → 返回 null，调用方回退到原保守概率。
//
// 设计纪律：
//   · 纯函数 mapJudgeToWake 可单测；classifyWakeIntent 是唯一 IO 点（本地 3B，带超时）。
//   · 模型不可用 / 判读失败一律返回 null（回退），绝不抛错阻断唤醒。
//   · 同一条文本短时缓存，避免反复判读（群聊同一句可能触发多次）。
import { judgeByModel } from '../memory/local-judge.js';
import { local3bBase } from '../memory/local-3b.js';

const cache = new Map(); // text -> { at, result }
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 把 local-judge 的判定映射成唤醒决策信号（纯函数）。 */
export function mapJudgeToWake(judged) {
  if (!judged || typeof judged !== 'object') return null;
  const target = String(judged.target || '');
  const conf = Number(judged.confidence);
  if (!Number.isFinite(conf)) return null;
  return { aboutHer: target === '你', target, confidence: conf, available: true };
}

/**
 * 判定一条消息是否关于她。
 * @param {string} text
 * @param {{cfg?:object, log?:(m:string)=>void}} [opts]
 * @returns {Promise<{aboutHer:boolean,target:string,confidence:number,available:boolean}|null>}
 *   null = 不可用 / 未启用 / 文本过短 / 调用失败（调用方回退概率）。
 */
export async function classifyWakeIntent(text, { cfg, log = () => {} } = {}) {
  if (cfg?.floor?.judgeWake === false) return null;
  const t = String(text || '').trim();
  if (t.length < 2) return null;
  const key = t.slice(0, 200);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
  let result = null;
  try {
    const baseUrl = local3bBase(cfg);
    const judged = await judgeByModel({ baseUrl, text: t, timeoutMs: 12000, log });
    result = mapJudgeToWake(judged);
  } catch (error) {
    log(`[wake-judge] 调用失败（回退概率）: ${error?.message ?? error}`);
    result = null;
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** 仅用于测试：清空内部缓存 */
export function _clearWakeJudgeCache() { cache.clear(); }
