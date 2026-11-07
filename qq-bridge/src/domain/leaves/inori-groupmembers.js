// inori-groupmembers.js · 群里每个人：发言统计 + 语气画像 + 场景应答倾向
//
// 三个学习层（全部确定性统计，不靠模型自觉）：
//   1. 基础档案：发言次数 / 发图 / 接她的话 / 听来的事实（notes）
//   2. 语气（voice）：句长、提问率、感叹、表情、哈哈、爱带哪个语气词 —— 学的是「这个人说话什么调性」
//   3. 场景应答（resp）：别人提问 / 抱怨时，他怎么接（认真答 / 反问 / 打哈哈 / 岔开）—— 学的是「他面对场景的应对方式」
//
// 规则：
//   - 只学别人的话。isSelf 直接跳过，她自己的表达不进学习侧（既定底线）。
//   - 含义层一律软措辞（多半 / 估计 / 型）：是统计猜出来的倾向，不是事实。
//   - 注入时告诉她「用来理解」；2026-10-25 owner 定案：语气词/说法也允许学，不再设「别模仿腔」的禁令——
//     学不学、学哪个全凭她判断（脚手架递事实+许可，不做家长）。
//
// 存储：data/state/group-members.json，结构 { "group:xxx": { members: { userId: {...} } } }

import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import path from 'node:path';
// 原子写（tmp+rename）：整文件覆盖写在进程崩溃时不能留下半截 JSON（下一读会降级成空库并写回清空档案）。
import { writeJsonDocument } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';
import { similarity } from './inori-facts.js';
import { cleanMemberName } from './inori-memory-clean.js';
import { upsertFromGroup, renderPersonLines } from './inori-people.js';
import { stateDataPath } from '../shared/project-paths.js';
import { readPeopleFile, peopleWritePayloadForFile, isPeopleFileEncrypted } from '../shared/people-vault.mjs';

const FILE = stateDataPath('group-members.json');
const MAX_NOTES = 5;
const MAX_MEMBERS = 200; // 每群成员档案上限（按最近活跃修剪，见 write）
const WINDOW_MS = 15 * 60 * 1000; // 场景-应答观察窗口：15 分钟内算「在回应刚才那个场景」

// 场景分类词表（宁缺毋滥，判不准就不记）
const LAUGH = /哈哈+|嘿嘿+|呵呵|233+|草(?!泥马)|笑死|笑不活|www+|lol|xd/i;
const NEG = /好烦|烦死|烦了|烦人|太累|好累|累死|累趴|难受|无语|气死|气人|气到|服了|受不了|什么玩意|什么东西|离谱|崩了|卡死|急死|急的|急得|讨厌|哭|崩溃|炸了|裂开/;
const QMARK = /为什么|为啥|怎么|为何|干嘛|干啥|^几|^哪|^多少|^是不是|^能不能|^可不可以|吗$|[?？]\s*$/;
// 表情：unicode 表情区 + [xxx] 方括号表情（ASCII 源码，避免宽字符写盘损坏）
const EMOJI = new RegExp('[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF]|\\[[^\\]]{1,8}\\]', 'u');
const PARTS = ['吧', '啊', '嘛', '呀', '哦', '哈', '呢', '啦', '哇', '呗'];

const scenes = new Map(); // group key -> 滚动场景日志（内存态；重启后窗口清空，累计计数仍在文件里）

