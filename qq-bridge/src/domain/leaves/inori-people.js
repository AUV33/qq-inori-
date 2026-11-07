// inori-people.js · 全局人物索引：把散在各群档案里的人归一成「一个 userId = 一个人」
//
// 定位（三层里的哪层）：
//   L1 群成员档案（inori-groupmembers）是**按群**学出来的自动统计，同一个人在两个群
//      是两张互不相认的卡 → 本模块做**归一**：aliases（每个群叫什么）、合并发言量、
//      跨群可见性。
//   L2 她的**主动印象**（qq_memory 的 memberImpression）原来只写进会话状态，会话一重置
//      就丢 → 本模块给她一个**持久家**（按 userId 存，跨会话、跨群）。
//   L3 行为差异（「按人应答指引」）：从 L1 已有统计字段**确定性推导**出对这个人该怎么
//      接话（软措辞，不编人设）——渲染侧拼进 renderMembers。
//
// 纪律（跟 groupmembers 一致）：
//   - 全部确定性（统计聚合 / 规则推导），不靠模型自觉；含义层软措辞（多半/估计/还没熟）。
//   - 不造东西：某个字段推不出就不出指引，宁可空着。
//   - 她自己的印象（impressions）是 LLM 产出，这里只负责**存与召回**，不负责评判。
//
// 存储：data/state/people.json，结构 { "<userId>": {...} }
//   { id, owner, aliases: { groupKey: 昵称 }, groups: [groupKey],
//     count/firstSeen/lastSeen（跨群合并，只读 group-members 汇总，不自己再学一遍）,
//     notes: [去重合并，上限 8],
//     impressions: [ { at, from, text } 上限 12，她主动记的，新的顶旧的 ] }

import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';
// 原子写（tmp+rename）：整文件覆盖写在进程崩溃时不能留下半截 JSON（见 group-members 同修）。
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { stateDataPath, bridgePath } from '../shared/project-paths.js';
// [IDENTITY-RESOLVE] 昵称 → personId → UIN 的兜底：改昵称不再失联、历史别名也能认。
import { parseIdentityLedger, foldIdentity, resolveAlias, personIdFor } from '../social/identity-map.mjs';
// [PEOPLE-VAULT] G11/G12：people.json 可选静态加密（QQ_INORI_PEOPLE_ENCRYPT=1）；读端自动识别信封。
import { readPeopleFile, peopleWritePayload, isPeopleEnvelope } from '../shared/people-vault.mjs';

const FILE = stateDataPath('people.json');
// owner 标记只用于"永不淘汰"；不要在代码里写死某个 QQ 号。
// 优先环境变量 QQ_INORI_OWNER_QQ，其次 config.json 的 ownerQQ。
function readOwnerId() {
  const env = String(process.env.QQ_INORI_OWNER_QQ || '').trim();
  if (env) return env;
  try {
    const raw = fs.readFileSync(bridgePath('config.json'), 'utf8').replace(/^\uFEFF/, '');
    return String(JSON.parse(raw)?.ownerQQ ?? '').trim();
  } catch { return ''; }
}
const OWNER_ID = readOwnerId();
const MAX_NOTES = 8;
const MAX_IMPRESSIONS = 12;
const MAX_PEOPLE = 500; // 顶层人物条目上限（按 lastSeen 修剪，owner 永不淘汰）

const IDENTITY_LEDGER = stateDataPath('mind', 'identity-map.jsonl');
let identityCache = { mtimeMs: -1, folded: null };

/** 身份账只读缓存（按 mtime 失效）：找不到人时才付这份 IO。 */
function identityFolded() {
  try {
    const stat = fs.statSync(IDENTITY_LEDGER);
    if (identityCache.folded && identityCache.mtimeMs === stat.mtimeMs) return identityCache.folded;
    const folded = foldIdentity(parseIdentityLedger(fs.readFileSync(IDENTITY_LEDGER, 'utf8')).rows, { now: Date.now() });
    identityCache = { mtimeMs: stat.mtimeMs, folded };
    return folded;
  } catch { return null; }
}

/** [PEOPLE-FIX] 昵称 → 人物 id：精确 id → 当前别名 → 身份账历史别名（personId 反查 UIN）。 */
function resolveKey(db, key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (db[k]) return k;
  for (const [id, p] of Object.entries(db)) {
    if (p && p.aliases && Object.values(p.aliases).includes(k)) return id;
  }
  // 身份账兜底：别名摘要 → personId；再按 personIdFor('qq', id) 找回 people.json 的 UIN 键。
  const folded = identityFolded();
  const hit = folded ? resolveAlias(folded, k) : null;
  if (hit && !hit.ambiguous && hit.personId) {
    for (const id of Object.keys(db)) {
      if (/^\d{5,12}$/.test(id) && personIdFor('qq', id) === hit.personId) return id;
    }
  }
  return k;
}

