// identity-map.mjs · 宪章 §5.9 / G11：统一身份层（platform × externalId ↔ personId）
//
// 干什么：把「QQ UIN / B站 mid / Qzone / 手机」归并到稳定 personId；支持别名归一、合并与解析。
//   身份是关系账本的物理基础——认错人，关系就全错。
// 为什么：现状 people.json 按 UIN、social-graph 按昵称清洗键，两套身份空间永不相交；
//   改昵称失联、共昵称误并；跨平台是孤岛。
// 隐私：账本只存 sha256 摘要（externalIdHash / aliasHash），不落 QQ 号、昵称或手机号明文。
//   注意：低熵 QQ 号的哈希可被离线枚举，这是"脱敏"不是"匿名"；密钥化哈希留 S6b。
// 输入输出：纯构造/折叠 + append-only 存储；foldIdentity(events) → people/anomalies。
// 失败模式：坏事件进 anomalies；未知 person 的 alias/merge 不伪造。
// 不做什么：不改 people.json / social-graph（S6b 才切换读端）；不跑模糊匹配（先精确摘要匹配）。

import crypto from 'node:crypto';
import path from 'node:path';
import { appendJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

export const IDENTITY_VERSION = 1;
export const IDENTITY_LEDGER_FILE = 'identity-map.jsonl';
export const PLATFORMS = Object.freeze(['qq', 'bili', 'qzone', 'phone', 'wechat', 'unknown']);
const HASH_LEN = 16;

export class IdentityError extends Error {
  constructor(message, code = 'identity') {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

const sha = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

export function normalizePlatform(platform) {
  const p = String(platform ?? '').trim().toLowerCase();
  return PLATFORMS.includes(p) ? p : 'unknown';
}

export function hashExternalId(platform, externalId) {
  const id = String(externalId ?? '').trim();
  if (!id) throw new IdentityError('externalId 不能为空');
  return sha(`identity:v1:${normalizePlatform(platform)}:${id}`).slice(0, HASH_LEN);
}

export function normalizeAlias(alias) {
  return String(alias ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function hashAlias(alias) {
  const normalized = normalizeAlias(alias);
  if (!normalized) return '';
  return sha(`alias:v1:${normalized}`).slice(0, HASH_LEN);
}

export function personIdFor(platform, externalId) {
  const hash = hashExternalId(platform, externalId);
  return `p_${sha(`person:v1:${normalizePlatform(platform)}:${hash}`).slice(0, 12)}`;
}

export function buildLink({ personId, platform, externalId, label = '', at = Date.now() } = {}) {
  const platformNorm = normalizePlatform(platform);
  const hash = hashExternalId(platformNorm, externalId);
  const pid = personId || personIdFor(platformNorm, externalId);
  if (!/^p_[0-9a-f]{12}$/.test(pid)) throw new IdentityError('personId 非法');
  return {
    v: IDENTITY_VERSION, kind: 'link', personId: pid, platform: platformNorm,
    externalIdHash: hash, label: String(label ?? '').slice(0, 40), at: Number(at),
  };
}

export function buildAlias({ personId, alias, at = Date.now() } = {}) {
  const aliasHash = hashAlias(alias);
  if (!aliasHash) throw new IdentityError('alias 不能为空');
  if (!/^p_[0-9a-f]{12}$/.test(String(personId ?? ''))) throw new IdentityError('personId 非法');
  return { v: IDENTITY_VERSION, kind: 'alias', personId: String(personId), aliasHash, at: Number(at) };
}

export function buildMerge({ from, into, reason = '', at = Date.now() } = {}) {
  for (const id of [from, into]) if (!/^p_[0-9a-f]{12}$/.test(String(id ?? ''))) throw new IdentityError('personId 非法');
  if (from === into) throw new IdentityError('不能合并到自己');
  return { v: IDENTITY_VERSION, kind: 'merge', from: String(from), into: String(into), reason: String(reason ?? '').slice(0, 80), at: Number(at) };
}

/** 折叠：link 建人、alias 挂别名、merge 迁移并标记 mergedInto。 */
export function foldIdentity(events, { now = Date.now() } = {}) {
  const people = new Map();
  const linkOwner = new Map(); // platform:hash -> personId
  const anomalies = [];

  const ensure = (personId, at) => {
    if (!people.has(personId)) {
      people.set(personId, {
        personId, links: [], aliases: [], labels: [],
        createdAt: Number(at) || Number(now), updatedAt: Number(at) || Number(now), mergedInto: null,
      });
    }
    return people.get(personId);
  };
  const canonicalId = (personId) => {
    let id = personId;
    let guard = 0;
    while (people.get(id)?.mergedInto && guard < 50) { id = people.get(id).mergedInto; guard += 1; }
    return id;
  };

  const rows = Array.isArray(events) ? events : [];
  const MAX_ALIASES = 50;

  const applyLink = (row) => {
    if (!/^p_[0-9a-f]{12}$/.test(String(row.personId ?? '')) || !row.externalIdHash) { anomalies.push({ id: row.personId, reason: 'bad-link' }); return; }
    const key = `${normalizePlatform(row.platform)}:${row.externalIdHash}`;
    const pid = canonicalId(row.personId);
    const owner = linkOwner.get(key);
    if (owner && owner !== pid) { anomalies.push({ id: row.personId, reason: `link-conflict:${key}` }); return; }
    if (owner === pid) { anomalies.push({ id: row.personId, reason: 'duplicate-link' }); return; }
    const person = ensure(pid, row.at);
    person.links.push({ platform: normalizePlatform(row.platform), hash: String(row.externalIdHash), label: String(row.label ?? '').slice(0, 40) });
    person.updatedAt = Number(row.at) || person.updatedAt;
    if (row.label) person.labels = [...new Set([...person.labels, String(row.label).slice(0, 40)])].slice(-5);
    linkOwner.set(key, pid);
  };

  const applyMerge = (row) => {
    const fromId = canonicalId(String(row.from));
    const intoId = canonicalId(String(row.into));
    const from = people.get(fromId);
    const into = people.get(intoId);
    if (!from || !into || fromId === intoId) { anomalies.push({ id: row.from, reason: 'bad-merge' }); return; }
    from.links.forEach((link) => {
      if (!into.links.some((x) => x.platform === link.platform && x.hash === link.hash)) into.links.push(link);
      linkOwner.set(`${link.platform}:${link.hash}`, into.personId);
    });
    const mergedAliases = [...new Set([...into.aliases, ...from.aliases])];
    if (mergedAliases.length > MAX_ALIASES) anomalies.push({ id: into.personId, reason: 'alias-overflow' });
    into.aliases = mergedAliases.slice(0, MAX_ALIASES);
    into.labels = [...new Set([...into.labels, ...from.labels])].slice(-5);
    from.links = [];
    from.aliases = [];
    from.mergedInto = into.personId;
    from.updatedAt = Number(row.at) || from.updatedAt;
    into.updatedAt = Number(row.at) || into.updatedAt;
  };

  const applyAlias = (row) => {
    const person = people.get(canonicalId(String(row.personId ?? '')));
    if (!person) { anomalies.push({ id: row.personId, reason: 'unknown-person:alias' }); return; }
    if (!row.aliasHash) { anomalies.push({ id: row.personId, reason: 'bad-alias' }); return; }
    if (person.aliases.includes(String(row.aliasHash))) { anomalies.push({ id: row.personId, reason: 'duplicate-alias' }); return; }
    const next = [...person.aliases, String(row.aliasHash)];
    if (next.length > MAX_ALIASES) anomalies.push({ id: person.personId, reason: 'alias-overflow' });
    person.aliases = next.slice(0, MAX_ALIASES);
    person.updatedAt = Number(row.at) || person.updatedAt;
  };

  // [AUDIT-FIX] 两遍折叠：先建人（link），再 merge，最后挂别名。
  // 这样 alias 先于 link、merge 先于 link 都不会永久丢失；未知 alias 仍有 anomaly。
  for (const row of rows) if (row && row.kind === 'link') applyLink(row);
  for (const row of rows) if (row && row.kind === 'merge') applyMerge(row);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind === 'alias') applyAlias(row);
    else if (row.kind !== 'link' && row.kind !== 'merge') anomalies.push({ id: row.personId, reason: `unknown-kind:${row.kind}` });
  }

  const list = [...people.values()].map((p) => ({ ...p, canonicalId: canonicalId(p.personId) }));
  return { people: list, anomalies };
}

export function resolveIdentity(folded, platform, externalId) {
  const hash = hashExternalId(platform, externalId);
  const key = `${normalizePlatform(platform)}:${hash}`;
  const person = (folded?.people || []).find((p) => p.links.some((l) => `${l.platform}:${l.hash}` === key));
  if (!person) return null;
  return { personId: person.canonicalId || person.personId, matched: person.personId, mergedInto: person.mergedInto || null };
}

/** 按别名摘要反查 personId；多个命中视为歧义（共昵称），返回 ambiguous 而不是猜。 */
export function resolveAlias(folded, alias) {
  const hash = hashAlias(alias);
  if (!hash) return null;
  const hits = (folded?.people || []).filter((p) => Array.isArray(p.aliases) && p.aliases.includes(hash));
  if (!hits.length) return null;
  if (hits.length > 1) return { personId: null, ambiguous: true, candidates: hits.map((p) => p.canonicalId || p.personId) };
  const person = hits[0];
  return { personId: person.canonicalId || person.personId, matched: person.personId, ambiguous: false };
}

export function parseIdentityLedger(text) {
  const rows = [];
  const corrupt = [];
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.kind === 'string') rows.push(row);
      else corrupt.push({ line: index + 1, reason: 'missing-kind' });
    } catch { corrupt.push({ line: index + 1, reason: 'bad-json' }); }
  }
  return { rows, corrupt };
}