function read() {
  try {
    // [G11] 与 people 共用信封：明文可读，密文用默认 key-file 解；解不开按空库处理（写端会拒绝覆盖）。
    return readPeopleFile(FILE) || {};
  } catch { return {}; }
}
function write(db) {
  try {
    // 无界增长修剪：每群成员条目只保留最近活跃的前 MAX_MEMBERS 个（按 lastSeen），
    // 群成员流动性（新群友/退群）不能让档案文件无限膨胀。
    for (const k of Object.keys(db)) {
      const g = db[k];
      if (!g || typeof g.members !== 'object' || !g.members) continue;
      const ids = Object.keys(g.members);
      if (ids.length > MAX_MEMBERS) {
        ids.sort((a, b) => Number(g.members[b]?.lastSeen || 0) - Number(g.members[a]?.lastSeen || 0));
        for (const drop of ids.slice(MAX_MEMBERS)) delete g.members[drop];
      }
    }
    const encrypted = isPeopleFileEncrypted(FILE);
    let payload;
    try {
      payload = peopleWritePayloadForFile(FILE, db);
    } catch (error) {
      // 密文 + 密钥不可用：宁可这一轮不写，也不能用明文/空库覆盖。
      if (encrypted) { console.error('[groupmembers] 加密库写入失败:', error?.message ?? error); return; }
      payload = db;
    }
    const r = writeJsonDocument(FILE, payload, { source: 'bridge/group-members' });
    if (!r.ok) {
      if (encrypted) { console.error('[groupmembers] 加密库锁等待失败，本轮不写'); return; }
      // 锁等待超时的兜底：还是写（非原子但保证不丢），宁可半截也不要静默丢一轮
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      atomicWriteJson(FILE, payload);
    }
  } catch (error) {
    try { console.error('[groupmembers] 群成员库写入失败:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-groupmembers.js:65'); }
  }
}

function ensureMember(g, id) {
  if (!g.members[id]) {
    g.members[id] = { id, name: '', count: 0, media: 0, repliesToMe: 0, firstSeen: 0, lastSeen: 0, lastText: '', notes: [] };
  }
  return g.members[id];
}

/** 这条消息属于什么场景（laugh / complaint / question / topic / 判不准=null） */
function classifyScene(t) {
  const s = String(t || '').trim();
  if (!s) return null;
  if (LAUGH.test(s) && s.length <= 14) return 'laugh';
  if (NEG.test(s)) return 'complaint';
  if (QMARK.test(s)) return 'question';
  if (s.length >= 12) return 'topic';
  return null;
}

/** 语气特征累计（v.n / chars / q / ex / em / laugh / p） */
function noteVoice(m, text) {
  const v = m.voice || (m.voice = {});
  const s = String(text || '').trim();
  v.n = (v.n || 0) + 1;
  v.chars = (v.chars || 0) + s.length;
  if (s.length <= 4) v.short = (v.short || 0) + 1;
  if (QMARK.test(s)) v.q = (v.q || 0) + 1;
  if (/[!！]/.test(s)) v.ex = (v.ex || 0) + 1;
  if (EMOJI.test(s)) v.em = (v.em || 0) + 1;
  if (LAUGH.test(s)) v.laugh = (v.laugh || 0) + 1;
  const p = v.p || (v.p = {});
  for (const pt of PARTS) {
    const hit = s.match(new RegExp(pt, 'g'));
    if (hit) p[pt] = (p[pt] || 0) + hit.length;
  }
}

/** 话题重合度（去虚词后的字集合），用来判断「他接的是这个话题，还是岔开了」 */
function topicOverlap(a, b) {
  const STOP = new Set('的了呢吧吗啊哈么啥哦呀啦哇呗被把和与还有很就都太不'.split(''));
  const charsOf = (s) => {
    const set = new Set();
    for (const ch of String(s || '')) if (/[\p{L}\p{N}]/u.test(ch) && !STOP.has(ch)) set.add(ch);
    return set;
  };
  const A = charsOf(a);
  const B = charsOf(b);
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  if (!s.size) return 0;
  let c = 0;
  for (const g of s) if (l.has(g)) c++;
  return c / s.size;
}

/**
 * [SHIFT] 这条消息是不是和「他平时」不一样（纯函数，可单测）。
 * 只看与档案的偏差，不下结论、不评价人；由调用方决定要不要把「想改印象就改」递给她。
 * @param {object} m 成员档案（注意：调用前 count 已 +1、repliesToMe 已 +1）
 * @param {string} text 这条消息
 * @param {{quoteTargetIsSelf?:boolean, at?:number}} opts
 * @returns {string[]} 命中的事实（最多 3 条）
 */
