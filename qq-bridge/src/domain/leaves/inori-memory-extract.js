// inori-memory-extract.js · 用本地 3B 把对话抽成结构化记忆（确定性触发，不依赖她自觉）
//
// 为什么要有它：记忆写入一直靠她主动 memory_save，群聊里没人写就永远没有事实；
// 云端抽取（group-facts-llm）每小时一轮、花 token。这里用本机 3B 做同一件事：
// 规则决定"什么时候抽"（每 N 条 / 每条群 digest 后 / 间隔够久），模型只负责"抽成哪几句"。
//
// 纪律：
//  - 纯函数可单测（提示词、解析、去重、该不该跑）；
//  - 解析不出来就返回 []，绝不编造；
//  - 写入前和现有记忆做相似度去重（bigram 覆盖），重复的不重复写；
//  - 模型不可用时静默跳过（调用方负责降级），不阻塞任何回合。
import { bigramCoverage } from '../memory/memory-retrieve.js';

export const DEFAULT_EXTRACT = {
  enabled: true,
  minGapMs: 30 * 60 * 1000,
  minMessages: 6,
  maxFacts: 3,
  maxChars: 90,
  simThreshold: 0.82,
};

/** 该不该跑一轮抽取（纯函数，便于测试） */
export function shouldExtract({ now = Date.now(), lastAt = 0, pendingCount = 0, minGapMs = DEFAULT_EXTRACT.minGapMs, minMessages = DEFAULT_EXTRACT.minMessages } = {}) {
  if (Number(pendingCount) < Math.max(1, Number(minMessages) || 1)) return false;
  const gap = Math.max(0, Number(minGapMs) || 0);
  const last = Number(lastAt) || 0;
  if (!last) return true;
  return now - last >= gap;
}

/** 从最近消息里拼抽取提示词：保留谁说的，避免"他/她"指代丢失 */
export function buildExtractPrompt(messages, { max = DEFAULT_EXTRACT.maxFacts, maxChars = DEFAULT_EXTRACT.maxChars } = {}) {
  const lines = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && String(m.text ?? '').trim())
    .slice(-16)
    .map((m) => `${m.isSelf ? '我' : (String(m.who || m.name || '对方'))}：${String(m.text).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  if (!lines.length) return '';
  return [
    '记下聊天里的具体事实（谁要做什么、喜欢什么、有什么东西）。',
    `最多 ${max} 条；每条不超过 ${maxChars} 字；写成完整短句，像 "他下周三要去拔智齿" 这样。`,
    '只输出 JSON 字符串数组；没有事实就输出 []。',
    '',
    ...lines,
  ].join('\n');
}

/** 解析模型输出：容忍代码块/前后废话；不合格的条目直接丢弃 */
export function parseFactArray(raw, { max = DEFAULT_EXTRACT.maxFacts, maxChars = DEFAULT_EXTRACT.maxChars } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const m = text.match(/\[[\s\S]*?\]/);
  let arr = null;
  if (m) {
    try { arr = JSON.parse(m[0]); } catch { arr = null; }
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const s = item.replace(/^\s*[-*\d.、]+\s*/, '').replace(/\s+/g, ' ').trim();
    if (s.length < 6 || s.length > Math.max(10, maxChars)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= Math.max(1, max)) break;
  }
  return out;
}

/**
 * 和现有记忆去重：完全相同的丢弃，字面相似度 ≥ threshold 的也丢弃
 * （3B 常把同一件事换个说法再抽一遍）。
 */
export function dedupeCandidates(candidates, existingTexts, { threshold = DEFAULT_EXTRACT.simThreshold } = {}) {
  const existing = (Array.isArray(existingTexts) ? existingTexts : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const out = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (existing.includes(s)) continue;
    if (existing.some((t) => bigramCoverage(s, t) >= threshold || bigramCoverage(t, s) >= threshold)) continue;
    if (out.some((t) => bigramCoverage(s, t) >= threshold)) continue;
    out.push(s);
  }
  return out;
}

/**
 * 跑一轮：构建提示词 → 调模型 → 解析 → 去重。
 * @param {{messages:Array, existingTexts:Array, complete:(prompt:string)=>Promise<string|null>, max?:number}} deps
 */
export async function extractFacts({ messages, existingTexts = [], complete, max = DEFAULT_EXTRACT.maxFacts, maxChars = DEFAULT_EXTRACT.maxChars } = {}) {
  const prompt = buildExtractPrompt(messages, { max, maxChars });
  if (!prompt) return { prompt: '', facts: [], raw: '' };
  const raw = typeof complete === 'function' ? await complete(prompt) : null;
  const parsed = parseFactArray(raw, { max, maxChars });
  const facts = dedupeCandidates(parsed, existingTexts);
  return { prompt, facts, raw };
}
