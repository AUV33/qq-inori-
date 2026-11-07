// assoc-activation.mjs · 宪章 §5.12：联想记忆（link 边 + 扩散激活 + 闲置联想）
//
// 干什么：把记忆从"query → 相似度"的检索范式，补上"node → edge → node"的扩散通道：
//   · buildAssociationGraph：共现（同 who/theme）、时间邻近、字面相似、显式 link → 带权边；
//   · spreadActivation：从当前被激活的记忆出发，有限步扩散，邻域按边权衰减点亮；
//   · idleAssociations：独处/低社交时的随机游走联想（确定性 PRNG，可回放）；
//   · renderAssociationBlock：渲染成独立注入块。
// 为什么：现有召回是查询驱动；关联结构存在但没参与召回，独处时不会"自己想起什么"。
// 输入输出：纯函数；图是 {nodes:Map, edges:Map}，不依赖 IO。
// 失败模式：空图/空种子返回空；坏时间戳跳过时间边；不抛错。
// 不做什么：不读盘、不调模型、不替代按需检索（两条通道并存）。

// [PROMPT-SAFETY] 联想块会把记忆原文送进 prompt：先去掉控制符/伪块头/指令伪装。
import { sanitizePromptSnippet } from '../shared/prompt-safety.mjs';
// [ENTITY] 共同提到的实体也能连边（不依赖外部实体图）。
import { sharedEntityWeight } from './entity-index.mjs';

export const ASSOC_ACTIVATION_VERSION = 1;
const HOUR = 3600000;

function bigrams(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}
function coverage(a, b) {
  const q = bigrams(a); const s = String(b ?? '').replace(/\s+/g, '');
  if (!q.size || s.length < 2) return 0;
  let hit = 0;
  for (const gram of q) if (s.includes(gram)) hit += 1;
  return hit / q.size;
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += Number(a[i]) * Number(b[i]); na += Number(a[i]) ** 2; nb += Number(b[i]) ** 2; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function entryTimeMs(entry) {
  const raw = entry?.recordedAt || entry?.lastMentionAt || entry?.at;
  if (Number.isFinite(Number(raw))) return Number(raw);
  const parsed = Date.parse(String(entry?.time ?? entry?.day ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function textHash(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function entryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.id) return String(entry.id);
  // [AUDIT-FIX] 只取前 40 字会让同时间、同前缀的两条记忆撞 key，后者被静默丢弃；加全文摘要。
  return `${entry.time || entry.day || ''}|${String(entry.text || '').slice(0, 40)}#${textHash(entry.text)}`;
}

/**
 * @param {Array} entries
 * @param {{maxNodes?:number, maxEdgesPerNode?:number, now?:number, vectorOf?:Function, semanticThreshold?:number}} [opts]
 *   vectorOf(entry) → 向量或 null；提供时按余弦补“语义边”（默认阈值 0.8）。
 * @returns {{v:number, nodes:Map<string,object>, edges:Map<string,Array<{to:string,weight:number,kind:string}>>}}
 */
export function buildAssociationGraph(entries, opts = {}) {
  const maxNodes = Number.isFinite(opts.maxNodes) ? Math.max(1, opts.maxNodes) : 120;
  const maxEdges = Number.isFinite(opts.maxEdgesPerNode) ? Math.max(1, opts.maxEdgesPerNode) : 6;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const vectorOf = typeof opts.vectorOf === 'function' ? opts.vectorOf : null;
  const semanticThreshold = Number.isFinite(opts.semanticThreshold) ? opts.semanticThreshold : 0.8;
  const entityOf = typeof opts.entityOf === 'function' ? opts.entityOf : null;
  const nodes = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = entryKey(entry);
    if (!key || nodes.has(key)) continue;
    nodes.set(key, entry);
    if (nodes.size >= maxNodes) break;
  }
  const edges = new Map([...nodes.keys()].map((key) => [key, []]));
  const list = [...nodes.entries()];
  const addEdge = (from, to, weight, kind) => {
    if (from === to || weight < 0.15) return;
    const row = edges.get(from);
    if (row.some((e) => e.to === to)) return;
    row.push({ to, weight: Math.round(weight * 1000) / 1000, kind });
  };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [ka, a] = list[i];
      const [kb, b] = list[j];
      let weight = 0;
      const kinds = [];
      if (a.who && b.who && String(a.who) === String(b.who)) { weight += 0.25; kinds.push('who'); }
      if (a.theme && b.theme && String(a.theme) === String(b.theme)) { weight += 0.3; kinds.push('theme'); }
      const ta = entryTimeMs(a); const tb = entryTimeMs(b);
      if (ta !== null && tb !== null && Math.abs(ta - tb) <= 6 * HOUR) { weight += 0.2; kinds.push('temporal'); }
      const lex = Math.max(coverage(a.text, b.text), coverage(b.text, a.text));
      if (lex >= 0.2) { weight += Math.min(0.5, lex * 0.6); kinds.push('lexical'); }
      if (vectorOf) {
        try {
          const sim = cosine(vectorOf(a), vectorOf(b));
          if (sim >= semanticThreshold) { weight += 0.45; kinds.push('semantic'); }
        } catch { /* 坏向量不连边 */ }
      }
      if (entityOf) {
        try {
          const shared = sharedEntityWeight(entityOf(a), entityOf(b));
          if (shared > 0) { weight += Math.min(0.3, 0.15 + shared * 0.15); kinds.push('entity'); }
        } catch { /* 坏实体集合不连边 */ }
      }
      const explicit = (Array.isArray(a.links) && a.links.map(String).includes(kb)) || (Array.isArray(b.links) && b.links.map(String).includes(ka));
      if (explicit) { weight += 1; kinds.push('explicit'); }
      if (!weight) continue;
      addEdge(ka, kb, weight, kinds.join('+'));
      addEdge(kb, ka, weight, kinds.join('+'));
    }
  }
  for (const [key, rows] of edges) {
    if (rows.length > maxEdges) edges.set(key, rows.slice().sort((a, b) => b.weight - a.weight).slice(0, maxEdges));
  }
  return { v: ASSOC_ACTIVATION_VERSION, nodes, edges, builtAt: now };
}

