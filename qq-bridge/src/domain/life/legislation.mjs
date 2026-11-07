// legislation.mjs · L4 立法层：承诺账本 / 拒绝通道 / 自我信任（纯规则 + 三本 append-only 账）
//
// 宪章落位：
//   §5.3 selfTrust：她自己的自我评估，系统不自动拨动（C4/A6）。
//   §5.7 立法层：承诺只有她能写；系统只记录、只执行她自选的罚则；拒绝不重试、不惩罚、不降权。
//   §6 账本：commitments.jsonl / declined.jsonl / self-trust.jsonl，全部 append-only + 原子追加。
//
// 关键纪律（会直接抛错，不做静默降级）：
//   1) writer 必须是 'her'——owner/系统/管道不得写这三本账（与 selfTrust 的 A6 裁决一致）；
//   2) 已了结的承诺不能再改；未知承诺不能 keep/break；
//   3) 文本有界；数值 clamp 前先校验，非法值直接拒绝；
//   4) 账本只追加，状态由 fold 得出——任何"改历史"都必须留下新记录。
//
// 不做什么：不执行罚则（S4 由受控执行器接）、不生成文本、不调模型、不读旧状态。

import crypto from 'node:crypto';
import path from 'node:path';
import { appendJsonl } from '../../../../ai-companion-kit/packages/shared/learning-store.mjs';

export const LEGISLATION_VERSION = 1;
export const LEDGER_FILES = Object.freeze({
  commitments: 'commitments.jsonl',
  declined: 'declined.jsonl',
  selfTrust: 'self-trust.jsonl',
});
export const COMMITMENT_STATUSES = Object.freeze(['active', 'kept', 'broken']);
export const LIMITS = Object.freeze({
  text: 300,
  penalty: 200,
  reason: 300,
  target: 160,
  trustReason: 300,
});

const ID_RE = /^(cm|dc|st)_\d{8}_[0-9a-f]{6}$/;
const KIND_BY_PREFIX = { cm: 'made', dc: 'declined', st: 'assessed' };

export class LegislationError extends Error {
  constructor(message, code = 'legislation') {
    super(message);
    this.name = 'LegislationError';
    this.code = code;
  }
}

const nowDate = (now) => (now instanceof Date ? now : new Date(Number(now) || Date.now()));
const iso = (now) => nowDate(now).toISOString();
const clip = (value, max) => [...String(value ?? '').trim()].slice(0, max).join('');
const assertText = (value, max, field) => {
  const text = String(value ?? '').trim();
  if (!text) throw new LegislationError(`${field} 不能为空`);
  if ([...text].length > max) throw new LegislationError(`${field} 不能超过 ${max} 字`);
  return text;
};

function makeId(prefix, now) {
  const date = nowDate(now);
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `${prefix}_${ymd}_${crypto.randomBytes(3).toString('hex')}`;
}

// ── 纯记录构造（不做 IO）──────────────────────────────────────

export function buildCommitment({ text, penalty = '' }, { now = Date.now(), id } = {}) {
  const body = assertText(text, LIMITS.text, '承诺');
  const p = String(penalty ?? '').trim();
  if ([...p].length > LIMITS.penalty) throw new LegislationError(`罚则不能超过 ${LIMITS.penalty} 字`);
  const recordId = id || makeId('cm', now);
  if (!ID_RE.test(recordId) || !recordId.startsWith('cm_')) throw new LegislationError('承诺 id 非法');
  return {
    v: LEGISLATION_VERSION, kind: 'made', id: recordId, ts: iso(now),
    text: body, penalty: p,
  };
}

export function buildCommitmentResolution(id, status, { reason = '' } = {}, { now = Date.now() } = {}) {
  if (!['kept', 'broken'].includes(status)) throw new LegislationError('承诺只能标 kept / broken');
  if (!ID_RE.test(String(id || '')) || !String(id).startsWith('cm_')) throw new LegislationError('承诺 id 非法');
  const why = String(reason ?? '').trim();
  if (status === 'broken' && !why) throw new LegislationError('食言必须写原因（对她自己诚实）');
  if ([...why].length > LIMITS.reason) throw new LegislationError(`原因不能超过 ${LIMITS.reason} 字`);
  return { v: LEGISLATION_VERSION, kind: status, id: String(id), ts: iso(now), reason: why };
}

