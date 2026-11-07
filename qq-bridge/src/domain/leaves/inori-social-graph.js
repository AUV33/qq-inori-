// inori-social-graph.js · 他人 ↔ 他人 关系图谱（确定性统计，零 LLM）
//
// 她要能总结「群里谁跟谁常来常往」，光靠每人标签（话多/新人）不够：
// 需要成对的边——谁接谁的话、谁和谁互相搭话。
// 数据：引用回复 → 有向边；连续发言的邻接 → 无向搭话计数。
// 存储：data/state/social-graph.json（按会话 key 分组，每群有上限、按时间衰减）
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';
// [IDENTITY-GRAPH] 边的键用 personId（昵称只做展示）：改名不丢边、共名不误并。
import { personIdFor } from '../social/identity-map.mjs';

export const DEFAULTS = { maxPairs: 300, decayDays: 45, minTotal: 3, topN: 3 };

// 极性词表（确定性、只做粗分；没有命中算中性）
const POS_WORDS = ['哈哈哈', '笑死', '好耶', '谢谢', '厉害', '可爱', '牛逼', '太强了', '赞', '喜欢', '嘿嘿', '摸摸', '爱了'];
const NEG_WORDS = ['笨', '蠢', '菜', '滚', '闭嘴', '傻', '狗', '无语', '？？？', '就这', '拉倒', '不想理', '离谱'];

/** 从文本粗判一句话的极性：pos / neg / neutral */
export function polarityOf(text) {
  const t = String(text ?? '');
  let pos = 0;
  let neg = 0;
  for (const w of POS_WORDS) if (t.includes(w)) pos += 1;
  for (const w of NEG_WORDS) if (t.includes(w)) neg += 1;
  return pos > neg ? 'pos' : neg > pos ? 'neg' : 'neutral';
}

const DAY = 24 * 3600 * 1000;

/** 名字清洗：去掉控制字符/零宽/CQ 码，超长截断；清洗后为空则丢弃 */
export function cleanName(name) {
  let s = String(name ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, '')
    // [CLEAN] JS 对象泄漏（漏 await 的 Promise）清掉；清掉后名字会变，不再参与渲染
    .replace(/\[object \w+\]/gi, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    // [CLEAN] 组合附加符（被拿来伪造昵称）整段去掉
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 40) s = [...s].slice(0, 40).join('');
  return s;
}

function pairKey(a, b) {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export function loadSocialGraph(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && j.groups && typeof j.groups === 'object') return j;
    return { groups: {} };
  } catch { return { groups: {} }; }
}

export function saveSocialGraph(file, graph) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(graph), 'utf8');
    renameWithRetry(tmp, file);
    return true;
  } catch { return false; }
}

/** 记一条边。from→to 有向次数 +1；返回是否有变化 */
function nodeKey(name, id) {
  const raw = String(id ?? '').trim();
  if (/^\d{5,12}$/.test(raw)) return personIdFor('qq', raw);
  return cleanName(name);
}

export function noteEdge(graph, key, from, to, kind = 'reply', at = Date.now(), opts = {}) {
  const aName = cleanName(from);
  const bName = cleanName(to);
  const a = nodeKey(from, opts.fromId);
  const b = nodeKey(to, opts.toId);
  if (!a || !b || a === b) return false;
  // [GRAPH-FIX] 脏名字（Promise 泄漏/占位符）不进图谱
  if (/\[object \w+\]/.test(a) || /\[object \w+\]/.test(b)) return false;
  if (!graph.groups[key]) graph.groups[key] = { pairs: {}, updatedAt: 0 };
  const g = graph.groups[key];
  if (!g.pairs) g.pairs = {};
  const pk = pairKey(a, b);
  const row = g.pairs[pk] || (g.pairs[pk] = { a: a <= b ? a : b, b: a <= b ? b : a, aName: '', bName: '', ab: 0, ba: 0, reply: 0, adjacent: 0, mention: 0, pos: 0, neg: 0, lastAt: 0 });
  // 展示名跟着最近一次事件更新；旧行没有 aName 时保持原行为（a/b 就是名字）。
  if (a === row.a) row.aName = aName || row.aName || ''; else row.bName = aName || row.bName || '';
  if (b === row.b) row.bName = bName || row.bName || ''; else row.aName = bName || row.aName || '';
  const forward = a === row.a;
  if (forward) row.ab += 1; else row.ba += 1;
  if (kind === 'reply') row.reply += 1;
  else if (kind === 'mention') row.mention += 1;
  else row.adjacent += 1;
  const pol = String(opts.polarity || '');
  if (pol === 'pos') row.pos += 1;
  else if (pol === 'neg') row.neg += 1;
  row.lastAt = at;
  g.updatedAt = at;
  pruneGraph(graph, { now: at });
  return true;
}

