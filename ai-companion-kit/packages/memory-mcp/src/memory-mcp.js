// memory-mcp · 她的长期记忆（stdio MCP 服务器）
//
// 借鉴 mizuse 的硬经验：记忆按「人」存不按会话存、检索挑 top-N 且最近必选、
// 写入前先去重（它踩过裸 INSERT 无去重→重复检索的坑）、环境无分词器所以
// 无语义服务时退回字符二元组。
//
// ★ v1.2 新增：**按会话隔离**（scope）
//   群里说出私聊的记忆是硬伤（"他下周生日"跑到群里）。MCP 进程本身不知道
//   当前是群还是私聊，所以由她显式传 scope：
//     private（默认）          → data/memory/memory.jsonl
//     group:123456789 / group_123456789 → data/memory/memory-group-123456789.jsonl
//   物理分文件，永远读不到别的会话的记忆。群库单独限流（每天 10 条）。
//
// 检索优先用本地 bge-m3 语义嵌入（1024 维），服务不可用时静默退回字面。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { embedKey, EMBED_MODEL, EMBED_DIM } from '../../shared/embed-key.mjs';
import { buildMemoryEntry } from './memory-entry.mjs';
import { detectContradictions } from './memory-contradiction.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// [STORE] 原子写入口（避免与桥接的 append 交错丢数据）
import { appendJsonl, rewriteJsonl, withFileLock } from '../../shared/learning-store.mjs';
import { dataPath, statePath, bridgeSrcPath, fileUrlOf } from '../../shared/inori-paths.mjs';
// [TOOL-CATALOG] 核心常驻 + 分类目录按需调用（省 token：未常驻的工具不再随每次请求发 schema）
import { installToolCatalog } from '../../shared/mcp-tool-catalog.mjs';

const DIR = process.env.MEMORY_DIR || dataPath('memory');
const EMBED_URL = process.env.MEMORY_EMBED_URL || 'http://127.0.0.1:8790/v1/embeddings';
const MAX_CHARS = 200;
const MAX_PER_DAY = 20;        // 私聊
const MAX_PER_DAY_GROUP = 10;  // 群聊更克制
const RECALL_DEFAULT = 8;
const MIN_SIM = 0.35;
const DEDUPE_THRESHOLD = 0.85;

// [COGNITION] 认知：她提炼出的、跨事件稳定的判断。和记忆分开存——
// memory 记「发生了什么」，cognition 记「想明白了什么」，带 kind/when/unless/confidence，可被推翻。
// 为什么放在这个包里：写认知以前只有桥接侧的 qq_cognition_add，而要 key+token——
// 她 84% 的工具调用发生在没有令牌的自主/任务会话里，等于没有写入口。
const COGNITION_FILE = process.env.COGNITION_FILE || statePath('cognition.jsonl');
const COGNITION_MAX_CHARS = 300;
const COGNITION_DEDUPE = 0.85;
const COGNITION_KINDS = ['about-him', 'about-group', 'about-world', 'about-me', 'how-to', 'general'];
// [JUDGMENT-ONLY] 新写入只收判断；how-to 留给技能/记忆，旧数据仍可读。
const COGNITION_JUDGMENT_KINDS = ['about-him', 'about-group', 'about-world', 'about-me', 'general'];
const COGNITION_KIND_LABEL = {
  'about-him': '关于他', 'about-group': '关于群', 'about-world': '关于世界',
  'about-me': '关于我', 'how-to': '怎么做', general: '其他',
};

/** 认知主体：同一主体只留一条有效判断（换说法不再堆新的）。 */
function cognitionSubject(concept, gist = '') {
  const raw = String(concept || gist || '').trim();
  if (!raw) return '';
  const head = raw.split(/[（(：:，,。；;！!？?\n「」]/)[0].trim();
  const cut = head.replace(/(靠|是|要|让|把|在|的|本质|不自然|会|能|先|别).*$/, '').trim();
  return (cut || head).slice(0, 24);
}

function loadCognition() {
  try {
    return fs.readFileSync(COGNITION_FILE, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((x) => x && typeof x.text === 'string' && x.text.trim());
  } catch { return []; }
}

function saveCognition(list) {
  rewriteJsonl(COGNITION_FILE, list, { source: 'memory-mcp/cognition' });
}

function cognitionId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}


/** 规范化 scope：private | group_<数字>；认不出的按 private */
function canonScope(scope) {
  const s = String(scope ?? '').trim();
  if (!s || s === 'private') return 'private';
  const m = /^group[:：_\s]*(\d+)$/.exec(s);
  if (m) return `group_${m[1]}`;
  return 'private';
}
function pathsFor(scope) {
  const sc = canonScope(scope);
  if (sc === 'private') {
    return { scope: sc, file: path.join(DIR, 'memory.jsonl'), cache: path.join(DIR, 'embeddings.json'), limit: MAX_PER_DAY };
  }
  return {
    scope: sc,
    file: path.join(DIR, `memory-${sc}.jsonl`),
    cache: path.join(DIR, `embeddings-${sc}.json`),
    limit: MAX_PER_DAY_GROUP,
  };
}

// ── [RAW] 原文层：与桥接侧同一目录布局（data/raw/<scope>.jsonl）─────────────
// 为什么加：记忆库一半是摘要，语义查不到「承诺/冲突/原话」。桥接已把每条消息落原文，
// 这里在「调用侧」把它并进召回——她自己问「我答应过他什么」时，能查到原文。
const RAW_DIR = process.env.MEMORY_RAW_DIR || path.join(DIR, '..', 'raw');
const SELF_QUERY_RE = /你刚才|你刚说|刚才那句|这句话|那句|哪句|你说过|我说过|她说过|你上一条|上一条|回的是哪|回的哪|指的是哪|在回哪|接的是哪|你发的|答应|承诺|保证/;
const RAW_STOP = /什么|怎么|为什么|是不是|有没有|多少|哪个|这句|那句|一下|帮我|我们|他们|你们|这个|那个/;

function rawBigrams(t) {
  const x = String(t ?? '').replace(/\s+/g, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2));
  return out;
}
function rawCoverage(a, b) {
  const A = rawBigrams(a), B = rawBigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}
function loadRawRows(scope, limit = 5000) {
  try {
    const sc = canonScope(scope);
    const file = path.join(RAW_DIR, `${sc}.jsonl`);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.text);
    return rows.slice(-limit);
  } catch { return []; }
}
function scoreRawRows(rows, q, { limit = 3 } = {}) {
  const selfQ = SELF_QUERY_RE.test(String(q ?? ''));
  const plain = String(q ?? '').replace(RAW_STOP, ' ').trim() || String(q ?? '');
  const out = [];
  for (const r of rows) {
    if (!r || !r.text) continue;
    if (r.isSelf && !selfQ) continue; // 她自己的原话只在问「我说过/她说过」时收
    const cov = rawCoverage(plain, r.text);
    const covRev = rawCoverage(String(r.text).slice(0, 30), plain);
    const inc = String(r.text).toLowerCase().includes(String(plain).toLowerCase().slice(0, Math.max(2, Math.min(8, plain.length)))) ? 1 : 0;
    const score = cov * 0.45 + covRev * 0.2 + inc * 0.2;
    if (score >= (selfQ ? 0.1 : 0.25)) out.push({ r, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}
// 与记忆的互通规则一致：私聊翻得到各群原文；群聊翻得到私聊原文（带来源标）
function rawScopesFor(scope) {
  const sc = canonScope(scope);
  const list = [{ sc, tag: null }];
  try {
    if (sc === 'private') {
      for (const f of fs.readdirSync(RAW_DIR)) {
        const m = /^group_(\d+)\.jsonl$/.exec(f);
        if (m) list.push({ sc: `group_${m[1]}`, tag: m[1] });
      }
    } else {
      list.push({ sc: 'private', tag: 'private' });
    }
  } catch { /* 没有其它库很正常 */ }
  return list;
}
function loadRawAll(scope) {
  const out = [];
  for (const { sc, tag } of rawScopesFor(scope)) {
    for (const r of loadRawRows(sc)) out.push(tag ? { ...r, _rawFrom: tag } : r);
  }
  return out;
}
const rawStamp = (r) => {
  const d = new Date(Number(r.time) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.toLocaleDateString('sv-SE')} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const reply = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });
// [EMBED-VERSION] 嵌入缓存键统一走 shared/embed-key.mjs（带模型+维度，防换模型污染）。
// 旧 embedKey(text) 写法已移除——见 embed-key.mjs 注释。

// [动量] 复用桥接侧的纯模块（K=5 非线性、14 天衰减），避免两份实现
let Momentum = null;
try {
  const bridgeSrc = process.env.BRIDGE_SRC || bridgeSrcPath();
  Momentum = await import(new URL('file://' + path.posix.join(bridgeSrc, 'inori-momentum.js')).href);
} catch { /* 模块缺失时退化为原来的"重复即拒" */ }

function load(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.toLocaleDateString('sv-SE')} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const today = (d = new Date()) => d.toLocaleDateString('sv-SE');

function bigrams(s) {
  const t = String(s ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}
function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

// ── 语义嵌入（失败返回 null，绝不抛） ─────────────────────────────────
function loadCache(cache) {
  try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { return {}; }
}
function saveCache(cache, c) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(cache, JSON.stringify(c), 'utf8'); } catch { /* 缓存写不了不影响主流程 */ }
}
async function embedBatch(texts) {
  try {
    const r = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: texts, model: EMBED_MODEL }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const vs = (j?.data ?? []).map((d) => d.embedding);
    return vs.length === texts.length && vs.every((v) => Array.isArray(v)) ? vs : null;
  } catch { return null; }
}
const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
async function ensureVectors(memories, cachePath) {
  const cache = loadCache(cachePath);
  const missing = [];
  for (const m of memories) {
    const k = embedKey(m.text);
    if (!cache[k]) missing.push(m.text);
  }
  if (missing.length) {
    const vs = await embedBatch(missing);
    if (!vs) return null;
    missing.forEach((t, i) => { cache[embedKey(t)] = vs[i]; });
    saveCache(cachePath, cache);
  }
  const map = new Map();
  for (const m of memories) map.set(embedKey(m.text), cache[embedKey(m.text)]);
  return map;
}