function read() {
  try { return readPeopleFile(FILE) || {}; } catch (error) {
    try { console.error('[people] 读取失败（加密/损坏）:', error?.message ?? error); } catch { /* best-effort */ }
    return {};
  }
}
function write(db) {
  try {
    // 无界增长修剪：删掉长期不出现的陌生人（owner 与有任何她印象的人保留）
    const ids = Object.keys(db);
    if (ids.length > MAX_PEOPLE) {
      ids.sort((a, b) => Number(db[b]?.lastSeen || 0) - Number(db[a]?.lastSeen || 0));
      for (const drop of ids.slice(MAX_PEOPLE)) {
        if (db[drop]?.owner || (db[drop]?.impressions || []).length > 0) continue;
        delete db[drop];
      }
    }
    // 粘性加密：文件已是信封就继续写信封，避免开关误关导致明文降级。
    let forceEnvelope = false;
    try { forceEnvelope = isPeopleEnvelope(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* 新文件/损坏按开关 */ }
    // [AUDIT-FIX] 已有密文时，写之前必须确认“当前密钥能解开它”；
    // 否则密钥轮换/配错会让读返回 {}，再用错误密钥把空库覆盖上去——同样是不可逆丢失。
    if (forceEnvelope) {
      readPeopleFile(FILE);
    }
    const payload = peopleWritePayload(db, { force: forceEnvelope, createKey: !forceEnvelope });
    const r = writeJsonDocument(FILE, payload, { source: 'bridge/people' });
    if (!r.ok) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      atomicWriteJson(FILE, payload);
    }
  } catch (error) {
    try { console.error('[people] 人物库写入失败:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-people.js:76'); }
  }
}

function ensure(db, userId) {
  const id = String(userId || '');
  if (!id) return null;
  if (!db[id]) {
    db[id] = { id, owner: !!OWNER_ID && id === OWNER_ID, aliases: {}, groups: [], count: 0, firstSeen: 0, lastSeen: 0, notes: [], impressions: [] };
  }
  return db[id];
}

/**
 * 从一条群成员档案同步进人物索引（noteMember 写完档案后调用，传该群该人的最新字段）。
 * 只合并元信息，不重新学——统计本身在 group-members.json 里。
 */
export function upsertFromGroup(key, m) {
  if (!m || !m.id) return null;
  const db = read();
  const p = ensure(db, m.id);
  if (!p) return null;
  const gk = String(key || '');
  if (gk.startsWith('group:') && !p.groups.includes(gk)) p.groups.push(gk);
  if (m.name && m.name !== '我') p.aliases[gk || 'unknown'] = String(m.name).slice(0, 24);
  // 合并计数：拿该群档案里的 count 当这个人的总发言量下界（同群重复 upsert 时取最大）
  const perGroup = p.perGroup || (p.perGroup = {});
  perGroup[gk] = Math.max(Number(perGroup[gk] || 0), Number(m.count || 0));
  p.count = Object.values(perGroup).reduce((a, b) => a + Number(b || 0), 0);
  p.firstSeen = Math.min(Number(p.firstSeen || 0) || Number(m.firstSeen || 0), Number(m.firstSeen || 0)) || Number(m.firstSeen || 0);
  p.lastSeen = Math.max(Number(p.lastSeen || 0), Number(m.lastSeen || 0));
  // notes 去重合并（同群重复的由 group-members 已去重，这里只做跨群去重：完全相同/包含就跳过）
  const notes = p.notes;
  for (const t of Array.isArray(m.notes) ? m.notes : []) {
    const s = String(t || '').trim();
    if (!s || notes.length >= MAX_NOTES) continue;
    if (notes.some((x) => x === s || x.includes(s) || s.includes(x))) continue;
    notes.push(s);
  }
  db[m.id] = p;
  write(db);
  return p;
}

/** 全量重建：桥接启动时调一次（长期没消息也能把索引对齐）。
 *  保留已有条目的 impressions（她记过的不能因重建而丢）与昵称兜底 key。 */