/** people.json（UIN 键）→ identity 事件（只读转换；隐私只出摘要）。 */
export function peopleToIdentityEvents(people, { now = Date.now() } = {}) {
  const events = [];
  const seen = new Set();
  for (const [uin, person] of Object.entries(people && typeof people === 'object' ? people : {})) {
    if (!/^\d{5,12}$/.test(String(uin))) continue;
    // 迁移不携带任何明文标签（person.id 就是 QQ 号）；label 留给运行时显式传入的非 PII 标签。
    const link = buildLink({ platform: 'qq', externalId: String(uin), label: '', at: now });
    const key = `qq:${link.externalIdHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(link);
    for (const alias of Object.values(person?.aliases && typeof person.aliases === 'object' ? person.aliases : {})) {
      if (!alias) continue;
      const a = buildAlias({ personId: link.personId, alias: String(alias), at: now });
      const akey = `${link.personId}:${a.aliasHash}`;
      if (seen.has(akey)) continue;
      seen.add(akey);
      events.push(a);
    }
  }
  return events;
}

export function identitySummary(folded) {
  const people = folded?.people || [];
  return {
    people: people.filter((p) => !p.mergedInto).length,
    links: people.reduce((n, p) => n + (p.links?.length || 0), 0),
    aliases: people.reduce((n, p) => n + (p.aliases?.length || 0), 0),
    merged: people.filter((p) => p.mergedInto).length,
    anomalies: folded?.anomalies?.length || 0,
  };
}

/** append-only 存储；writer 白名单 bridge/migration/owner。 */
export function createIdentityStore({ file, now = () => Date.now(), append = appendJsonl, readFile } = {}) {
  if (!file) throw new IdentityError('identity file 不能为空');
  const target = path.resolve(String(file));
  const nowFn = typeof now === 'function' ? now : () => now;
  const appendFn = typeof append === 'function' ? append : appendJsonl;
  const fsRead = typeof readFile === 'function' ? readFile : (f) => import('node:fs').then(({ default: fs }) => {
    try { return fs.readFileSync(f, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
  });
  const allowed = new Set(['bridge', 'migration', 'owner']);

  async function appendEvent(event, { writer = 'bridge' } = {}) {
    if (!allowed.has(writer)) throw new IdentityError('writer 不在白名单', 'writer-forbidden');
    const result = appendFn(target, event, { source: 'identity-map', fsync: true });
    if (!result || result.ok !== true) throw new IdentityError(`身份账写入失败：${result?.error || 'unknown'}`, 'write-failed');
    return event;
  }
  async function readAll() { return parseIdentityLedger(await fsRead(target)); }
  async function state() { const { rows, corrupt } = await readAll(); return { ...foldIdentity(rows, { now: nowFn() }), corrupt }; }

  async function link({ platform, externalId, label = '' } = {}) {
    const current = await state();
    const existing = resolveIdentity(current, platform, externalId);
    if (existing) return { ok: true, existing: true, personId: existing.personId };
    const event = buildLink({ platform, externalId, label, at: nowFn() });
    await appendEvent(event, { writer: 'bridge' });
    return { ok: true, existing: false, personId: event.personId, event };
  }
  async function addAlias(personId, alias) {
    const event = buildAlias({ personId, alias, at: nowFn() });
    await appendEvent(event, { writer: 'bridge' });
    return event;
  }
  async function merge(from, into, reason = '') {
    const event = buildMerge({ from, into, reason, at: nowFn() });
    await appendEvent(event, { writer: 'bridge' });
    return event;
  }
  return { v: IDENTITY_VERSION, file: target, appendEvent, readAll, state, link, addAlias, merge, resolve: async (platform, externalId) => resolveIdentity(await state(), platform, externalId) };
}