export function buildDecline({ target, reason }, { now = Date.now(), id } = {}) {
  const t = assertText(target, LIMITS.target, '拒绝对象');
  const why = assertText(reason, LIMITS.reason, '拒绝理由');
  const recordId = id || makeId('dc', now);
  if (!ID_RE.test(recordId) || !recordId.startsWith('dc_')) throw new LegislationError('拒绝 id 非法');
  return { v: LEGISLATION_VERSION, kind: 'declined', id: recordId, ts: iso(now), target: t, reason: why };
}

export function buildSelfAssessment({ value, reason }, { now = Date.now(), id } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new LegislationError('selfTrust 必须是 0..1 的数值');
  const why = assertText(reason, LIMITS.trustReason, '评估理由');
  const recordId = id || makeId('st', now);
  if (!ID_RE.test(recordId) || !recordId.startsWith('st_')) throw new LegislationError('评估 id 非法');
  return {
    v: LEGISLATION_VERSION, kind: 'assessed', id: recordId, ts: iso(now),
    value: Math.round(n * 1000) / 1000, reason: why,
  };
}

// ── 账本读取与折叠（纯函数）─────────────────────────────────────

export function parseLedgerText(text) {
  const rows = [];
  const corrupt = [];
  for (const [index, line] of String(text ?? '').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.kind === 'string') rows.push(row);
      else corrupt.push({ line: index + 1, reason: 'missing-kind' });
    } catch (error) {
      corrupt.push({ line: index + 1, reason: 'bad-json' });
    }
  }
  return { rows, corrupt };
}

/** 承诺账折叠：made 建条目；kept/broken 只对存在的 active 条目生效。未知/越界转换忽略（并计入 anomalies）。 */
export function foldCommitments(rows) {
  const byId = new Map();
  const anomalies = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id ?? '');
    if (row.kind === 'made') {
      if (!id || byId.has(id)) { anomalies.push({ id, reason: 'duplicate-or-empty' }); continue; }
      byId.set(id, {
        id, text: clip(row.text, LIMITS.text), penalty: clip(row.penalty, LIMITS.penalty),
        status: 'active', createdAt: String(row.ts ?? ''),
        resolvedAt: null, reason: '',
      });
      continue;
    }
    if (row.kind === 'kept' || row.kind === 'broken') {
      const item = byId.get(id);
      if (!item) { anomalies.push({ id, reason: 'unknown-id' }); continue; }
      if (item.status !== 'active') { anomalies.push({ id, reason: 'already-resolved' }); continue; }
      item.status = row.kind;
      item.resolvedAt = String(row.ts ?? '');
      item.reason = clip(row.reason, LIMITS.reason);
      continue;
    }
    anomalies.push({ id, reason: `unknown-kind:${row.kind}` });
  }
  return { commitments: [...byId.values()], anomalies };
}

export function commitmentFacts(commitments) {
  const list = Array.isArray(commitments) ? commitments : [];
  return {
    total: list.length,
    active: list.filter((x) => x.status === 'active').length,
    kept: list.filter((x) => x.status === 'kept').length,
    broken: list.filter((x) => x.status === 'broken').length,
  };
}

export function foldDeclined(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.kind === 'declined')
    .map((row) => ({
      id: String(row.id ?? ''), target: clip(row.target, LIMITS.target),
      reason: clip(row.reason, LIMITS.reason), at: String(row.ts ?? ''),
    }));
}

export function foldSelfTrust(rows) {
  let latest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.kind !== 'assessed') continue;
    const value = Number(row.value);
    if (!Number.isFinite(value) || value < 0 || value > 1) continue;
    latest = { value: Math.round(value * 1000) / 1000, reason: clip(row.reason, LIMITS.trustReason), at: String(row.ts ?? ''), id: String(row.id ?? '') };
  }
  return latest;
}