export function rebuild() {
  let gm;
  try { gm = readPeopleFile(stateDataPath('group-members.json')) || {}; } catch { gm = {}; }
  const old = read();
  const db = {};
  for (const key of Object.keys(gm)) {
    for (const m of Object.values(gm[key]?.members ?? {})) {
      upsertInto(db, key, m);
    }
  }
  // 回填旧条目的持久印象 + 昵称兜底指向
  for (const [k, x] of Object.entries(old)) {
    if (!x || !Array.isArray(x.impressions) || !x.impressions.length) continue;
    const target = ensure(db, k);
    if (target) {
      target.impressions = x.impressions;
      if (k !== target.id) db[k] = target; // 昵称 key 指向真实条目
    }
  }
  write(db);
  return Object.keys(db).length;
}

// upsertFromGroup 走的是「读盘合并」，rebuild 为了少读盘走内存版：
function upsertInto(db, key, m) {
  if (!m || !m.id) return null;
  const p = ensure(db, m.id);
  if (!p) return null;
  const gk = String(key || '');
  if (gk.startsWith('group:') && !p.groups.includes(gk)) p.groups.push(gk);
  if (m.name && m.name !== '我') p.aliases[gk || 'unknown'] = String(m.name).slice(0, 24);
  const perGroup = p.perGroup || (p.perGroup = {});
  perGroup[gk] = Math.max(Number(perGroup[gk] || 0), Number(m.count || 0));
  p.count = Object.values(perGroup).reduce((a, b) => a + Number(b || 0), 0);
  p.firstSeen = Math.min(Number(p.firstSeen || 0) || Number(m.firstSeen || 0), Number(m.firstSeen || 0)) || Number(m.firstSeen || 0);
  p.lastSeen = Math.max(Number(p.lastSeen || 0), Number(m.lastSeen || 0));
  const notes = p.notes;
  for (const t of Array.isArray(m.notes) ? m.notes : []) {
    const s = String(t || '').trim();
    if (!s || notes.length >= MAX_NOTES) continue;
    if (notes.some((x) => x === s || x.includes(s) || s.includes(x))) continue;
    notes.push(s);
  }
  return p;
}

/**
 * L2：她的主动印象持久化。target 可能是 userId 或昵称——昵称由调用方解析后传 userId；
 * 解析不出来的（新成员还没档案）就用昵称兜底当 key（记不住也不丢，人一旦有档案就迁过来）。
 */
export function noteImpression(userIdOrName, { text = '', from = '', at = Date.now() } = {}) {
  const key = String(userIdOrName || '').trim();
  if (!key || !String(text || '').trim()) return null;
  const db = read();
  // [NICK-MERGE] 旧写法先 ensure(db, key) 再判断 `!p.aliases`：ensure 总会建出 aliases={}，
  // 条件恒假，昵称兜底的印象永远合并不进 userId（渲染按 userId 读，等于丢了）。
  // 现在先查别名归属再决定挂到哪个 key；只对非 QQ 号（昵称）做归并，避免误伤新用户。
  const aliasOwner = /^[1-9]\d*$/.test(key)
    ? null
    : Object.entries(db).find(([, x]) => x && Object.values(x.aliases ?? {}).includes(key));
  const stale = aliasOwner ? db[key] : null;
  const p = aliasOwner ? ensure(db, aliasOwner[0]) : ensure(db, key);
  if (aliasOwner) {
    p.aliases['__nick'] = key;
    if (key !== p.id) delete db[key]; // 不把同一对象再挂到昵称 key 下（JSON 会存两份）
  }
  const imps = p.impressions || (p.impressions = []);
  // 迁移昵称 key 下已有的旧印象（去重后并入），不静默丢历史。
  if (stale && Array.isArray(stale.impressions)) {
    for (const im of stale.impressions) {
      if (im && !imps.some((x) => x.at === im.at && x.text === im.text)) imps.push(im);
    }
  }
  imps.push({ at, from: String(from || '').slice(0, 24), text: String(text).slice(0, 200) });
  while (imps.length > MAX_IMPRESSIONS) imps.shift();
  db[p.id] = p;
  write(db);
  return p;
}

/** 读一个人的持久印象（最近 n 条） */
export function impressionsOf(userIdOrName, n = 3) {
  const db = read();
  const p = db[resolveKey(db, userIdOrName)];
  return (p?.impressions ?? []).slice(-n);
}

/**
 * 删一条持久印象（她显式要求删才来：精确匹配 text，或全删一个人的）。
 * 返回删掉的条数。
 */