export function detectMemberShift(m = {}, text = '', { quoteTargetIsSelf = false, at = Date.now() } = {}) {
  const prevCount = Math.max(0, Number(m.count || 0) - 1);
  const vn = Number(m.voice?.n || 0);
  const avg = vn > 0 ? Number(m.voice?.chars || 0) / vn : 0;
  const len = [...String(text || '').trim()].length;
  const kinds = [];
  const firstReply = quoteTargetIsSelf && Number(m.repliesToMe || 0) === 1;
  if (firstReply) kinds.push('第一次回你');
  // 第一次回你本身就是大事，别再用句长去补两条噪音
  if (!firstReply && prevCount >= 10 && avg >= 3 && len >= 6 && len > avg * 3) {
    kinds.push(`说话比平时长很多（${len} 字，平时 ${Math.round(avg)} 字）`);
  } else if (!firstReply && prevCount >= 10 && avg >= 8 && len > 0 && len * 4 < avg && len <= 3) {
    kinds.push('突然只说几个字');
  }
  if (prevCount > 0 && m.lastSeenBefore && Number(at) - Number(m.lastSeenBefore) > 7 * 24 * 3600 * 1000) {
    kinds.push('很久没出现，又来了');
  }
  return kinds.slice(0, 3);
}

/** 记一条群成员发言。facts：已按第三人称改写好的「他…」事实（去重后最多留 5 条） */
export function noteMember(key, { userId = '', name = '', isSelf = false, hasMedia = false, quoteTargetIsSelf = false, text = '', at = Date.now(), facts = [] } = {}) {
  if (!String(key).startsWith('group:')) return null;
  if (!userId || isSelf) return null; // 她自己的话不进学习侧
  const db = read();
  const g = db[key] || (db[key] = { members: {} });
  const id = String(userId);
  const m = ensureMember(g, id);
  // [NAME-CLEAN] 彩色昵称的控制码/配色码不进档案；清洗后再截断（先截会把可读名字切掉）
  if (name && name !== '我') m.name = cleanMemberName(name, { max: 24 });
  m.count = Number(m.count || 0) + 1;
  if (!m.firstSeen) m.firstSeen = at;
  m.lastSeen = at;
  if (hasMedia) m.media = Number(m.media || 0) + 1;
  if (quoteTargetIsSelf) m.repliesToMe = Number(m.repliesToMe || 0) + 1;
  if (text) m.lastText = String(text).slice(0, 60);
  for (const f of Array.isArray(facts) ? facts : []) {
    const t = String(f || '').slice(0, 80);
    if (!t) continue;
    const notes = Array.isArray(m.notes) ? m.notes : (m.notes = []);
    if (notes.length >= MAX_NOTES) continue;
    if (notes.some((x) => similarity(x, t) >= 0.5)) continue;
    notes.push(t);
  }
  const s = String(text || '').trim();
  if (s) noteVoice(m, s);
  // [SHIFT] 「他今天有点不一样」：只记和档案不符的事实（第一次回你 / 说话比平时长很多 / 很久没出现），
  // 不评价人——给她一个「想改印象就改」的由头，改不改由她。
  try {
    const kinds = detectMemberShift(m, s, { quoteTargetIsSelf, at });
    if (kinds.length) m.shift = { kinds: kinds.slice(0, 3), text: s.slice(0, 40), at };
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-groupmembers.js:181'); }
  m.lastSeenBefore = at;
  // 场景日志：本群滚动窗口
  const sc = classifyScene(s);
  let gScenes = scenes.get(key);
  if (!gScenes) { gScenes = []; scenes.set(key, gScenes); }
  if (sc === 'question' || sc === 'complaint') gScenes.push({ userId: id, type: sc, text: s, at });
  // 应答归因：这条消息点名了 Q（Q≠P）且 Q 刚发生过提问/抱怨场景 → 记 P 的应对方式
  if (s) {
    const names = Object.values(g.members).filter((x) => x.id !== id && String(x.name || '').length >= 2 && x.name !== '我');
    for (const q of names) {
      if (!q.name || !s.includes(q.name)) continue;
      const qs = [...gScenes].reverse().find((x) => x.userId === q.id && (x.type === 'question' || x.type === 'complaint') && at - x.at <= WINDOW_MS);
      if (!qs) continue;
      const rel = topicOverlap(s, qs.text);
      let beh;
      if (LAUGH.test(s)) beh = 'laugh';
      else if (QMARK.test(s)) beh = 'rebut';
      else if (s.length >= 8 && rel >= 0.15) beh = qs.type === 'question' ? 'answer' : 'assess';
      else beh = 'dodge';
      const r = m.resp || (m.resp = {});
      const base = qs.type === 'question' ? 'ask' : 'cm';
      r[base] = (r[base] || 0) + 1;
      r[`${base}_${beh}`] = (r[`${base}_${beh}`] || 0) + 1;
      break;
    }
  }
  const cutoff = at - WINDOW_MS;
  for (let i = gScenes.length - 1; i >= 0; i--) if (gScenes[i].at < cutoff) gScenes.splice(i, 1);
  db[key] = g;
  write(db);
  upsertFromGroup(key, m); // 同步进全局人物索引（跨群归一 + 她的持久印象之家）
  return m;
}

export function topMembers(key, n = 5) {
  const g = read()[key];
  if (!g || !g.members) return [];
  return Object.values(g.members)
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, n);
}