// ── 账本存储（append-only；writer 必须是她）────────────────────

export function createLegislationStore({ root, now = () => Date.now(), append = appendJsonl, readFile } = {}) {
  if (!root) throw new LegislationError('legislation root 不能为空');
  const baseDir = path.resolve(String(root));
  const nowFn = typeof now === 'function' ? now : () => now;
  const appendFn = typeof append === 'function' ? append : appendJsonl;
  const fsRead = typeof readFile === 'function' ? readFile : (file) => {
    // 延迟 require，保持模块在浏览器/测试替身下也能被 import
    return import('node:fs').then(({ default: fs }) => {
      try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return ''; throw error; }
    });
  };

  const fileOf = (key) => path.join(baseDir, LEDGER_FILES[key]);

  async function readRows(key) {
    const text = await fsRead(fileOf(key));
    return parseLedgerText(text);
  }

  function assertHer(writer) {
    if (writer !== 'her') throw new LegislationError('只有她能写承诺/拒绝/自我信任（writer 必须是 her）', 'writer-forbidden');
  }

  async function appendRow(key, row, writer) {
    assertHer(writer);
    const result = appendFn(fileOf(key), row, { source: 'legislation', fsync: true });
    if (!result || result.ok !== true) throw new LegislationError(`账本写入失败：${result?.error || 'unknown'}`, 'write-failed');
    return row;
  }

  async function state() {
    const [commitmentRows, declinedRows, trustRows] = await Promise.all([
      readRows('commitments'), readRows('declined'), readRows('selfTrust'),
    ]);
    const folded = foldCommitments(commitmentRows.rows);
    return {
      commitments: folded.commitments,
      facts: commitmentFacts(folded.commitments),
      anomalies: folded.anomalies,
      declined: foldDeclined(declinedRows.rows),
      selfTrust: foldSelfTrust(trustRows.rows),
      corrupt: {
        commitments: commitmentRows.corrupt,
        declined: declinedRows.corrupt,
        selfTrust: trustRows.corrupt,
      },
    };
  }

  // 进程内串行：resolve 是「读状态 → 判断 → 追加」，而 append 的锁不覆盖前半段。
  // 同一进程里两个并发 keep/break 都可能读到 active；串行后第二个会明确收到 already-resolved。
  // 跨进程仍由 appendJsonl 的文件锁保证「一条不丢」，但语义上的双写窗口由单写者约束收敛。
  let writeChain = Promise.resolve();
  function serial(fn) {
    const next = writeChain.then(fn, fn);
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  function makeCommitment(input, { writer } = {}) {
    return serial(async () => {
      const row = buildCommitment(input, { now: nowFn() });
      return appendRow('commitments', row, writer);
    });
  }

  function resolveCommitment(id, status, options = {}, { writer } = {}) {
    return serial(async () => {
      assertHer(writer);
      if (!['kept', 'broken'].includes(status)) throw new LegislationError('承诺只能标 kept / broken');
      const current = await state();
      const item = current.commitments.find((x) => x.id === String(id));
      if (!item) throw new LegislationError('没有这条承诺', 'not-found');
      if (item.status !== 'active') throw new LegislationError('这条承诺已经了结，不能改历史', 'already-resolved');
      const row = buildCommitmentResolution(String(id), status, options, { now: nowFn() });
      return appendRow('commitments', row, writer);
    });
  }

  function decline(input, { writer } = {}) {
    return serial(async () => {
      const row = buildDecline(input, { now: nowFn() });
      return appendRow('declined', row, writer);
    });
  }

  function assessTrust(input, { writer } = {}) {
    return serial(async () => {
      const row = buildSelfAssessment(input, { now: nowFn() });
      return appendRow('selfTrust', row, writer);
    });
  }

  return {
    v: LEGISLATION_VERSION,
    root: baseDir,
    files: { commitments: fileOf('commitments'), declined: fileOf('declined'), selfTrust: fileOf('selfTrust') },
    state, makeCommitment, resolveCommitment, decline, assessTrust,
  };
}