export function unnoteImpression(userIdOrName, textMatch) {
  const key = String(userIdOrName || '').trim();
  const db = read();
  const p = db[resolveKey(db, key)];
  if (!p || !Array.isArray(p.impressions) || !p.impressions.length) return 0;
  const t = String(textMatch || '').trim();
  const before = p.impressions.length;
  p.impressions = p.impressions.filter((x) => {
    if (!x) return false;
    if (!t) return false; // 无匹配文本 = 全删这个人
    return x.text !== t && !(x.text.includes(t) || t.includes(x.text));
  });
  // 昵称兜底 key 若还挂着一条 id 不一致的旧条目，删掉它——同一条印象不该在两个 key 下各存一份。
  if (db[key] && db[key].id && db[key].id !== key) delete db[key];
  write(db);
  return before - p.impressions.length;
}

/**
 * L3：按人应答指引——从该群档案的已有统计字段推导，一人一行，软措辞。
 * 宁缺勿滥：每条都有统计门槛，推不出就不出。m = 该群该人的档案对象。
 * opts.isBot：名单里的「人」是另一个 AI（见 peer-bots.mjs）——别推「可以熟一点」，
 * 那是把人机客套当社交（2026-10-29 群里「人机互吹」的成因之一）。
 */
export function adviceFor(m, opts = {}) {
  const out = [];
  if (opts && opts.isBot) return ['它是另一个 bot（AI），不是人：别跟它客套，客套话可以不接'];
  const r = m.resp || {};
  const askTot = Number(r.ask || 0);
  if (askTot >= 3) {
    const c = (k) => Number(r[`ask_${k}`] || 0);
    if (c('rebut') / askTot >= 0.4) out.push('他爱反问，跟他说话别在一个点上站住，接快一点就撤');
    else if (c('dodge') / askTot >= 0.4) out.push('他爱岔开话题，他躲了也别追着要，自己换个话头');
    else if (c('answer') / askTot >= 0.4) out.push('他爱把事说清楚，问题可以直接丢给他');
  }
  const cmTot = Number(r.cm || 0);
  if (cmTot >= 3) {
    const c = (k) => Number(r[`cm_${k}`] || 0);
    if (c('assess') / cmTot >= 0.4) out.push('有人遇事先找他讲道理，跟他说麻烦可以直球');
    else if (c('laugh') / cmTot >= 0.4) out.push('他习惯用哈哈接负面情绪，气氛绷的时候别跟着加码');
  }
  if (Number(m.repliesToMe || 0) >= 2) out.push('他常接你的话，可以熟一点');
  const v = m.voice || {};
  if (v.n && v.n >= 5) {
    if ((v.q || 0) / v.n >= 0.3) out.push('他爱问，直接答就行');
    else if ((v.laugh || 0) / v.n >= 0.15) out.push('他偏氛围型，可以接个表情跟一下');
  }
  if (Number(m.count || 0) <= 2) out.push('跟他还没熟，别太自来熟');
  return out.slice(0, 2); // 每人最多两行，提示面不放行军包
}

/**
 * 渲染一个人（该群视角）的「跨群 + 持久印象 + 指引」三行。
 * @param key 当前群 key（group:xxx）
 * @param m 该群该人档案（topMembers 的元素）
 */
export function renderPersonLines(key, m, opts = {}) {
  const isBot = !!opts?.isBot;
  const lines = [];
  const p = read()[String(m.id)];
  // [PERM-BY-PERSON] QQ 号也是「这个人是谁」的一部分：档案里直接带上，主人单独标出来
  lines.push(`  · QQ：${String(m.id || '?')}${p?.owner ? '（这是主人）' : ''}${isBot ? '（另一个 bot，不是人）' : ''}`);
  if (p) {
    // 跨群：他在别的群还有别的称呼
    const others = Object.entries(p.aliases ?? {}).filter(([gk]) => gk !== key && gk !== 'unknown');
    if (others.length) {
      lines.push(`  · 他在另一个群也出现过（那边叫「${others.map(([, n]) => n).join('」/「')}」）——是同一个人，印象跟着人走`);
    }
    // 档案：她学到的事（一行一条，最近 3 条）
    const prof = renderProfileLine(m);
    if (prof) lines.push(prof);
    // 持久印象（她主动记的）
    // [IMP-DEDUPE] 同一句反复记会平铺成好几行；按归一化文本去重，只留最新 2 条，旧的折叠成一句。
    const imps = (p.impressions ?? []).filter((x) => x && x.text);
    const seenImp = new Set();
    const uniq = [];
    for (let i = imps.length - 1; i >= 0 && uniq.length < 2; i -= 1) {
      const k = String(imps[i].text).replace(/[\s，。；：、,.!?！？]/g, '').slice(0, 24);
      if (!k || seenImp.has(k)) continue;
      seenImp.add(k);
      uniq.unshift(imps[i]);
    }
    for (const im of uniq) {
      lines.push(`  · 你印象里：${im.text}` + (im.from ? `（记于 ${im.from}）` : ''));
    }
    if (imps.length > uniq.length) {
      lines.push(`  · 关于他你还记过 ${imps.length - uniq.length} 条旧印象——想改就写新的，新的顶旧的，旧的留着当过去`);
    }
    // [SHIFT] 他和档案不一样的地方（桥接只记事实，改不改看她）
    if (m.shift && Array.isArray(m.shift.kinds) && m.shift.kinds.length
      && Date.now() - Number(m.shift.at || 0) < 3 * 24 * 3600 * 1000) {
      lines.push(`  · 有点不一样：${m.shift.kinds.join('；')}（原话：${m.shift.text}）——想改对他的印象就改，不想改就当没看见`);
    }
    if (p.owner && p.groups.length >= 2) lines.push('  · 他是老板——对他的看法走专门通道，这里不重复揣测');
  }
  const advice = adviceFor(m, { isBot });
  for (const a of advice) lines.push(`  · 指引：${a}`);
  return lines;
}

