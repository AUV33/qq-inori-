// inori-browse.js · 她的冲浪记录：她上网看过什么（确定性记录，不做语义解读）
//
// 用途：她在 own-life 里上网搜/读时，桥接把「看过什么」确定性记一笔；
// 到下一个自主时间开始前，把这些记录沉淀成一条 kind=browse 的记忆（原样，不替她总结）。
// 纪律：只记「工具+查询/网址」，不评判、不设指标（学不学、记不记归她）。

import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from '../shared/project-paths.js';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

export const DEFAULTS = {
  file: stateDataPath('browse-log.json'),
  maxEntries: 200,
  dedupeMs: 30 * 60 * 1000,
};

function oneLine(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// [WANDER] 区分「查词」和「闲逛」：搜索引擎/查词类 fetch 不算逛；浏览站/帖子流/非搜索 URL 才算
const LOOKUP_URL = /(bing\.com|sogou\.com|so\.com|baidu\.com|google\.|duckduckgo|zhihu\.com\/search|bilibili\.com\/search)/i;

export function isLookupEntry(e) {
  const tool = String(e?.tool ?? '');
  const arg = String(e?.arg ?? '');
  if (/web_search/i.test(tool)) return true;
  if (/web_fetch/i.test(tool) && LOOKUP_URL.test(arg)) return true;
  return false;
}

export function wanderEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && !isLookupEntry(e) && e.tool);
}

/** 最近一次「真逛」的时间戳（毫秒），没有返回 null */
export function lastWanderAt(entries) {
  let last = null;
  for (const e of wanderEntries(entries)) {
    const t = Number(e.at);
    if (Number.isFinite(t) && (last == null || t > last)) last = t;
  }
  return last;
}

/** 独处时递一句事实+许可：多久没自己逛了；不想逛就算了 */
export function renderWanderNudge(entries, now = Date.now(), { minDays = 2 } = {}) {
  const last = lastWanderAt(entries);
  if (last == null) return '你还没自己上网逛过——想去看就去看（热搜、游戏资讯、视频、帖子都行），不想逛就待着，没人等你汇报。';
  const days = Math.floor((now - last) / (24 * 3600 * 1000));
  if (days < minDays) return null;
  return `你上次自己上网逛是 ${days} 天前——想再去就去，不想逛就算了，没人等你汇报。`;
}

// [BROWSE-HUMAN] JSON 解析（失败返回 null，不抛）
function tryJson(text) { try { return JSON.parse(String(text ?? '').trim()); } catch { return null; } }

