// 文本/活动小工具：静默标记、脱敏、CQ 转义、活动日志尾部、思考强度归一。
//
// 从 app.mjs 外提（2026-11-02，开放源码架构收敛）。纯函数，只有 readActivityTail 读文件。
import fs from 'node:fs';
import { SENSITIVE_RE } from '../domain/shared/sensitive.js';
import { KNOWN_AGENT_TOKENS } from './agent-tokens.mjs';

export const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
export const REASONING_EFFORT_DEFAULT = 'max';

export function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

export function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

/** 敏感文本脱敏：SENSITIVE_RE 命中片段 + 已知 agent token 都替换为 ***。 */
export function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'text-utils.mjs'); }
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

/** 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/** 读取活动日志末尾 n 行；文件不存在返回空串。 */
export function readActivityTail(file, n) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}