/**
 * 档案（profile）：她**从对话里学到**的关于这个人的事——自由文本，一行一条。
 * 年龄/性别/外号/性格/习惯…不拆字段：她怎么写就怎么存（「他好像 22、男的、外号『多余』、爱抬杠」就是一行）。
 * 写入方只有她（经 qq_person 工具），桥接不自动猜：没学到的就是没有，不造。
 * 合并：append + 包含去重，上限 8 行（新的顶旧的；档案跟着人走，跨群跨会话持久）。
 */
export function noteProfile(userIdOrName, { text = '', from = '' } = {}) {
  const key = String(userIdOrName || '').trim();
  const t = String(text || '').trim();
  if (!key || !t) return null;
  const db = read();
  // 昵称 → 已有档案的 QQ；找不到就按传入 key 建（通常是 QQ 号）
  let pid = key;
  if (!/^\d+$/.test(key)) {
    const hit = Object.entries(db).find(([, x]) => Object.values(x.aliases ?? {}).includes(key));
    if (hit) pid = hit[0];
  }
  const p = ensure(db, pid);
  const pr = p.profile || (p.profile = {});
  const lines = pr.lines || (pr.lines = []);
  if (!lines.some((x) => x === t || x.includes(t) || t.includes(x))) lines.push(t);
  while (lines.length > 8) lines.shift();
  pr.updatedAt = Date.now();
  if (from) pr.from = String(from).slice(0, 24);
  db[p.id] = p;
  write(db);
  return p;
}

/** 删一档（她显式要求才来；textMatch 空 = 全删这个人的档案） */
export function unnoteProfile(userIdOrName, textMatch) {
  const key = String(userIdOrName || '').trim();
  const db = read();
  const p = db[resolveKey(db, key)];
  if (!p?.profile?.lines) return 0;
  const t = String(textMatch || '').trim();
  const before = p.profile.lines.length;
  p.profile.lines = t ? p.profile.lines.filter((x) => x !== t && !(x.includes(t) || t.includes(x))) : [];
  write(db);
  return before - p.profile.lines.length;
}

/** 档案行（渲染进提示）：她学到的事，取最近 3 条；没有就返空，不造 */
export function renderProfileLine(m) {
  const p = read()[String(m.id || '')];
  const lines = p?.profile?.lines ?? [];
  if (!lines.length) return '';
  return `  · 档案：${lines.slice(-3).join('；')}`;
}

/** 供测试：直接看一个人的完整索引 */
export function personOf(userIdOrName) {
  const db = read();
  return db[resolveKey(db, userIdOrName)] || null;
}

/**
 * 这个人在各个群里的名字（aliases 值 + 当前昵称）。用于"按人翻记忆"：
 * 记忆库里的群摘要没有 userId，只有「昵称：内容」，得拿名字去对。
 * @param {string} userIdOrName
 * @returns {string[]} 去重后的名字（不含空串/纯数字）
 */
export function aliasesOf(userIdOrName) {
  const db = read();
  const p = db[resolveKey(db, userIdOrName)];
  const names = new Set();
  if (p) {
    for (const n of Object.values(p.aliases || {})) if (n && !/^\d+$/.test(String(n))) names.add(String(n));
  }
  const k = String(userIdOrName || '').trim();
  if (k && !/^\d+$/.test(k) && !db[k]?.aliases) names.add(k);
  return [...names];
}

