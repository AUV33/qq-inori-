// self-anchor.mjs · 宪章「锚定」：只追加的身份事实账（不是评价账）
//
// 干什么：记录她是谁的**事实**：self personId、owner personId、名字来源、角色卡 hash、创建时间；
//   可选追加她自己的定义（writer='her'）。纯函数：只构造/折叠/渲染，不读盘、不自动写。
// 为什么：角色卡是外部文本，self-model 是统计画像；没有一份“身份事实账”时，
//   重启/换会话后“我是谁”只能靠拼提示词。锚点只记事实，不替她下判断。
// 输入输出：buildAnchorFacts / buildSelfDefinition / foldSelfAnchor / renderSelfAnchorLine。
// 失败模式：pID/role hash 不合法 → 抛 SelfAnchorError；坏行进 anomalies，不吞。
// 不做什么：不自动评价、不自动写 selfTrust、不覆盖角色卡；定义只接受 writer='her'。

import crypto from 'node:crypto';

export const SELF_ANCHOR_VERSION = 1;
export const SELF_ANCHOR_FILE = 'self-anchor.jsonl';

const PID_RE = /^p_[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]{16,64}$/;

export class SelfAnchorError extends Error {
  constructor(message) { super(message); this.name = 'SelfAnchorError'; }
}

const clean = (v, max = 240) => String(v ?? '').trim().slice(0, max);

export function buildAnchorFacts({
  selfPersonId, ownerPersonId = null, name, nameSource = '', roleCardHash, createdAt = Date.now(),
} = {}) {
  if (!PID_RE.test(String(selfPersonId ?? ''))) throw new SelfAnchorError('selfPersonId 必须是 p_ + 12 位 hex');
  if (ownerPersonId != null && !PID_RE.test(String(ownerPersonId))) throw new SelfAnchorError('ownerPersonId 必须是 p_ + 12 位 hex');
  const n = clean(name, 60);
  if (!n) throw new SelfAnchorError('name 不能为空');
  const hash = clean(roleCardHash, 64).toLowerCase();
  if (!HEX_RE.test(hash)) throw new SelfAnchorError('roleCardHash 必须是 16–64 位 hex');
  const at = Number(createdAt);
  if (!Number.isFinite(at) || at <= 0) throw new SelfAnchorError('createdAt 必须是毫秒时间戳');
  return Object.freeze({
    v: SELF_ANCHOR_VERSION,
    kind: 'anchor',
    at,
    selfPersonId: String(selfPersonId),
    ownerPersonId: ownerPersonId == null ? null : String(ownerPersonId),
    name: n,
    nameSource: clean(nameSource, 160),
    roleCardHash: hash,
  });
}

/** 她自己的定义：只接受 writer='her'，不自动生成。 */
export function buildSelfDefinition({ text, writer = 'her', at = Date.now() } = {}) {
  if (String(writer) !== 'her') throw new SelfAnchorError("只有 writer='her' 能追加定义");
  const t = clean(text, 300);
  if (!t) throw new SelfAnchorError('定义文本不能为空');
  const when = Number(at);
  if (!Number.isFinite(when) || when <= 0) throw new SelfAnchorError('at 必须是毫秒时间戳');
  return Object.freeze({ v: SELF_ANCHOR_VERSION, kind: 'definition', writer: 'her', at: when, text: t });
}

export function foldSelfAnchor(rows = []) {
  const anchors = [];
  const definitions = [];
  const anomalies = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') { anomalies.push({ reason: 'bad-row' }); continue; }
    if (row.kind === 'anchor') {
      try {
        anchors.push(buildAnchorFacts({
          selfPersonId: row.selfPersonId, ownerPersonId: row.ownerPersonId,
          name: row.name, nameSource: row.nameSource, roleCardHash: row.roleCardHash, createdAt: row.at,
        }));
      } catch (error) { anomalies.push({ reason: 'bad-anchor', id: row.selfPersonId, detail: error?.message }); }
      continue;
    }
    if (row.kind === 'definition') {
      try { definitions.push(buildSelfDefinition({ text: row.text, writer: row.writer, at: row.at })); }
      catch (error) { anomalies.push({ reason: 'bad-definition', detail: error?.message }); }
      continue;
    }
    anomalies.push({ reason: 'unknown-kind', kind: row.kind });
  }
  anchors.sort((a, b) => a.at - b.at);
  definitions.sort((a, b) => a.at - b.at);
  const anchor = anchors.length ? anchors[anchors.length - 1] : null;
  return { anchor, anchors, definitions, anomalies };
}

export function roleCardHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 只渲染事实，不替她评价。没有锚点返回空串。 */
export function renderSelfAnchorLine(state = {}) {
  const anchor = state?.anchor;
  if (!anchor) return '';
  const bits = [];
  bits.push('你是 ' + anchor.name);
  bits.push('self=' + anchor.selfPersonId);
  if (anchor.ownerPersonId) bits.push('owner=' + anchor.ownerPersonId);
  if (anchor.nameSource) bits.push('名字来源：' + anchor.nameSource);
  const defs = (state.definitions || []).slice(-2).map((d) => d.text).filter(Boolean);
  if (defs.length) bits.push('你给自己的定义：' + defs.join(' / '));
  return '【身份锚点（事实，不是评价）】' + bits.join('；');
}
