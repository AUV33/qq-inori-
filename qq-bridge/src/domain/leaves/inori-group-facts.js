import fs from 'node:fs';
import { dataPath } from '../shared/project-paths.js';
// inori-group-facts.js · 群话题萃取（零 LLM、确定性）：从近 24h 群摘要里提「常聊的具体词」
// 为什么：群记忆 90% 是 group-digest 原料，具体话题（显卡/生日/插件）被摘要稀释；
// 提一层「近 24h 常聊：X、Y」作为 group-fact 条目，检索时才有更细的钉子可钉。

const STOP = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '什么', '怎么', '为什么',
  '就是', '没有', '可以', '不是', '现在', '还是', '已经', '自己', '知道', '觉得', '然后',
  '因为', '所以', '但是', '而且', '今天', '昨天', '明天', '时候', '群里', '群聊', '真的',
  '看到', '一个', '一下', '一点', '这样', '那样', '不是', '还有', '以及', '如果', '虽然',
  '哈哈', '哈哈哈', '呵呵', '嗯嗯', '哦哦', '啊啊', '好的', '行吧', '没事', '有点', '感觉',
  '东西', '事情', '问题', '地方', '时间', '大家', '别人', '有人', '这里', '那里', '上面', '下面',
]);

const ZH = /^[\u4e00-\u9fa5]+$/;
// [TOPIC-VOCAB] 用 jieba 词典当词表：只保留真实成词的 n-gram，砍掉「友暴政世」这类跨词边界垃圾。
const VOCAB_FILE = dataPath('jieba-dict.txt');
let VOCAB = null;
function loadVocab() {
  if (VOCAB) return VOCAB;
  try {
    const lines = fs.readFileSync(VOCAB_FILE, 'utf8').split(/\r?\n/);
    const set = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const w = parts[0]; const f = Number(parts[1]) || 0;
      if (w.length < 2 || w.length > 4) continue;
      if (f < 5) continue;
      set.add(w);
    }
    VOCAB = set;
  } catch { VOCAB = new Set(); }
  return VOCAB;
}
// 含这些字的大多是跨词边界拼出来的垃圾（群/在/了/的/我/你/他...）
const STOP_CHARS = '的了是我你他她它在和就也都不会有会说要吗啊吧呢个这那群把被给让对从到为以于';
const hasStopChar = (term) => [...term].some((ch) => STOP_CHARS.includes(ch));

/** 提取在 >= minDf 条摘要里都出现的 2~4 字中文词（按 出现条数×词长 排）。 */
export function extractTopics(texts, { limit = 8, minDf = 2, maxLen = 4 } = {}) {
  const clean = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/群里在聊\s*[:：]?/g, ' ').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ').replace(/\s+/g, ' '))
    .filter(Boolean);
  const df = new Map();
  for (const t of clean) {
    const s = t.replace(/\s+/g, '');
    const seen = new Set();
    for (let n = 2; n <= maxLen; n += 1) {
      for (let i = 0; i + n <= s.length; i += 1) {
        const term = s.slice(i, i + n);
        if (!ZH.test(term)) continue;
        if (STOP.has(term)) continue;
        if (/^(.)\1+$/.test(term)) continue;
        if (hasStopChar(term)) continue;
        if (!loadVocab().has(term)) continue;
        seen.add(term);
      }
    }
    for (const x of seen) df.set(x, (df.get(x) || 0) + 1);
  }
  return [...df]
    .filter(([term, c]) => c >= Math.max(1, minDf) && !STOP.has(term))
    // 同一批词里去掉被更长词包含的短词（显卡 vs 新显卡）
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .filter(([term], i, arr) => !arr.some(([other, c2], j) => j !== i && other.length > term.length && c2 >= arr[i][1] && other.includes(term)))
    .map(([term, c]) => ({ term, df: c, score: c * Math.min(term.length, 3) }))
    .sort((a, b) => b.score - a.score || b.term.length - a.term.length)
    .slice(0, Math.max(1, limit))
    .map((x) => x.term);
}

/** 生成一条可写入群库的话题认知条目文本（没有足够话题就返回空串）。 */
export function renderGroupTopics(topics, { min = 3 } = {}) {
  const list = (Array.isArray(topics) ? topics : []).filter(Boolean);
  if (list.length < min) return '';
  return `近 24h 群里常聊：${list.join('、')}`;
}

/** 从模型输出里抠 JSON 字符串数组：去掉解释/代码块，只留 6~100 字的条目。 */
export function parseFactsJson(text, { max = 5 } = {}) {
  try {
    const s = String(text ?? '');
    const m = s.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      if (typeof x !== 'string') continue;
      const v = x.replace(/\s+/g, ' ').trim();
      if (v.length < 6 || v.length > 100) continue;
      if (out.includes(v)) continue;
      out.push(v);
      if (out.length >= Math.max(1, max)) break;
    }
    return out;
  } catch { return []; }
}