/** 工具入参 → 人话：{"query":"vmok 是什么"} → "vmok 是什么"；取不到就取第一个引号片段 */
export function humanizeBrowseArg(arg) {
  const raw = String(arg ?? '').trim();
  if (!raw) return '';
  const j = tryJson(raw);
  if (j && typeof j === 'object') {
    for (const k of ['query', 'keyword', 'q', 'word', 'url', 'text', 'title']) {
      const v = j[k];
      if (typeof v === 'string' && v.trim()) return oneLine(v, 80);
    }
  }
  // 支持「」以及中英文引号：她/工具常把查询包在书名号里
  const m = raw.match(/["“「]([^"”」]{2,80})["”」]/);
  return oneLine(m ? m[1] : raw, 80);
}

/** 工具结果 → 人话：空结果=没找到；整块 JSON 取不到字段 = 空串（别再塞 JSON 进记忆） */
export function humanizeBrowseHead(head) {
  const raw = String(head ?? '').trim();
  if (!raw) return '';
  const j = tryJson(raw);
  if (j && typeof j === 'object') {
    if (Array.isArray(j.results) && !j.results.length) return '没找到';
    const first = Array.isArray(j.results) ? (j.results[0] || {}) : {};
    for (const v of [j.title, j.answer, j.summary, j.text, first.title, first.snippet, first.text]) {
      if (typeof v === 'string' && v.trim()) return oneLine(v, 50);
    }
    return '';
  }
  if (/^[{[]/.test(raw)) return ''; // 半截/认不出的 JSON，宁可不要也别塞进记忆
  return oneLine(raw.replace(/^(看完了|搜到|找到)\s*[：:]?\s*/, ''), 50);
}
export function newBrowseEntry({ at = Date.now(), tool = '', arg = '', head = '', ok = true } = {}) {
  // 记录时就归一：arg/head 存人话，后面 digest 与记忆才不会变成 JSON 垃圾
  return { at, tool: oneLine(tool, 60), arg: humanizeBrowseArg(arg), head: humanizeBrowseHead(head), ok: ok === false ? false : true };
}

/** 记一笔浏览（同工具+同一查询 30 分钟内去重；超上限先进先出）。 */
export function noteBrowse(store, entry, opts = {}) {
  const base = store && Array.isArray(store.entries) ? store : { entries: [] };
  const dedupeMs = Number(opts.dedupeMs) || DEFAULTS.dedupeMs;
  const maxEntries = Number(opts.maxEntries) || DEFAULTS.maxEntries;
  const e = entry || {};
  const dup = base.entries.some((x) => x && x.tool === e.tool && x.arg === e.arg && Math.abs(Number(x.at || 0) - Number(e.at || 0)) < dedupeMs);
  if (dup) return base;
  const entries = base.entries.concat([e]).slice(-maxEntries);
  return { ...base, entries };
}

export function pendingBrowse(store) {
  return (Array.isArray(store?.entries) ? store.entries : []).filter((e) => e && !e.sedimentedAt && !e.missedAt);
}

/** [ACQ-GATE] 真的取到内容了吗：head 为空 = 只发起了请求，没拿到东西，不能算"看过"。 */
export function hasContent(entry) {
  return Boolean(String(entry?.head ?? '').trim());
}

export function renderBrowseDigest(entries, opts = {}) {
  const maxItems = Math.max(1, Number(opts.maxItems) || 6);
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!list.length) return '';
  const items = list.slice(-maxItems).map((e) => {
    const arg = humanizeBrowseArg(e.arg);
    const head = humanizeBrowseHead(e.head);
    if (!arg && !head) return '';
    const what = arg ? `「${arg}」` : '';
    const kind = /fetch/i.test(String(e.tool)) ? '读' : (/browse|feed|video/i.test(String(e.tool)) ? '看' : '搜');
    return `${kind}${what}${head ? `：${head}` : ''}`;
  }).filter(Boolean);
  if (!items.length) return '';
  let joined = items.join('、');
  if (joined.length > 300) joined = joined.slice(-300); // 一条记忆别写 1400 字
  return `今天网上看过：${joined}。`;
}

export function markSedimented(store, entries, at = Date.now()) {
  const base = store && Array.isArray(store.entries) ? store : { entries: [] };
  const wanted = new Set((Array.isArray(entries) ? entries : []).filter(Boolean).map((e) => `${e.at}|${e.tool}|${e.arg}`));
  const next = base.entries.map((e) => (e && wanted.has(`${e.at}|${e.tool}|${e.arg}`) ? { ...e, sedimentedAt: at } : e));
  return { ...base, entries: next };
}

/**
 * [ACQ-GATE] 空结果不沉淀：有 head 的才标 sedimented，没 head 的标 missed（只记"没取到"）。
 * 返回 { store, sedimented, missed }，调用方据此决定要不要写记忆。
 */
export function markBrowseOutcome(store, entries, at = Date.now()) {
  const base = store && Array.isArray(store.entries) ? store : { entries: [] };
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const sedimentKeys = new Set(list.filter(hasContent).map((e) => `${e.at}|${e.tool}|${e.arg}`));
  const missedKeys = new Set(list.filter((e) => !hasContent(e)).map((e) => `${e.at}|${e.tool}|${e.arg}`));
  let sedimented = 0;
  let missed = 0;
  const next = base.entries.map((e) => {
    const key = `${e.at}|${e.tool}|${e.arg}`;
    if (sedimentKeys.has(key)) { sedimented += 1; return { ...e, sedimentedAt: at }; }
    if (missedKeys.has(key)) { missed += 1; return { ...e, missedAt: at, missReason: 'empty' }; }
    return e;
  });
  return { store: { ...base, entries: next }, sedimented, missed };
}

export function loadBrowse(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j?.entries) ? j.entries : []);
    return { entries: list.filter((e) => e && typeof e === 'object') };
  } catch { return { entries: [] }; }
}

export function saveBrowse(file = DEFAULTS.file, store = { entries: [] }) {
  try {
    const entries = (Array.isArray(store?.entries) ? store.entries : []).slice(-DEFAULTS.maxEntries);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 1), 'utf8');
    renameWithRetry(tmp, file);
    return true;
  } catch { return false; }
}