/** 记忆按「情节」排版：谁 + 发生了什么 + 当时感受 + 主题（与桥接侧 formatEntry 同一套口径） */
/** [MEM-TIME] 记忆按时间倒序；跨库（私聊/群）在行首标来源，区分得清又不丢互通。 */
function sortByTimeDesc(list) {
  const ms = (e) => {
    const raw = String(e?.time || e?.day || '').replace(' ', 'T');
    const v = Date.parse(raw);
    return Number.isFinite(v) ? v : -Infinity;
  };
  return (Array.isArray(list) ? list : [])
    .map((e, i) => ({ e, i, t: ms(e) }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map((x) => x.e);
}
function formatEntry(e) {
  const who = e && e.who && e.who !== '他' ? `${e.who}：` : '';
  const felt = e && e.felt ? `（当时：${e.felt}）` : '';
  const theme = e && e.theme ? ` #${e.theme}` : '';
  const src = e?._fromPrivate ? '（私聊里记的）' : (e?._fromGroup ? (typeof e._fromGroup === 'string' ? `（群 ${e._fromGroup} 里记的）` : '（群里记的）') : '');
  return `${e?.time ?? ''}｜${src}${who}${e?.text ?? ''}${felt}${theme}`;
}
const server = new McpServer({ name: 'memory', version: '1.2.0' });

// [TOOL-CATALOG] 6 个高频工具常驻，其余 15 个收进 memory_tools 分类目录。
// 必须在所有 server.tool(...) 之前安装（browse_tool / feed_tool 也是通过 server.tool 注册的，
// 放在它们被 import 之前才能生效）；只改注册面，工具实现未动。
// 说明：任务给的核心集里 memory_edit / memory_list 在本服务中并不存在（那是桥接侧
// mcp-snowluma-safe.js 的同名工具），按"不存在的名字忽略"处理，故不在常驻列表里。
installToolCatalog(server, {
  catalogName: 'memory_tools',
  catalogDescription: '【工具目录】记忆/技能/目标类工具大部分没有常驻，按分类收着。用法：① 不传参数 → 列出所有分类；② 只传 category → 列出该分类下的工具和用途；③ 传 tool + arguments → 直接调用那个工具（参数和它原本的 schema 一致）。常驻可直接用的是：memory_save / memory_recall / lesson_write / lesson_list / goal_list / goal_add / cognition_save。',
  coreTools: [
    'memory_save', 'memory_recall', 'lesson_write', 'lesson_list', 'goal_list', 'goal_add', 'cognition_save',
    // [LEARNING-LOOP] 学习闭环常驻：她不用先翻目录才能开始/收尾一次练习。
    'goal_progress', 'goal_done', 'learning_item', 'practice_start', 'practice_note', 'practice_result', 'practice_list', 'skill_draft',
  ],
  groups: {
    目标: ['goal_progress', 'goal_done'],
    学习: ['learning_item', 'practice_start', 'practice_note', 'practice_result', 'practice_list', 'skill_draft'],
    经验: ['lesson_drop', 'lesson_vote'],
    认知: ['cognition_list'],
    技能库: ['skill_save', 'skill_find', 'skill_record', 'skill_list', 'skill_history', 'skill_delete', 'skill_edit', 'skill_verify', 'skill_revise', 'skill_merge', 'skill_rollback'],
    经验池: ['trace_log'],
    记忆维护: ['memory_stats'],
    逛帖子: ['browse_posts', 'feed_posts'],
  },
});

server.tool(
  'memory_save',
  '记下一件事。你觉得以后可能用得上的，就记一条；一两句就够，别写成日记。同样的意思不用重复记。',
  {
    text: z.string().describe('要记住的内容：发生了什么，一两句，最多 200 字'),
    kind: z.enum(['fact', 'impression', 'event']).optional().describe('fact=事实 impression=印象 event=发生的事，都可以不填'),
    scope: z.string().optional().describe('在哪记的：私聊不用填；群聊要填 group:<群号>。分开存，但翻的时候都看得见（会标来源）。'),
    who: z.string().optional().describe('这件事和谁有关：他 / 我 / 我们 / 群里某人，不填默认"他"'),
    felt: z.string().optional().describe('你当时什么感觉，一句话，比如「有点心疼」「觉得好笑」——这条最容易被以后的你想起'),
    theme: z.string().optional().describe('一个词的主题标签，比如 生日 / 工作 / 游戏 / 吵架，方便以后把同类的事串起来'),
  },
  async ({ text, kind, scope, who, felt, theme }) => {
    try {
      const P = pathsFor(scope);
      // [CONCURRENCY] 整个读-改-写（含向量判重与落盘）在文件锁内完成，
      // 避免两个 memory_save 并发时 rewriteJsonl 与 appendFileSync 互相覆盖丢条目。
      return await withFileLock(P.file, async () => {
      const body = String(text ?? '').trim();
      if (!body) return fail('没写内容');
      if (body.length > MAX_CHARS) return fail(`太长了（${body.length} 字），一条记忆最多 ${MAX_CHARS} 字`);
      const all = load(P.file);
      // [动量] 字面很像时也按"又提了一次"处理，而不是直接拒
      const dupLocal = all.find((e) => overlap(e.text, body) >= DEDUPE_THRESHOLD);
      if (dupLocal) {
        if (Momentum) {
          Momentum.bump(dupLocal);
          rewriteJsonl(P.file, all, { source: 'memory-mcp' });
          return reply(`这件以前记过，又提了一次（第 ${dupLocal.mentions} 次，动量 ${dupLocal.momentum}）：${dupLocal.text.slice(0, 30)}`);
        }
        return reply(`这条和已有的记忆很像（${dupLocal.time}｜${dupLocal.text.slice(0, 30)}），没重复记。`);
      }
      const vecMap = await ensureVectors([...all, { text: body }], P.cache);
      if (vecMap) {
        const newVec = vecMap.get(embedKey(body));
        for (const e of all) {
          const v = vecMap.get(embedKey(e.text));
          if (v && newVec && cos(v, newVec) >= 0.92) {
            // [动量] 同义又提一次：不新增条目，给原条目 mentions+1。
            // 这样「他天天提的事」权重自然更高（Amory 的 momentum-aware consolidation）。
            if (Momentum) {
              Momentum.bump(e);
              rewriteJsonl(P.file, all, { source: 'memory-mcp' });
              return reply(`这件以前记过，又提了一次（第 ${e.mentions} 次，动量 ${e.momentum}）：${e.text.slice(0, 30)}`);
            }
            return reply(`这条和已有的记忆意思太近（${e.time}｜${e.text.slice(0, 30)}），没重复记。`);
          }
        }
      }
      const n = all.filter((e) => e.day === today()).length;
      if (n >= P.limit) return fail(`今天在这个会话里已经记了 ${n} 条，够了。`);
      fs.mkdirSync(DIR, { recursive: true });
      const now = new Date();
      // [SEMANTIC-PIN] owner 稳定事实自动钉、情景事件带绝对日期；分类失败按原 kind 落。
      let pin = null;
      try {
        const SP = await semanticPin();
        pin = SP.classifyMemory({ text: body, kind, isOwner: P.scope === 'private', now: now.getTime() });
      } catch { /* 分类失败不挡记忆 */ }
      const entry = buildMemoryEntry({
        text: body, kind: pin?.kind ?? kind, who, felt, theme, scope: P.scope, now,
        embedModel: `${EMBED_MODEL}@${EMBED_DIM}`,
        pinned: pin?.pinned === true, occurredOn: pin?.occurredOn || '', pinReason: pin?.reason || '',
      });
      // [F2-CONTRADICTION] 落盘前检测矛盾/态度反转，仅附加标注、不改写入行为。
      const contra = detectContradictions(entry, all);
      if (contra.length) entry.contradicts = contra;
      fs.appendFileSync(P.file, JSON.stringify(entry) + '\n', 'utf8');
      // [OWNER-MODEL] owner 私聊的稳定偏好 → owner-model 事件（owner 亲口说，优先于推断）；失败不影响记忆。
      try {
        if (P.scope === 'private' && pin?.pinned === true) {
          const OM = await ownerModel();
          const pref = OM.extractPreference(body);
          if (pref) {
            const store = OM.createOwnerModelStore({ file: statePath('mind', 'owner-model.jsonl') });
            await store.preference({
              topic: pref.topic, value: pref.value, source: 'owner',
              // [AUDIT-FIX] 同一分钟、同长度的两条不同偏好会撞 evidenceId（第二条被折叠丢弃）；用正文摘要。
              evidenceId: `memory:${crypto.createHash('sha1').update(body).digest('hex').slice(0, 12)}:${entry.recordedAt}`, at: now.getTime(),
            });
          }
        }
      } catch { /* 偏好模型失败不挡记忆 */ }
      const extra = [entry.who && `谁=${entry.who}`, entry.felt && '带了自己的感受', entry.theme && `主题=${entry.theme}`].filter(Boolean).join('，');
      return reply(`记下了（${P.scope} 共 ${all.length + 1} 条${extra ? '；' + extra : ''}）。`);
      });
    } catch (e) {
      return fail(`记不下来：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'memory_recall',
  '翻记忆。想起某件事、或者想知道以前说过什么的时候看一下。不查也会给你最近记的几条。',
  {
    query: z.string().optional().describe('想找什么，比如「猫」「工作」，不填就按时间给最近的'),
    limit: z.number().optional().describe('要几条，默认 8，最多 20'),
    scope: z.string().optional().describe('在哪翻：私聊不用填；群聊填 group:<群号>（群里也会翻到私聊记的事，标来源；说不说由你定）'),
  },
  async ({ query, limit, scope }) => {
    const P = pathsFor(scope);
    // [互通] 群聊里也合并私聊库：她在群里也该记得他本人的事。
    // 写入仍然分库（来源可追溯），只有"回忆"合并。
    // [MEMORY-CLASSIFY] 私聊翻得到各群的记忆，但每条带群号；群聊翻得到私聊，带「私聊里记的」。
    const files = [P.file];
    if (P.scope === 'private') {
      for (const f of fs.readdirSync(DIR)) {
        if (/^memory-group_\d+\.jsonl$/.test(f)) files.push(path.join(DIR, f));
      }
    } else {
      files.push(pathsFor(null).file);
    }
    const merged = [];
    const seenText = new Set();
    for (const f of files) {
      const isPrimary = f === P.file;
      const gm = /^memory-group_(\d+)\.jsonl$/.exec(path.basename(f));
      for (const e of load(f)) {
        if (!e || !e.text || seenText.has(e.text)) continue;
        seenText.add(e.text);
        merged.push(isPrimary ? e : (gm ? { ...e, _fromGroup: gm[1] } : { ...e, _fromPrivate: P.scope !== 'private' }));
      }
    }
    const all = merged;
    if (!all.length) return reply(`还没有记住任何事（${P.scope}）。`);
    const n = Math.min(Math.max(Number(limit) || RECALL_DEFAULT, 1), 20);
    const q = String(query ?? '').trim();
    const recent = all.slice(-Math.min(2, all.length));

    if (!q) {
      const picked = sortByTimeDesc(all.slice(-n));
      return reply(`（${P.scope}，共 ${all.length} 条，本次给 ${picked.length} 条，按时间倒序）\n` + picked.map((e) => formatEntry(e)).join('\n'));
    }

    const vecMap = await ensureVectors(all, P.cache);
    let scored = null;
    let mode = '语义';
    if (vecMap) {
      const qv = (await embedBatch([q]))?.[0] ?? null;
      if (qv) {
        scored = all
          .map((e) => ({ e, s: cos(qv, vecMap.get(embedKey(e.text))) }))
          .filter((x) => x.s >= MIN_SIM)
          .sort((a, b) => b.s - a.s);
      }
    }
    if (!scored) {
      mode = '字面';
      scored = all
        .map((e) => {
          let s = overlap(e.text, q);
          if (String(e.text).includes(q)) s = Math.max(s, 0.9);
          return { e, s };
        })
        .filter((x) => x.s > 0.15)
        .sort((a, b) => b.s - a.s);
    }

    // [RAW] 原文层命中排最前：语义查不到的承诺/冲突/原话由它兜底
    const rawRows = loadRawAll(P.scope);
    const rawHits = scoreRawRows(rawRows, q, { limit: 3 });
    if (process.env.RAW_DEBUG) console.error('[raw-debug]', P.scope, 'dir=', RAW_DIR, 'rows=', rawRows.length, 'hits=', rawHits.length);
    if (rawHits.length) {
      // 注意：scored 的元素是 { e, s }，不能直接塞条目（否则 map(x => x.e) 得到 undefined）
      const rawScored = rawHits.map(({ r, score }) => ({
        s: score,
        e: {
          text: `（原文${r._rawFrom ? (r._rawFrom === 'private' ? '·私聊' : `·群${r._rawFrom}`) : ''}）${r.text}`,
          time: rawStamp(r),
          who: r.isSelf ? '我' : (r.sender || ''),
          _raw: true,
        },
      }));
      scored = [...rawScored, ...scored];
      mode += '+原文';
    }
    const top = scored.slice(0, n).map((x) => x.e);
    const seen = new Set(top.map((e) => e.text));
    for (const r of recent) if (!seen.has(r.text)) top.push(r);
    const shown = sortByTimeDesc(top);
    return reply(`（${P.scope}，共 ${all.length} 条，本次给 ${shown.length} 条，${mode}检索·按时间倒序）\n` + shown.map((e) => formatEntry(e)).join('\n'));
  }
);

server.tool(
  'memory_stats',
  '看一眼自己的记忆有多少条、最早最晚是什么时候。',
  {
    scope: z.string().optional().describe('私聊不用填；群聊填 group:<群号>'),
  },
  async ({ scope }) => {
    const P = pathsFor(scope);
    const all = load(P.file);
    if (!all.length) return reply(`${P.scope} 还没有记忆。`);
    const vecMap = await ensureVectors(all, P.cache);
    return reply(`${P.scope} 共 ${all.length} 条；最早 ${all[0].time}，最近 ${all[all.length - 1].time}；语义索引${vecMap ? '可用' : '不可用（退回字面）'}。`);
  }
);

// ── [GOALS] 目标栈（她手上的事）。模块在 qq-bridge/src/domain/leaves/inori-goals.js，只存/取，不替她写内容 ──
const GOALS_FILE = process.env.GOALS_FILE || statePath('goals.json');
let goalsMod = null;
async function goals() {
  if (!goalsMod) goalsMod = await import(fileUrlOf(path.join(bridgeSrcPath(), 'domain', 'leaves', 'inori-goals.js')));
  return goalsMod;
}

server.tool(
  'goal_add',
  '给自己记一件想做但还没做完的事。最多同时 5 件，一两句话就够；不用汇报给谁。',
  {
    text: z.string().describe('要做的事，最多 80 字'),
  },
  async ({ text }) => {
    const g = await goals();
    const all = g.load(GOALS_FILE);
    const r = g.add(all, text);
    if (!r.ok) {
      const why = r.reason === 'duplicate' ? '这件事已经在你的清单里了'
        : r.reason === 'empty' ? '没写内容'
          : r.reason.startsWith('active-limit') ? '手上的事太多了，先做完一两件再记新的'
            : r.reason;
      return fail(why);
    }
    g.save(all, GOALS_FILE);
    return reply(`记下了：${r.goal.text}（现在共 ${all.filter((x) => x.status === 'active').length} 件在手上）`);
  }
);

server.tool(
  'goal_list',
  '看看自己手上还有哪些事没做完。',
  {},
  async () => {
    const g = await goals();
    const all = g.load(GOALS_FILE);
    const act = all.filter((x) => x.status === 'active' || x.status === 'parked');
    if (!act.length) return reply('手上没有没做完的事。');
    const lines = act.map((x, i) => {
      const last = x.progress.length ? `（上次：${x.progress[x.progress.length - 1].note}）` : '';
      const next = x.nextAction ? `；下一步：${x.nextAction}` : '';
      const parked = x.status === 'parked' ? '［搁着］' : '';
      return `${i + 1}. ${parked}${x.text}${last}${next}  [${x.id}]`;
    });
    return reply(`手上 ${act.length} 件事：\n${lines.join('\n')}`);
  }
);

server.tool(
  'goal_progress',
  '给某件事记一笔进展（做了点什么）。有下一步就一起写，下次接着做。',
  {
    id: z.string().describe('目标 id，goal_list 里方括号里的那个'),
    note: z.string().describe('做了什么，一句话'),
    next: z.string().optional().describe('下一步是什么（可选，一句话）'),
  },
  async ({ id, note, next }) => {
    const g = await goals();
    const all = g.load(GOALS_FILE);
    const r = g.update(all, id, { note, nextAction: next ?? '' });
    if (!r.ok) return fail('没找到这件事，先 goal_list 看看 id');
    g.save(all, GOALS_FILE);
    return reply(`记上了：${r.goal.text} —— ${note}${next ? `；下一步：${next}` : ''}`);
  }
);

server.tool(
  'goal_done',
  '把某件事标成做完了（或者放下、先搁着）。做完了必须给证据；没有证据只能先搁着，不能假装做完。',
  {
    id: z.string().describe('目标 id'),
    status: z.enum(['done', 'dropped', 'parked']).optional().describe('done=做完了（必须给 evidence） dropped=不做了 parked=先搁着，默认 done'),
    evidence: z.string().optional().describe('凭什么算做完了：一句机检结果/文件路径/他明确说行'),
    next: z.string().optional().describe('下一步（失败/搁着时写）'),
  },
  async ({ id, status, evidence, next }) => {
    const g = await goals();
    const all = g.load(GOALS_FILE);
    const want = status ?? 'done';
    const r = g.update(all, id, { status: want, evidence: evidence ?? '', nextAction: next ?? '' });
    if (!r.ok) return fail('没找到这件事，先 goal_list 看看 id');
    g.save(all, GOALS_FILE);
    if (r.downgraded) {
      return reply(`没给证据，先搁着：${r.goal.text}（不是做完了；补上证据再说 done）`);
    }
    if (want === 'parked') return reply(`先搁着了：${r.goal.text}`);
    if (want === 'dropped') return reply(`放下了：${r.goal.text}`);
    return reply(`做完了：${r.goal.text}｜证据：${r.goal.evidence}`);
  }
);

// ── [LESSONS] 经验（关于她自己的认知，不是事实）──
// 与 memory 的分工：memory 存「他说过什么」（量大、按需检索）；
// lessons 存「我发现自己会怎样」（量小、长期有效、常驻注入）。
const LESSONS_FILE = process.env.LESSONS_FILE || statePath('lessons.jsonl');
// [LEDGER-SYNC] 宪章 §5.4：旧 lesson 通道同步到 lessons-ledger（append-only，状态机在桥接侧）。
const LESSONS_LEDGER_FILE = process.env.LESSONS_LEDGER_FILE || statePath('mind', 'lessons-ledger.jsonl');
let lessonsMod = null;
async function lessons() {
  if (!lessonsMod) lessonsMod = await import(fileUrlOf(path.join(bridgeSrcPath(), 'domain', 'leaves', 'inori-lessons.js')));
  return lessonsMod;
}
let lessonsLedgerMod = null;
async function lessonsLedger() {
  if (!lessonsLedgerMod) lessonsLedgerMod = await import(fileUrlOf(path.join(bridgeSrcPath(), 'domain', 'mind', 'lessons-ledger.mjs')));
  return lessonsLedgerMod;
}
let semanticPinMod = null;
async function semanticPin() {
  if (!semanticPinMod) semanticPinMod = await import(fileUrlOf(path.join(bridgeSrcPath(), 'domain', 'memory', 'semantic-pin.mjs')));
  return semanticPinMod;
}
let ownerModelMod = null;
async function ownerModel() {
  if (!ownerModelMod) ownerModelMod = await import(fileUrlOf(path.join(bridgeSrcPath(), 'domain', 'mind', 'owner-model.mjs')));
  return ownerModelMod;
}

server.tool(
  'lesson_write',
  '想明白一件事的时候记下来——关于你自己的、关于他的、或者关于你们之间的。这不是日记，是一句话的经验。',
  {
    text: z.string().describe('一句话，最多 120 字。例：他一说累，我先别急着给建议'),
    kind: z.enum(['about-him', 'about-me', 'about-us', 'about-people']).optional().describe('关于他 / 关于你自己 / 关于你们 / 关于别人怎么说话，默认关于你自己'),
    track: z.enum(['doing', 'reading']).optional().describe('doing=能截图/命令验证的操作做法；reading=读人/关系/审美这类判断。不填按内容自动判'),
    trigger: z.string().optional().describe('什么情况下用得上这条，比如「他说累的时候」——以后遇到这种情况会想起它'),
    verify: z.string().optional().describe('可选：这条经验怎么算验过了（做一次看结果对不对，一句话）'),
    counterexample: z.string().optional().describe('reading 轨必填：什么情况下这条不成立/反例，最多 100 字'),
    confidence: z.number().optional().describe('你有多确定，0~1，默认 0.7'),
  },
  async ({ text, kind, track, trigger, verify, counterexample, confidence }) => {
    const L = await lessons();
    const list = L.load(LESSONS_FILE);
    const r = L.add(list, text, { kind, track, trigger, verify, counterexample, confidence, mergeNear: true, requireCounterexample: true }); // [LESSON-MERGE] 显式开启近重复合并
    if (!r.ok) {
      if (r.reason === 'duplicate') return fail('这条以前就想明白了，不用重复记');
      if (r.reason === 'counterexample-required') return fail('判断类经验要带一个反例（counterexample）：什么情况下这条不成立？没有反例就先当一次观察，不急着记。');
      return fail('没写内容');
    }
    L.rewrite(list, LESSONS_FILE);
    // [LEDGER-SYNC] 新经验同时进宪章教训账（候选，legacyId 指回旧 id）；失败不挡旧通道。
    let ledgerNote = '';
    try {
      const M = await lessonsLedger();
      const store = M.createLessonsLedger({ file: LESSONS_LEDGER_FILE });
      const { rows } = await store.readAll();
      const legacyId = `lesson:${r.entry?.id ?? ''}`;
      if (r.entry?.id && !rows.some((row) => row.kind === 'candidate' && String(row.legacyId) === legacyId)) {
        await store.appendEvent(M.buildCandidate({
          rule: text,
          evidenceIds: [`lesson-write:${r.entry.id}`],
          scope: ['legacy'],
          source: 'lesson-write',
          confidence: r.entry?.confidence ?? 0.7,
          legacyId,
          at: Date.now(),
        }), { writer: 'capture' });
        ledgerNote = '（新账已记为候选）';
      }
    } catch { /* 新账失败不挡旧通道 */ }
    const extra = r.dropped ? `（旧的「${r.dropped.text.slice(0, 20)}」被放下了）` : '';
    return reply(`记下了（${r.entry?.track === 'doing' ? '做法' : '判断'}轨）。现在有 ${list.length} 条经验。${extra}${ledgerNote}`);
  }
);

server.tool(
  'lesson_list',
  '看看自己想过哪些事、学到过什么。',
  {},
  async () => {
    const L = await lessons();
    const list = L.load(LESSONS_FILE);
    if (!list.length) return reply('还没有攒下什么经验。');
    const label = { 'about-him': '关于他', 'about-me': '关于你自己', 'about-us': '关于你们' };
    const lines = list.slice().reverse().map((x) => {
      const v = x.verify ? `（怎么验：${x.verify}）` : '';
      return `[${x.track === 'doing' ? '做法' : '判断'}·${label[x.kind] ?? '关于你自己'}] ${x.text}${v}  [${x.id}]`;
    });
    return reply(`共 ${list.length} 条经验：\n${lines.join('\n')}`);
  }
);

server.tool(
  'cognition_save',
  '把你想明白的一件事沉淀成认知（跨事件都成立的判断，不是复述发生过什么）。和记忆的区别：记忆记「发生了什么」，这条记「我想明白了什么」。只收判断/规律，不收操作步骤和资料摘抄；同一主体只留一条有效判断，会合并更新。写的时候必须带 when（什么情况下成立）。',
  {
    text: z.string().describe('一句话，最多 300 字'),
    subject: z.string().optional().describe('这条判断说的是哪个主体（人/事/现象）；不填就从句首推'),
    kind: z.enum(['about-him', 'about-group', 'about-world', 'about-me', 'general']).optional().describe('这是关于谁的/什么的：他 / 群 / 世界（规律） / 你自己 / 其他（操作步骤不要写进认知）'),
    when: z.string().describe('什么情况下成立（适用条件），必填'),
    unless: z.string().optional().describe('什么情况下不成立（例外/反例），可省略'),
    supersedes: z.string().optional().describe('如果这条替换了以前的某条认知，填那条的 id（旧条标失效，不删）'),
    confidence: z.number().optional().describe('有多大把握 0~1；刚想明白的给 0.5 左右'),
    evidence: z.array(z.string()).optional().describe('凭什么想明白的：哪次查询、哪条经验，如 ["prts:get_stage_info easy_11-06"]'),
  },
  async ({ text, subject, kind, when, unless, supersedes, confidence, evidence }) => {
    const body = String(text ?? '').trim();
    if (!body) return fail('没写内容');
    if (body.length > COGNITION_MAX_CHARS) return fail(`太长了（${body.length} 字），一条认知最多 ${COGNITION_MAX_CHARS} 字`);
    if (kind === 'how-to') return fail('操作步骤不进认知：去 skill_save 存做法，或 memory_save 存资料。');
    if (!String(when ?? '').trim()) return fail('认知要写清什么时候成立（when）——不写条件，下次最容易用错地方。');
    const list = loadCognition();
    const now = new Date().toISOString();
    const conf = confidence == null ? 0.5 : Math.min(1, Math.max(0.05, Number(confidence) || 0.5));
    const subj = String(subject || cognitionSubject(body)).trim().slice(0, 24);
    const sup = String(supersedes ?? '').trim();
    const old = sup ? list.find((x) => String(x.id) === sup) : null;
    if (sup && !old) return fail(`没有这条认知：${sup}`);
    if (old) { old.invalidAt = now; old.supersededBy = 'replaced'; old.updatedAt = now; }
    const near = !old && list.find((x) => !x.invalidAt && !x.supersededAt
      && ((subj && String(x.subject || '') === subj) || overlap(x.text, body) >= COGNITION_DEDUPE));
    if (near) {
      if (body.length > String(near.text).length) { near.text = body; near.concept = body; }
      if (subj) near.subject = subj;
      if (when) near.when = String(when);
      if (unless) near.unless = String(unless);
      near.confidence = Math.max(Number(near.confidence) || 0.5, conf);
      near.updatedAt = now;
      saveCognition(list);
      return reply(`这条以前想过，更新了（现在 ${list.length} 条认知，把握 ${Math.round(near.confidence * 100)}%）。`);
    }
    const entry = {
      id: cognitionId(),
      at: now,
      text: body,
      concept: body,
      gist: '',
      subject: subj,
      kind: COGNITION_JUDGMENT_KINDS.includes(kind) ? kind : 'general',
      when: String(when ?? '').trim(),
      unless: String(unless ?? '').trim(),
      evidence: Array.isArray(evidence) ? evidence.map(String).filter(Boolean) : [],
      confidence: conf,
      source: 'she',
      tags: [],
    };
    if (old) old.supersededBy = entry.id;
    list.push(entry);
    saveCognition(list);
    return reply(`记下了（共 ${list.length} 条认知）。`);
  }
);

server.tool(
  'cognition_list',
  '看看你攒下的认知（想明白了什么）。可按类筛：关于他/群/世界/我自己/怎么做。',
  {
    kind: z.enum(['about-him', 'about-group', 'about-world', 'about-me', 'how-to', 'general']).optional().describe('只看某一类；不填就都看'),
    limit: z.number().optional().describe('最多几条，默认 10'),
  },
  async ({ kind, limit }) => {
    const all = loadCognition().filter((x) => !x.invalidAt && !(Number(x.down) >= 3));
    const list = kind ? all.filter((x) => (x.kind || 'general') === kind) : all;
    if (!list.length) return reply(kind ? `这一类还没有认知。` : '还没有攒下认知。');
    const n = Math.min(50, Math.max(1, Number(limit) || 10));
    const lines = list.slice(-n).reverse().map((x) => {
      const k = COGNITION_KIND_LABEL[x.kind] ?? '其他';
      const c = Number.isFinite(Number(x.confidence)) ? `（把握 ${Math.round(Number(x.confidence) * 100)}%）` : '';
      const w = x.when ? `｜适用：${x.when}` : '';
      return `[${k}] ${x.text}${w}${c}`;
    });
    return reply(`共 ${all.length} 条认知，显示最近 ${Math.min(n, list.length)} 条：\n${lines.join('\n')}`);
  }
);

server.tool(
  'lesson_drop',
  '某条经验不再成立了就放下它。',
  {
    id: z.string().describe('经验 id，lesson_list 里方括号里的那个'),
  },
  async ({ id }) => {
    const L = await lessons();
    const list = L.load(LESSONS_FILE);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return fail('没找到这条经验');
    const gone = list.splice(i, 1)[0];
    L.rewrite(list, LESSONS_FILE);
    return reply(`放下了：${gone.text}`);
  }
);

// ══════════════════════════════════════════════════════════════
// P0 · 技能库（Voyager 式可复用动作序列）+ 经验池（ExpeL 式成功/失败轨迹）
// 复用桥接侧已实现并测过的纯模块，避免两份实现。
// ══════════════════════════════════════════════════════════════
const BRIDGE_SRC = process.env.BRIDGE_SRC || bridgeSrcPath();
const SKILLS_FILE = process.env.SKILLS_FILE || statePath('skills.json');
const TRACES_DIR = process.env.TRACES_DIR || dataPath('traces');
let Skills = null, Traces = null;
try { Skills = await import(new URL('file://' + path.posix.join(BRIDGE_SRC, 'inori-skills.js')).href); } catch { /* 模块缺失则相关工具返回错误 */ }
try { Traces = await import(new URL('file://' + path.posix.join(BRIDGE_SRC, 'inori-traces.js')).href); } catch { /* 同上 */ }
// [LEARNING-ITEMS / PRACTICE / SKILL-DRAFTS] 她自己的学习闭环（纯模块复用桥接侧实现）
const LEARNING_ITEMS_FILE = process.env.LEARNING_ITEMS_FILE || statePath('learning-items.json');
const PRACTICE_FILE = process.env.PRACTICE_FILE || statePath('practice-sessions.jsonl');
const SKILL_DRAFTS_FILE = process.env.SKILL_DRAFTS_FILE || statePath('skill-drafts.json');
let LearningItems = null, Practice = null, SkillDrafts = null;
try { LearningItems = await import(new URL('file://' + path.posix.join(BRIDGE_SRC, 'inori-learning-items.js')).href); } catch { /* 同上 */ }
try { Practice = await import(new URL('file://' + path.posix.join(BRIDGE_SRC, 'inori-practice.js')).href); } catch { /* 同上 */ }
try { SkillDrafts = await import(new URL('file://' + path.posix.join(BRIDGE_SRC, 'inori-skill-drafts.js')).href); } catch { /* 同上 */ }

server.tool(
  'skill_save',
  '把"这种情况可以这样处理"记成一条技能。下次遇到类似的事，你能先翻出来照着做（可以改）。',
  {
    name: z.string().describe('技能名字，短一点，比如「商店只有预约时去官网装」'),
    desc: z.string().optional().describe('一句话说明这是什么情况、怎么做'),
    steps: z.array(z.string()).describe('步骤，一步一句，比如「打开应用商店」「搜名字」「看到预约按钮就停下」'),
    verify: z.string().optional().describe('怎么算做成了，比如「屏幕上出现开始游戏或打开」'),
    tags: z.array(z.string()).optional().describe('标签，比如 安卓 / 游戏 / 安装'),
  },
  async ({ name, desc, steps, verify, tags }) => {
    if (!Skills) return fail('技能库模块没加载上');
    try {
      let store = Skills.load(SKILLS_FILE);
      const r = Skills.upsert(store, { name, desc, steps, verify, tags });
      Skills.save(r.store, SKILLS_FILE);
      const ver = r.skill?.version || 1;
      return reply(r.created
        ? `学会了新技能「${r.skill.name}」v${ver}（共 ${r.store.items.length} 条技能）`
        : r.changed
          ? `更新了技能「${r.skill.name}」（v${r.fromVersion} → v${r.toVersion}；旧版保留）`
          : `技能没有变化：「${r.skill.name}」v${ver}`);
    } catch (e) { return fail(`存不下来：${e?.message ?? e}`); }
  }
);

server.tool(
  'skill_find',
  '遇到一件以前可能做过的事，先翻翻技能库：有就照着做，没有就现场试。',
  {
    query: z.string().describe('现在想干什么，比如「装个游戏」'),
    limit: z.number().optional().describe('最多给几条，默认 3'),
  },
  async ({ query, limit }) => {
    if (!Skills) return fail('技能库模块没加载上');
    const store = Skills.load(SKILLS_FILE);
    const hits = Skills.find(store, query, Number(limit) || 3);
    if (!hits.length) return reply('技能库里没有能用的，得自己想。');
    // [SKILL-ITER] 主动检索也算一次“注入”；知道 ≠ 做到，成败仍由 skill_record 单独记。
    try {
      for (const h of hits) Skills.noteInjected(store, h.skill.id);
      Skills.save(store, SKILLS_FILE);
    } catch { /* 统计失败不挡检索 */ }
    return reply(hits.map((h) => {
      const s = h.skill;
      return `【${s.name}】${s.desc || ''}\n  版本：v${s.version || 1}｜验证：${s.verifiedVersion ? `v${s.verifiedVersion}` : '未验证'}`
        + `\n  步骤：${(s.steps || []).join(' → ')}\n  成功判据：${s.verify || s.verifyHuman || '（没写）'}`
        + `\n  记录：注入 ${s.injected || 0} 次 / 尝试 ${s.attempts || 0} / 成功 ${s.success || 0} / 失败 ${s.fail || 0} / 掌握 ${s.mastery ?? 0} / 置信度 ${s.confidence ?? 0.5}  [${s.id}]`
        + (s.nextDrill ? `\n  下一步练：${s.nextDrill}` : '')
        + (s.degraded ? `\n  状态：已降级（${s.degradedReason || '连续失败'}；仍保留，失败史在 hints）` : (s.retired ? `\n  状态：已停用（${s.deprecatedReason || '失败太多'}）` : ''))
        + ((s.hints || []).length ? `\n  失败点：${(s.hints || []).slice(-2).join('；')}` : '');
    }).join('\n\n'));
  }
);

server.tool(
  'skill_record',
  '做完一件事后记一下：这条技能这次成了还是没成。失败会写进失败点、降低置信度，不会删除；连续失败只降级。',
  {
    id: z.string().describe('技能 id（skill_find 里方括号里的那个）'),
    ok: z.boolean().describe('这次成功了吗'),
    hint: z.string().optional().describe('没成的话卡在哪/为什么，写一句下次好改'),
    version: z.number().optional().describe('技能版本；不填默认当前版本'),
  },
  async ({ id, ok, hint, version }) => {
    if (!Skills) return fail('技能库模块没加载上');
    const store = Skills.load(SKILLS_FILE);
    const skill = (store.items || []).find((x) => x.id === id);
    if (!skill) return fail('没找到这条技能');
    // [SKILL-ITER] 版本不对说明她看的是旧版；不要拿旧版成绩写新版。
    if (version !== undefined && Number(version) !== Number(skill.version || 1)) {
      return fail(`这条技能已经是 v${skill.version || 1}，你记的是 v${version}；先 skill_find 看新版再记。`);
    }
    let finalOk = ok;
    let verifiedBy = '';
    let evidence = '';
    // [SKILL-TRUTH] 说“成了”不等于成了：有判据先机检；没判据只记 attempt。
    if (ok && String(skill.verify || '').trim()) {
      try {
        const V = await import(fileUrlOf(path.join(BRIDGE_SRC, 'inori-skill-verify.js')));
        const v = await V.checkVerify(skill.verify);
        if (v && v.ok !== null) {
          finalOk = !!v.ok;
          if (v.ok) { verifiedBy = 'verify'; evidence = String(v.evidence || '').slice(0, 300); }
          else hint = String(v.evidence || '判据没过').slice(0, 160);
        } else {
          // 判据写了但没法机检：不能算 verify，只能记 attempt。
          finalOk = null;
          hint = '判据没法机检：只记一次尝试；要算成功，把判据改成 文件:/网址:/命令:，或让他验收。';
        }
      } catch { /* 判据失败按没判据处理 */ }
    } else if (ok && !String(skill.verify || '').trim()) {
      finalOk = null;
      hint = '这条还没写判据：先只记一次尝试；要算成功，先把判据写成 文件:/网址:/命令:。';
    }
    const s = Skills.applyOutcome ? Skills.applyOutcome(store, id, { ok: finalOk, hint: hint || '', source: 'mcp', verifiedBy, evidence }) : Skills.recordResult(store, id, finalOk);
    if (!s) return fail('没找到这条技能');
    Skills.save(store, SKILLS_FILE);
    if (ok && finalOk === null) {
      return reply(`只记了一次尝试：${s.name} v${s.version || 1} 还没写判据，不能算成功。判据写成「文件:路径 / 网址:url / 命令:cmd」后可以用 skill_verify 验。`);
    }
    return reply(`记下了：${s.name} v${s.version || 1}｜注入 ${s.injected || 0} 次 / 尝试 ${s.attempts || 0} / 成功 ${s.success} / 失败 ${s.fail} / 掌握 ${s.mastery ?? 0} / 置信度 ${s.confidence ?? 0.5}${s.degraded ? '（已降级，仍保留）' : ''}${evidence ? `；判据：${evidence}` : ''}`);
  }
);

server.tool(
  'skill_list',
  '看看你的技能库：每条的名字、注入/成败、状态（正常或已停用）、判据。清理之前先看这个。',
  {
    status: z.enum(['all', 'active', 'retired']).optional().describe('只看哪一类，默认 all'),
  },
  async ({ status }) => {
    if (!Skills) return fail("技能库模块没加载上");
    const store = Skills.load(SKILLS_FILE);
    const mode = status || 'all';
    const items = (store.items || []).filter((s) => (mode === "all" ? true : mode === "retired" ? s.retired : !s.retired));
    if (!items.length) return reply("技能库里没有这一类的技能。");
    const merges = (Skills.suggestMerges ? Skills.suggestMerges(store) : []).slice(0, 5);
    return reply(items.map((s) => `${s.archived ? "已归档" : s.degraded ? "降级" : (s.retired ? "停用" : "正常")}｜${s.name}｜v${s.version || 1}｜验证 ${s.verifiedVersion ? `v${s.verifiedVersion}` : '未验证'}｜注入 ${s.injected || 0} / 尝试 ${s.attempts || 0} / 成功 ${s.success || 0} / 失败 ${s.fail || 0} / 掌握 ${s.mastery ?? 0} / 置信度 ${s.confidence ?? 0.5}｜判据：${String(s.verify || s.verifyHuman || "没写").slice(0, 60)}${s.nextDrill ? `｜下一步：${s.nextDrill}` : ''}  [${s.id}]` + ((s.hints || []).length ? `\n  失败点：${(s.hints || []).slice(-2).join('；')}` : '')).join('\n')
      + (merges.length ? '\n\n可能重复（只建议，不自动合并）：\n' + merges.map((m) => `- ${m.a.name} ↔ ${m.b.name}（相似度 ${m.similarity}）`).join('\n') : ''));
  }
);

server.tool(
  'skill_history',
  '看一条技能的版本历史：每一版的步骤、判据、成败和验证记录。改过几次、哪版更好，都在这里。',
  {
    id: z.string().describe('技能 id（skill_list / skill_find 里方括号里的那个）'),
  },
  async ({ id }) => {
    if (!Skills) return fail('技能库模块没加载上');
    const store = Skills.load(SKILLS_FILE);
    const h = Skills.history ? Skills.history(store, id) : null;
    if (!h) return fail('没找到这条技能');
    const lines = h.versions.map((v) => {
      const p = v.performance || {};
      return `- v${v.version}${v.version === h.currentVersion ? '（当前）' : ''}｜成功 ${p.success || 0} / 失败 ${p.fail || 0} / 尝试 ${p.attempts || 0} / 掌握 ${p.mastery ?? 0}`
        + `｜验证：${v.verifiedVersion ? `v${v.verifiedVersion}` : '未验证'}`
        + `｜判据：${String(v.verify || '没写').slice(0, 60)}`
        + (v.reason ? `｜原因：${v.reason}` : '')
        + (v.archivedAt ? `｜归档：${v.archivedAt}` : '');
    });
    return reply(`【${h.name}】当前 v${h.currentVersion}｜累计 成功 ${h.lifetime?.success || 0} / 失败 ${h.lifetime?.fail || 0} / 尝试 ${h.lifetime?.attempts || 0}\n${lines.join('\n')}`);
  }
);

server.tool(
  'skill_merge',
  '把两条重复技能合掉：source 归档，target 保留；不自动把两套步骤拼在一起。只在确认它们说的是同一件事时用。',
  {
    sourceId: z.string().describe('要归档的技能 id'),
    targetId: z.string().describe('要保留的技能 id'),
    reason: z.string().optional().describe('为什么算重复，写一句'),
  },
  async ({ sourceId, targetId, reason }) => {
    if (!Skills) return fail('技能库模块没加载上');
    const store = Skills.load(SKILLS_FILE);
    if (typeof Skills.merge !== 'function') return fail('技能库模块版本太旧：缺少 merge');
    const r = Skills.merge(store, sourceId, targetId);
    if (!r.ok) {
      const why = {
        'not-found': '没找到其中一条技能',
        'same-skill': 'source 和 target 是同一条',
        'source-archived': 'source 已经归档了',
        'target-archived': 'target 已经归档了',
      }[r.reason] || r.reason;
      return fail(`合不了：${why}`);
    }
    Skills.save(store, SKILLS_FILE);
    try {
      fs.appendFileSync(statePath('skills-archive.jsonl'), JSON.stringify({
        deletedAt: new Date().toISOString(),
        reason: `merge:${reason || ''}`,
        skill: r.source,
      }) + '\n', 'utf8');
    } catch { /* 归档失败不影响合并 */ }
    return reply(`合好了：${r.source.name} → ${r.target.name}（source 已归档；target 保留自己的步骤，已记录 mergedFrom）`);
  }
);

server.tool(
  'skill_rollback',
  '把一条技能的内容回到旧版本：不删除新版本，而是拿旧版内容生成一个新的当前版；旧版和新版都留在 history。',
  {
    id: z.string().describe('技能 id'),
    version: z.number().describe('要回到的版本号（skill_history 里的 vN）'),
  },
  async ({ id, version }) => {
    if (!Skills) return fail('技能库模块没加载上');
    const store = Skills.load(SKILLS_FILE);
    if (typeof Skills.rollback !== 'function') return fail('技能库模块版本太旧：缺少 rollback');
    const r = Skills.rollback(store, id, version);
    if (!r.ok) return fail(r.reason === 'version-not-found' ? '没找到这个版本' : '没找到这条技能');
    Skills.save(store, SKILLS_FILE);
    return reply(r.changed
      ? `回到了 v${r.restoredFrom} 的内容：${r.skill.name}（v${r.fromVersion} → v${r.toVersion}；不是删除，新版本仍保留）`
      : `${r.skill.name} 已经是 v${r.restoredFrom}，不用回滚`);
  }
);

server.tool(
  'skill_delete',
  '删掉一条错误/没用的技能。删之前会把它整条归档到 skills-archive.jsonl（失败史不丢，以后能翻）。成功过的技能要 force=true 才能删；只是「停用」不用删，skill_list 能看。',
  {
    id: z.string().describe('技能 id'),
    reason: z.string().optional().describe('为什么删（一两句）'),
    force: z.boolean().optional().describe('成功过的技能必须 force=true 才删'),
  },
  async ({ id, reason, force }) => {
    if (!Skills) return fail("技能库模块没加载上");
    const store = Skills.load(SKILLS_FILE);
    const s = (store.items || []).find((x) => x.id === id);
    if (!s) return fail("没找到这条技能");
    if ((Number(s.success) || 0) > 0 && force !== true) return fail(`「${s.name}」成功过 ${s.success} 次，删之前想清楚；确实要删就带 force=true。`);
    const removed = Skills.drop(store, id);
    if (!removed) return fail("没找到这条技能");
    Skills.save(store, SKILLS_FILE);
    try {
      const fs2 = await import("node:fs");
      const p = statePath("skills-archive.jsonl");
      fs2.appendFileSync(p, JSON.stringify({ deletedAt: new Date().toISOString(), reason: String(reason || ""), skill: removed }) + "\n", "utf8");
    } catch { /* 归档失败不影响删除；但会提示 */ }
    return reply(`删掉了「${removed.name}」（失败史已归档到 skills-archive.jsonl）。`);
  }
);

server.tool(
  'skill_edit',
  '改一条技能：判据写错了、步骤过时了都可以自己改。判据写成「文件:路径 / 网址:url / 命令:cmd」才能被 skill_verify 机检。',
  {
    id: z.string().describe('技能 id'),
    verify: z.string().optional().describe('新的成功判据（建议写成 文件:/网址:/命令:）'),
    desc: z.string().optional().describe('新的说明'),
    steps: z.array(z.string()).optional().describe('新的步骤'),
  },
  async ({ id, verify, desc, steps }) => {
    if (!Skills) return fail("技能库模块没加载上");
    const store = Skills.load(SKILLS_FILE);
    const s = store.items.find((x) => x.id === id);
    if (!s) return fail("没找到这条技能");
    const patch = {};
    if (verify !== undefined) patch.verify = verify;
    if (desc !== undefined) patch.desc = desc;
    if (Array.isArray(steps)) patch.steps = steps;
    if (typeof Skills.revise !== 'function') return fail('技能库模块版本太旧：缺少 revise');
    const r = Skills.revise(store, id, patch);
    if (!r.ok) return fail('没找到这条技能');
    Skills.save(store, SKILLS_FILE);
    return reply(r.changed
      ? `改好了：${r.skill.name}（v${r.fromVersion} → v${r.toVersion}；旧版保留在 history）${(r.skill.verify || r.skill.verifyHuman) ? `｜判据：${r.skill.verify || r.skill.verifyHuman}` : ''}`
      : `没有变化：${r.skill.name} 还是 v${r.version}`);
  }
);

server.tool(
  'skill_revise',
  '基于这次卡住/失败的地方改一版技能：生成新版本，旧版保留；不直接覆盖。只在有具体失败点或新做法时用。',
  {
    id: z.string().describe('技能 id'),
    reason: z.string().optional().describe('为什么改这一版，比如「上次卡在商店预约」'),
    desc: z.string().optional().describe('新的说明'),
    steps: z.array(z.string()).optional().describe('新的步骤'),
    verify: z.string().optional().describe('新的成功判据'),
  },
  async ({ id, reason, desc, steps, verify }) => {
    if (!Skills) return fail('技能库模块没加载上');
    const store = Skills.load(SKILLS_FILE);
    if (typeof Skills.revise !== 'function') return fail('技能库模块版本太旧：缺少 revise');
    const r = Skills.revise(store, id, {
      desc, steps, verify,
      reason: reason ? `revise:${reason}` : 'revise',
    });
    if (!r.ok) return fail(r.reason === 'not-found' ? '没找到这条技能' : `改不了：${r.reason}`);
    Skills.save(store, SKILLS_FILE);
    return reply(r.changed
      ? `改了一版：${r.skill.name}（v${r.fromVersion} → v${r.toVersion}；旧版保留）${reason ? `｜原因：${reason}` : ''}`
      : `没有变化：${r.skill.name} 还是 v${r.version}`);
  }
);

server.tool(
  'skill_verify',
  '做完一条技能后验一下：按它写的成功判据去机检（文件存在 / 网址能打开 / 命令 exit 0）。知道和做到的区别就在这一步——验证过了才算真的做成，结果会记到技能上。',
  {
    id: z.string().describe('技能 id（skill_find 里方括号里的那个）'),
  },
  async ({ id }) => {
    if (!Skills) return fail("技能库模块没加载上");
    const store = Skills.load(SKILLS_FILE);
    const s = store.items.find((x) => x.id === id);
    if (!s) return fail("没找到这条技能");
    let v = null;
    try {
      const V = await import(fileUrlOf(path.join(BRIDGE_SRC, 'inori-skill-verify.js')));
      v = await V.checkVerify(s.verify, { allowCommand: true, timeoutMs: 20000 });
    } catch (e) { return fail(`校验模块不可用：${e?.message ?? e}`); }
    if (!v || v.ok === null) {
      s.verifyNote = String(v?.evidence || '没写判据');
      Skills.save(store, SKILLS_FILE);
      return reply(`这条的判据没法机检：${s.verifyNote}。判定要写成「文件:路径 / 网址:url / 命令:cmd」。`);
    }
    // [SKILL-ITER] 验证结果必须回写当前版本：成功算 verified success，失败算 fail；旧版本不受影响。
    const outcome = Skills.applyOutcome
      ? Skills.applyOutcome(store, id, {
        ok: v.ok === true,
        hint: v.ok ? '' : String(v.evidence || '判据没过').slice(0, 160),
        source: 'verify',
        verifiedBy: v.ok ? 'verify' : '',
        evidence: v.ok ? String(v.evidence || '').slice(0, 300) : '',
      })
      : null;
    const cur = outcome || s;
    cur.verifyOk = !!v.ok;
    cur.verified = !!v.ok;
    cur.verifyNote = String(v.evidence || '');
    if (v.ok) {
      cur.verifiedVersion = Number(cur.version) || 1;
      cur.verifiedAt = new Date().toISOString();
    } else {
      cur.verifiedVersion = 0;
      cur.verifiedAt = '';
    }
    if (typeof Skills.ensureFields === 'function') Skills.ensureFields(cur);
    Skills.save(store, SKILLS_FILE);
    return reply(`${v.ok ? "验过了，真的做到了" : "验不过"}：${v.evidence}（${cur.name} v${cur.version || 1}；成功 ${cur.success || 0} / 失败 ${cur.fail || 0} / 掌握 ${cur.mastery ?? 0}）`);
  }
);

// ══════════════════════════════════════════════════════════════
// 学习闭环：学习项 / 练习 / 技能草稿（她自己决定学不学、练不练）
// ══════════════════════════════════════════════════════════════
server.tool(
  'learning_item',
  '你自己想学/想练的一件事。不是任务清单；想练就练，不想就 pause。一次只练一件。',
  {
    action: z.enum(['list', 'add', 'update']).describe('list=看 / add=新建 / update=改'),
    id: z.string().optional().describe('update 时必填'),
    title: z.string().optional().describe('想学/想练什么，一句话'),
    why: z.string().optional().describe('为什么想练（你自己的话）'),
    criterion: z.string().optional().describe('什么叫比上次好：一句可验证的话'),
    next: z.string().optional().describe('下一步练什么'),
    status: z.enum(['exploring', 'practicing', 'paused', 'done', 'dropped']).optional().describe('update 时用；done 必须给 evidence'),
    evidence: z.string().optional().describe('done 时必填：凭什么算学会了/练成了（文件/机检结果/他确认）'),
  },
  async ({ action, id, title, why, criterion, next, status, evidence }) => {
    if (!LearningItems) return fail('学习项模块没加载上');
    const items = LearningItems.load(LEARNING_ITEMS_FILE);
    if (action === 'list') {
      const act = items.filter((x) => ['exploring', 'practicing', 'paused'].includes(x.status));
      if (!act.length) return reply('还没有想学/想练的事。想学什么就 learning_item add。');
      return reply(act.map((x) => `- [${x.status}] ${x.title}${x.criterion ? `｜判据：${x.criterion}` : ''}${x.nextDrill ? `｜下一步：${x.nextDrill}` : ''}  [${x.id}]`).join('\n'));
    }
    if (action === 'add') {
      const r = LearningItems.create(items, { title: title || '', why: why || '', source: 'her', criterion: criterion || '', nextDrill: next || '' });
      if (!r.ok) return fail(r.reason === 'duplicate' ? '这件事已经在你的清单里了' : (r.reason.startsWith('active-limit') ? '手上想学的事太多了，先练完一件再记新的' : '没写标题'));
      // 带判据新建 = 她想开始练：直接进 practicing（同时只留一件）。
      if (String(criterion || '').trim()) LearningItems.update(items, r.item.id, { status: 'practicing' });
      LearningItems.save(items, LEARNING_ITEMS_FILE);
      return reply(`记下了：${r.item.title}。${criterion ? `开始练：${r.item.nextDrill || '先定下一步'}；判据：${criterion}` : '下一步想练什么？写 criterion 和 next 就能开始。'}`);
    }
    if (!id) return fail('update 要带 id');
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (why !== undefined) patch.why = why;
    if (criterion !== undefined) patch.criterion = criterion;
    if (next !== undefined) patch.nextDrill = next;
    if (status !== undefined) patch.status = status;
    if (evidence !== undefined) patch.evidence = evidence;
    const r = LearningItems.update(items, id, patch);
    if (!r.ok) {
      return fail(r.reason === 'criterion-required' ? '先写 criterion（什么叫比上次好），才能开始练'
        : r.reason === 'evidence-required' ? '说 done 要给证据（文件/机检结果/他确认）；没有就先别标完成'
          : '没找到这条学习项');
    }
    LearningItems.save(items, LEARNING_ITEMS_FILE);
    return reply(`改好了：${r.item.title}（${r.item.status}）`);
  }
);

server.tool(
  'practice_start',
  '开始练一次：只练一个动作、一个判据。先想清楚这次只改哪一处。',
  {
    itemId: z.string().describe('learning_item list 里的 id'),
    intention: z.string().describe('这次只练什么，一句话'),
    criterion: z.string().optional().describe('这次的判据（不填就用学习项的 criterion）'),
    before: z.string().optional().describe('练之前的图/文件路径（可选）'),
  },
  async ({ itemId, intention, criterion, before }) => {
    if (!LearningItems || !Practice) return fail('学习/练习模块没加载上');
    const items = LearningItems.load(LEARNING_ITEMS_FILE);
    const item = items.find((x) => x.id === String(itemId));
    if (!item) return fail('没找到这条学习项，先 learning_item list');
    const crit = String(criterion || item.criterion || '').trim();
    if (!crit) return fail('还没写判据：先 learning_item update 写 criterion（什么叫比上次好）');
    item.criterion = crit;
    for (const other of items) {
      if (other !== item && other.status === 'practicing') other.status = 'paused';
    }
    item.status = 'practicing';
    item.nextDrill = String(intention || item.nextDrill || '').slice(0, 160);
    item.lastPracticedAt = new Date().toISOString();
    item.attempts = Math.max(0, Number(item.attempts) || 0) + 1;
    LearningItems.save(items, LEARNING_ITEMS_FILE);
    const r = Practice.start({ itemId: item.id, intention, criterion: crit, before: before || '' }, PRACTICE_FILE);
    if (!r.ok) return fail('练习记录写不进去');
    return reply(`开始练：${item.title}\n这次只练：${intention}\n判据：${crit}\n练习 id：${r.session.id}`);
  }
);

server.tool(
  'practice_note',
  '练习中间补一句：做了什么、最明显的问题、下次只改哪一处。',
  {
    sessionId: z.string().describe('practice_start 给的练习 id'),
    attempt: z.string().optional().describe('这次实际做了什么'),
    oneFlaw: z.string().optional().describe('最明显的一处问题（要具体）'),
    oneChange: z.string().optional().describe('下次只改哪一处'),
  },
  async ({ sessionId, attempt, oneFlaw, oneChange }) => {
    if (!Practice) return fail('练习模块没加载上');
    const patch = {};
    if (attempt !== undefined) patch.attempt = attempt;
    if (oneFlaw !== undefined) patch.oneFlaw = oneFlaw;
    if (oneChange !== undefined) patch.oneChange = oneChange;
    const r = Practice.update(sessionId, patch, PRACTICE_FILE);
    if (!r.ok) return fail('没找到这次练习');
    return reply('记上了。练完用 practice_result 收尾。');
  }
);

server.tool(
  'practice_result',
  '给这次练习一个结论：过了 / 没过 / 没结论。没过就写一处问题和一处改动；过了就会生成技能草稿。',
  {
    sessionId: z.string().describe('practice_start 给的练习 id'),
    result: z.enum(['met', 'not_met', 'unknown']).describe('这次判据过了吗'),
    evidence: z.string().optional().describe('凭什么：一句机检结果/文件路径/他确认'),
    after: z.string().optional().describe('练完的图/文件路径（可选）'),
  },
  async ({ sessionId, result, evidence, after }) => {
    if (!LearningItems || !Practice || !SkillDrafts) return fail('学习模块没加载上');
    if (result === 'met' && !String(evidence || after || '').trim()) {
      return fail('说“过了”要给证据：一句机检结果、文件路径，或他明确说行。');
    }
    const sessions = Practice.load(PRACTICE_FILE);
    const session = sessions.find((x) => x.id === String(sessionId));
    if (!session) return fail('没找到这次练习');
    if (result === 'not_met' && (!String(session.oneFlaw || '').trim() || !String(session.oneChange || '').trim())) {
      return fail('没过要先写一处问题和一处改动（practice_note），下次才知道改哪。');
    }
    const r = Practice.update(sessionId, { result, evidence: evidence || '', after: after || '', finishedAt: new Date().toISOString() }, PRACTICE_FILE);
    if (!r.ok) return fail('练习结果写不进去');
    const items = LearningItems.load(LEARNING_ITEMS_FILE);
    const item = items.find((x) => x.id === session.itemId);
    let draftMsg = '';
    if (item) {
      item.evidence = (Array.isArray(item.evidence) ? item.evidence : []).concat([String(evidence || after || '').slice(0, 300)]).filter(Boolean).slice(-20);
      item.lastPracticedAt = new Date().toISOString();
      if (result === 'not_met') {
        item.nextDrill = String(session.oneChange || item.nextDrill || '').slice(0, 160);
        item.status = 'practicing';
      } else if (result === 'met') {
        item.status = 'done';
        // 生成技能草稿（不直接写进技能库；她可以改/收/拒）
        const ds = SkillDrafts.load(SKILL_DRAFTS_FILE);
        const d = SkillDrafts.create(ds, {
          name: item.title,
          desc: session.intention || item.why || '',
          steps: [session.intention, session.attempt, session.oneChange].filter(Boolean).map((s) => String(s).slice(0, 200)),
          verify: item.criterion,
          tags: ['practice'],
          learningItemId: item.id,
          evidence: evidence || after || '',
        });
        if (d.ok) {
          SkillDrafts.save(ds, SKILL_DRAFTS_FILE);
          draftMsg = `\n技能草稿：${d.draft.name}（skill_draft 里可以收/拒）`;
        }
        try {
          // [TRACE-BRIDGE] 验证过的练习进经验轨迹池（下次做同类事能翻到）。
          if (Traces) Traces.append({
            goal: `练：${item.title}`,
            result: 'success',
            steps: [session.intention, session.attempt, session.oneChange].filter(Boolean),
            note: `判据：${item.criterion}｜证据：${evidence || after || ''}`,
          }, { dir: TRACES_DIR });
        } catch { /* 轨迹失败不挡练习收尾 */ }
      }
      LearningItems.save(items, LEARNING_ITEMS_FILE);
    }
    return reply(`练习收尾：${result}${evidence ? `｜证据：${evidence}` : ''}${draftMsg}`);
  }
);

server.tool(
  'practice_list',
  '看她练过什么：最近的练习记录，按学习项过滤；只读，不评价。',
  {
    itemId: z.string().optional().describe('只看某个学习项的练习（可选）'),
    limit: z.number().int().min(1).max(50).optional().describe('最多几条，默认 10'),
  },
  async ({ itemId, limit }) => {
    if (!Practice) return fail('练习模块没加载上');
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    const rows = Practice.load(PRACTICE_FILE)
      .filter((x) => !itemId || x.itemId === String(itemId))
      .slice(-n)
      .reverse();
    if (!rows.length) return reply('还没有练习记录。想练就用 practice_start。');
    return reply(rows.map((x) => {
      const bits = [`${String(x.at || '').slice(0, 10)}｜${x.result}`];
      if (x.intention) bits.push(`练：${String(x.intention).slice(0, 40)}`);
      if (x.oneFlaw) bits.push(`问题：${String(x.oneFlaw).slice(0, 50)}`);
      if (x.oneChange) bits.push(`改：${String(x.oneChange).slice(0, 50)}`);
      return `- ${bits.join('｜')}`;
    }).join('\n'));
  }
);

server.tool(
  'skill_draft',
  '练习通过后生成的技能草稿：看看、收下或拒掉。收下才会进技能库。',
  {
    action: z.enum(['list', 'accept', 'reject']).describe('list=看 / accept=收下 / reject=拒掉'),
    id: z.string().optional().describe('accept/reject 时必填'),
  },
  async ({ action, id }) => {
    if (!SkillDrafts || !Skills) return fail('技能草稿模块没加载上');
    const drafts = SkillDrafts.load(SKILL_DRAFTS_FILE);
    if (action === 'list') {
      const p = SkillDrafts.pending(drafts);
      if (!p.length) return reply('没有待定的技能草稿。');
      return reply(p.map((d) => `- ${d.name}｜判据：${d.verify || '没写'}｜步骤：${(d.steps || []).join(' → ')}  [${d.id}]`).join('\n'));
    }
    if (!id) return fail('要带 id');
    if (action === 'reject') {
      const r = SkillDrafts.setStatus(drafts, id, 'rejected');
      if (!r.ok) return fail('没找到这条草稿');
      SkillDrafts.save(drafts, SKILL_DRAFTS_FILE);
      return reply(`拒掉了：${r.draft.name}`);
    }
    const d = (drafts || []).find((x) => x.id === String(id) && x.status === 'draft');
    if (!d) return fail('没找到待定的草稿');
    try {
      const store = Skills.load(SKILLS_FILE);
      const machineVerify = /^(命令|文件|网址):/.test(String(d.verify || ''));
      const r = Skills.upsert(store, {
        name: d.name, desc: d.desc, steps: d.steps.length ? d.steps : ['照这次练习的做法'],
        verify: machineVerify ? d.verify : '',
        verifyHuman: machineVerify ? '' : d.verify,
        tags: d.tags, learningItemId: d.learningItemId, nextDrill: '',
      });
      Skills.save(r.store, SKILLS_FILE);
      SkillDrafts.setStatus(drafts, id, 'accepted');
      SkillDrafts.save(drafts, SKILL_DRAFTS_FILE);
      return reply(`收下了：${d.name} v${r.skill?.version || 1}（技能库现在 ${r.store.items.length} 条）`);
    } catch (e) { return fail(`收不进去：${e?.message ?? e}`); }
  }
);

server.tool(
  'trace_log',
  '把一次尝试记进经验池（成没成都记，失败也是有用的）。以后遇到类似的事能查到自己以前怎么做的、错在哪。',
  {
    goal: z.string().describe('你想干什么'),
    result: z.enum(['success', 'fail']).describe('成了还是没成'),
    steps: z.array(z.string()).optional().describe('实际做了哪几步'),
    error: z.string().optional().describe('没成的话，卡在哪'),
    note: z.string().optional().describe('补一句你想记的'),
  },
  async ({ goal, result, steps, error, note }) => {
    if (!Traces) return fail('经验池模块没加载上');
    const r = Traces.append({ goal, result, steps, error, note }, { dir: TRACES_DIR });
    if (!r) return fail('写不进去');
    const st = Traces.stats({ dir: TRACES_DIR });
    return reply(`记下了（成功率 ${st.successRate == null ? '-' : Math.round(st.successRate * 100) + '%'}，共 ${st.total} 次）`);
  }
);

// [BROWSE] 逛帖子工具（独立模块，避免与其它编辑撞车）
await (await import('./browse-tool.js')).registerBrowseTool(server, { z, reply, fail });

// [FEED] 帖子流（RSS / RSSHub 路由，与 browse_posts 分工：这个是「流」，那个是「打开一页」）
await (await import('./feed-tool.js')).registerFeedTool(server, { z, reply, fail });

// [EXPE] lesson_vote
server.tool(
  'lesson_vote',
  '给一条经验记分：后来被印证/被引用过投 up，后来被现实纠正投 down。判断轨没有机器判据，就靠这两票记；错的经验连续被投 down 会自动消失，所以不必担心记错。',
  {
    id: z.string().describe('经验 id，可用 lesson_list 查看'),
    dir: z.enum(['up', 'down']).describe('up=后来被印证/引用；down=后来被纠正'),
  },
  async ({ id, dir }) => {
    const L = await lessons();
    const list = L.load(LESSONS_FILE);
    const r = L.vote(list, id, dir);
    if (!r.ok) return fail(r.reason === 'not-found' ? '没有这条经验（用 lesson_list 看看 id）' : '方向只能是 up 或 down');
    L.rewrite(list, LESSONS_FILE);
    // [LEDGER-SYNC] 同一票写新账 verdict（只对迁移账里存在且仍可表决的条目）；失败不挡旧通道。
    let ledgerNote = '';
    try {
      const M = await lessonsLedger();
      const store = M.createLessonsLedger({ file: LESSONS_LEDGER_FILE });
      const { rows } = await store.readAll();
      const plan = M.verdictEventForLegacy(rows, `lesson:${id}`, {
        polarity: dir === 'up' ? 'pos' : 'neg',
        evidenceId: `lesson-vote:${id}`,
        reason: 'lesson_vote',
        at: Date.now(),
      });
      if (plan.ok) {
        await store.appendEvent(plan.event, { writer: 'verify' });
        ledgerNote = `；新账已记（${plan.lessonId}）`;
      } else if (plan.reason === 'expired') {
        ledgerNote = '；新账里这条已过期，票只留在旧账';
      } else if (plan.reason === 'contradicted') {
        ledgerNote = '；新账里这条待裁决，票只留在旧账';
      }
    } catch { /* 新账失败不挡旧通道 */ }
    if (r.removed) return reply(`这条已经不再成立了，我把它放下了。${ledgerNote}`);
    return reply(`记下了：${dir === 'up' ? '确实对' : '其实不对'}。现在置信度 ${r.entry.confidence}。${ledgerNote}`);
  }
);

await server.connect(new StdioServerTransport());