/** 昵称 → 群成员档案（她记印象时给的 target 是昵称，人物索引要按 userId 存） */
export function memberNickLookup(key, nick) {
  const g = read()[key];
  const t = String(nick || '').trim();
  if (!g?.members || t.length < 2) return null;
  const list = Object.values(g.members);
  const hit = (m) => {
    const name = String(m.name || '');
    return !!name && (name === t || name.includes(t) || (t.length >= 2 && t.includes(name)));
  };
  // 全等优先，其次「包含」按发言量排（长昵称可能被截断/她记的是简称）
  const exact = list.find((m) => String(m.name || '').trim() === t);
  if (exact) return exact;
  const fuzzy = list.filter(hit).sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
  return fuzzy[0] || null;
}

/** 印象标签（规则，不编） */
export function memberTags(m) {
  const t = [];
  if (Number(m.repliesToMe || 0) >= 2) t.push('常接你的话');
  if (Number(m.media || 0) >= 3) t.push('爱发图');
  if (Number(m.count || 0) >= 20) t.push('话多');
  if (Number(m.count || 0) <= 2) t.push('新人');
  return t;
}

/** 语气画像：样本 ≥5 条才出，只给「调性」两个词 */
function voiceLine(m) {
  const v = m.voice || {};
  if (!v.n || v.n < 5) return '';
  const out = [];
  if (v.chars / v.n <= 8) out.push('短句型');
  if ((v.q || 0) / v.n >= 0.3) out.push('老提问');
  else if ((v.ex || 0) / v.n >= 0.25) out.push('感叹多');
  if ((v.laugh || 0) / v.n >= 0.15) out.push('氛围组');
  const top = Object.entries(v.p || {}).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] / v.n >= 0.2) out.push(`爱带「${top[0]}」`);
  if (!out.length) return '';
  return `语气${out.slice(0, 2).join('、')}`;
}