/**
 * 扩散激活：返回被点亮的非种子节点。
 * @param {object} graph
 * @param {string[]} seeds
 * @param {{steps?:number, decay?:number, topK?:number, minScore?:number}} [opts]
 */
export function spreadActivation(graph, seeds, opts = {}) {
  const steps = Math.max(1, Math.min(4, Number(opts.steps) || 2));
  const decay = Number.isFinite(opts.decay) ? Math.max(0.05, Math.min(0.95, opts.decay)) : 0.5;
  const topK = Number.isFinite(opts.topK) ? Math.max(0, opts.topK) : 6;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.05;
  const edges = graph?.edges;
  if (!edges || !edges.size) return { activated: [], steps: 0 };
  const seedSet = new Set((Array.isArray(seeds) ? seeds : []).map(String).filter(Boolean));
  let frontier = new Map([...seedSet].map((key) => [key, 1]));
  const scores = new Map();
  for (let step = 1; step <= steps; step += 1) {
    const next = new Map();
    for (const [key, activation] of frontier) {
      for (const edge of edges.get(key) || []) {
        if (seedSet.has(edge.to)) continue;
        const value = activation * decay * edge.weight;
        if (value < minScore) continue;
        next.set(edge.to, Math.max(next.get(edge.to) || 0, value));
        scores.set(edge.to, Math.max(scores.get(edge.to) || 0, value));
      }
    }
    frontier = next;
    if (!frontier.size) break;
  }
  const activated = [...scores.entries()]
    .map(([key, score]) => ({ key, score: Math.round(score * 1000) / 1000, entry: graph.nodes.get(key) }))
    .filter((row) => row.entry)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return { activated, steps };
}

/** 确定性 PRNG（可注入 random 便于测试）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 独处联想：随机游走（可复现），返回非种子节点。 */
export function idleAssociations(graph, { seedKey = '', steps = 3, topK = 5, random = null, seed = 7 } = {}) {
  const edges = graph?.edges;
  if (!edges || !edges.size) return [];
  const rng = typeof random === 'function' ? random : mulberry32(seed);
  let current = seedKey && edges.has(seedKey) ? seedKey : [...edges.keys()][Math.floor(rng() * edges.size)];
  const visited = new Set();
  const out = [];
  for (let step = 0; step < Math.max(1, Math.min(6, steps)); step += 1) {
    const rows = (edges.get(current) || []).filter((e) => !visited.has(e.to) && e.to !== seedKey);
    if (!rows.length) break;
    const total = rows.reduce((n, e) => n + e.weight, 0);
    let pick = rng() * total;
    let chosen = rows[rows.length - 1];
    for (const edge of rows) { pick -= edge.weight; if (pick <= 0) { chosen = edge; break; } }
    visited.add(chosen.to);
    out.push({ key: chosen.to, entry: graph.nodes.get(chosen.to), via: chosen.kind, weight: chosen.weight });
    current = chosen.to;
  }
  return out.slice(0, Math.max(0, topK));
}

/** 渲染独立块；空则空串。 */
export function renderAssociationBlock(activated) {
  const rows = (Array.isArray(activated) ? activated : []).filter((row) => row && row.entry && row.entry.text);
  if (!rows.length) return '';
  const lines = rows.slice(0, 5)
    .map((row) => sanitizePromptSnippet(row.entry.text, { maxChars: 100 }))
    .filter(Boolean)
    .map((text) => `- ${text}`);
  if (!lines.length) return '';
  return `【顺带想起（关联激活，不是检索结果）】\n${lines.join('\n')}\n（没有谁在问；只是这些记忆被刚才的事带出来了。要不要说，你自己判断。）`;
}