/** 修剪：超过 maxPairs 的群按 lastAt 留最近；超过 decayDays 的边删除 */
export function pruneGraph(graph, { maxPairs = DEFAULTS.maxPairs, decayDays = DEFAULTS.decayDays, now = Date.now() } = {}) {
  const cutoff = now - decayDays * DAY;
  for (const key of Object.keys(graph.groups || {})) {
    const g = graph.groups[key];
    if (!g || typeof g !== 'object') { delete graph.groups[key]; continue; }
    if (!g.pairs) { g.pairs = {}; continue; }
    for (const [pk, row] of Object.entries(g.pairs)) {
      if (!row || !Number.isFinite(Number(row.lastAt)) || Number(row.lastAt) < cutoff) delete g.pairs[pk];
    }
    const entries = Object.entries(g.pairs);
    if (entries.length > maxPairs) {
      entries.sort((x, y) => Number(y[1].lastAt || 0) - Number(x[1].lastAt || 0));
      g.pairs = {};
      for (const [pk, row] of entries.slice(0, maxPairs)) g.pairs[pk] = row;
    }
  }
  return graph;
}

/** 汇总：最近活跃的前 N 对（默认至少 3 次互动） */
export function summarizeGraph(graph, key, { minTotal = DEFAULTS.minTotal, topN = DEFAULTS.topN, now = Date.now(), decayDays = DEFAULTS.decayDays } = {}) {
  const g = graph?.groups?.[key];
  if (!g?.pairs) return [];
  const cutoff = now - decayDays * DAY;
  return Object.values(g.pairs)
    .filter((r) => r && Number(r.lastAt) >= cutoff && Number(r.ab) + Number(r.ba) >= minTotal)
    // 历史脏数据：名字清洗后不一致的边不参与渲染（避免控制字符漏进提示词）
    .filter((r) => { const x = r.aName || r.a; const y = r.bName || r.b; return cleanName(x) === String(x || '') && cleanName(y) === String(y || ''); })
    // [CLEAN] 清洗后只剩 0-1 个可见字符 / 含替换符的名字不渲染（防伪造昵称进提示词）
    .filter((r) => { const x = r.aName || r.a; const y = r.bName || r.b; return [...cleanName(x)].length >= 1 && [...cleanName(y)].length >= 1 && !/\uFFFD/.test(x + y); })
    .sort((x, y) => (Number(y.ab) + Number(y.ba)) - (Number(x.ab) + Number(x.ba)))
    .slice(0, topN)
    .map((r) => ({ a: r.a, b: r.b, aDisplay: r.aName || r.a, bDisplay: r.bName || r.b, ab: Number(r.ab), ba: Number(r.ba), total: Number(r.ab) + Number(r.ba), reply: Number(r.reply), adjacent: Number(r.adjacent), mention: Number(r.mention || 0), pos: Number(r.pos || 0), neg: Number(r.neg || 0) }));
}

/** 生成一行可注入文本；没有数据返回 null */
export function renderGraphLine(graph, key, opts = {}) {
  const pairs = summarizeGraph(graph, key, opts);
  if (!pairs.length) return null;
  const parts = pairs.map((p) => {
    const strong = Math.max(p.ab, p.ba);
    const weak = Math.min(p.ab, p.ba);
    const tone = p.neg >= 2 && p.neg >= p.pos * 2 ? '，互怼多' : (p.pos >= 2 && p.pos >= p.neg * 2 ? '，聊得热乎' : '');
    const at = p.mention > 0 ? `，@ 提及 ${p.mention} 次` : '';
    if (strong >= weak * 2 + 2) {
      const from = p.ab >= p.ba ? p.aDisplay : p.bDisplay;
      const to = p.ab >= p.ba ? p.bDisplay : p.aDisplay;
      return `${from} 常接 ${to} 的话（${p.total} 次${tone}${at}）`;
    }
    return `${p.aDisplay} 和 ${p.bDisplay} 常搭话（${p.total} 次${tone}${at}）`;
  });
  return `群里最近谁跟谁常来常往：${parts.join('；')}。`;
}

export { pairKey };