/** 场景应答倾向：某类场景 ≥3 次且主导应对 ≥40% 才出；含义是猜的，软措辞 */
function respLine(m) {
  const r = m.resp || {};
  const out = [];
  const total = r.ask || 0;
  if (total >= 3) {
    const c = (k) => r[`ask_${k}`] || 0;
    let beh = 'answer';
    let n = c('answer');
    for (const k of ['rebut', 'laugh', 'dodge']) if (c(k) > n) { beh = k; n = c(k); }
    const H = {
      rebut: `被问时（${total} 次）多半反问回去——爱互动不爱下结论`,
      answer: `被问时（${total} 次）多半认真答——爱把事说清楚`,
      laugh: `被问时（${total} 次）多半打哈哈——估计是避冲突型`,
      dodge: `被问时（${total} 次）常岔开话题——估计不想接`,
    };
    if (n / total >= 0.4) out.push(H[beh]);
  }
  const tot2 = r.cm || 0;
  if (tot2 >= 3) {
    const c = (k) => r[`cm_${k}`] || 0;
    let beh = 'assess';
    let n = c('assess');
    for (const k of ['laugh', 'rebut', 'dodge']) if (c(k) > n) { beh = k; n = c(k); }
    const H = {
      laugh: '有人抱怨时多半跟着哈哈（合拍型）',
      assess: '有人抱怨时多半安慰或讲道理（直球或解题型）',
      rebut: '有人抱怨时爱反问（爱调侃）',
      dodge: '有人抱怨时容易把话题带开（估计不想碰负面的事）',
    };
    if (n / tot2 >= 0.4) out.push(H[beh]);
  }
  return out.join('；');
}

/** 渲染给她的「这个群里的人」提示 */
// [ON-DEMAND] focusIds：本轮真正在说话的人。给了就只渲染这些人，不再把全群档案倒一遍。
// [PEER-BOT] botIds：config.socialV2.knownBots——名单里的人其实是别的 AI，别按「人」去熟络。
export function renderMembers(key, n = 5, ownerId = '', { focusIds = [], botIds = [] } = {}) {
  const focus = new Set((Array.isArray(focusIds) ? focusIds : []).map((x) => String(x)));
  const bots = new Set((Array.isArray(botIds) ? botIds : []).map((x) => String(x)));
  let list = topMembers(key, focus.size ? 200 : n);
  if (focus.size) {
    // [FOCUS-ORDER] 按"谁最近在说话"的顺序认人：focusIds 由调用方按最近→较早排好，
    // 这里保持顺序，别被 topMembers 的发言量排序盖掉（否则刚说话的人可能被漏掉）。
    const byId = new Map(list.map((m) => [String(m.id ?? m.userId ?? ''), m]));
    list = [...focus].map((id) => byId.get(id)).filter(Boolean).slice(0, n);
  }
  if (!list.length) return '';
  const parts = list.map((m) => {
    const isBot = bots.has(String(m.id));
    const tags = memberTags(m);
    const notes = Array.isArray(m.notes) ? m.notes : [];
    const note = notes.length ? `；知道他事：${notes.slice(-2).join('；')}` : '';
    const extra = [voiceLine(m), respLine(m)].filter(Boolean).join('；');
    const ownerMark = ownerId && String(m.id) === String(ownerId) ? '，主人' : '';
    const head = `${m.name || m.id}（QQ ${m.id}${ownerMark}${isBot ? '，另一个 bot' : ''}｜发言 ${m.count} 次${tags.length ? '，' + tags.join('、') : ''}${note}${extra ? '；' + extra : ''}）`;
    // 按人三层：跨群归一 + 她学到的档案 + 她记的印象 + 统计推的应答指引（推不出不出）
    const lines = renderPersonLines(key, m, { isBot });
    return lines.length ? `${head}\n${lines.join('\n')}` : head;
  });
  return `【这个群里的人】${parts.join('\n')}\n（说话前先认人：「档案」是你自己学到的，可以用、也可以纠正（qq_person 工具）；「你印象里」是你记下的；「指引」是统计推的（多半/估计）——主要用来理解他、决定怎么接；看中了谁的说法或腔调，想学就学，标准只有一个：放在自己嘴里自不自然；指引和你判断冲突时听你的判断。）`;
}
