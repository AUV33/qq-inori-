// inori-failures.js · 失败原因的实时归纳（工具失败 → 分因 → 聚合 → 一句话摘要）
//
// 不是失败日志：是「最近老卡在哪」的归纳。工具失败发生时把错误文本归到几类原因
// （禁言/网络/模型端/权限/限流/目标不存在/设备/配置），按窗口聚合；唤醒时最多 20 分钟
// 递一次摘要，让她知道「刚才失败不是你的错/不是同一种错」，不催她汇报、不替她道歉。
//
// 数据：data/state/failure-log.json = { events: [{at, key, tool, cause, text}] }（保留 300 条）
import fs from 'node:fs';
import { atomicWriteJson } from '../../bootstrap/fs-utils.mjs';
import { stateDataPath } from '../shared/project-paths.js';

export const DEFAULTS = { file: stateDataPath('failure-log.json'), cap: 300, windowMs: 30 * 60_000 };

export const CAUSES = [
  { key: 'mute', label: '被禁言/消息发不出去', re: /禁言|shut_up|result=120|跳过投递/i },
  { key: 'network', label: '网络/超时', re: /ECONN|ETIMEDOUT|ETIMEOUT|timeout|timed out|超时|fetch failed|ENOTFOUND|EAI_AGAIN|socket|aborted|ECONNRESET/i },
  { key: 'model', label: '模型端拒绝/上下文太长', re: /Messages request failed|\(400\)|context length|too long|max_tokens|invalid_request/i },
  { key: 'auth', label: '没权限/令牌不对', re: /401|403|token|未授权|not allowed|denied|白名单/i },
  { key: 'rate', label: '被限流', re: /429|限流|频繁|rate limit/i },
  { key: 'missing', label: '目标不存在/路径错', re: /ENOENT|not found|不存在|没找到|找不到/i },
  { key: 'device', label: '手机/设备不可用', re: /\badb\b|no devices|device offline|设备|手机没连/i },
  { key: 'config', label: '配置/插件不对', re: /invalid config|schema|missing required|waiting for|\$\./i },
  { key: 'validation', label: '参数/用法不对', re: /必须|参数|用法|invalid|expected|不能为空/i },
  { key: 'unknown', label: '其他', re: null },
];

/** 把一段错误文本归到一类原因（确定性规则，可单测）。 */
export function classifyFailure(text) {
  const s = String(text ?? '');
  for (const c of CAUSES) if (c.re && c.re.test(s)) return c;
  return CAUSES[CAUSES.length - 1];
}

export function load(file = DEFAULTS.file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { events: Array.isArray(j?.events) ? j.events : [] };
  } catch { return { events: [] }; }
}

export function save(log, file = DEFAULTS.file) {
  try {
    fs.mkdirSync(file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))) || '.', { recursive: true });
    atomicWriteJson(file, { events: (log.events || []).slice(-DEFAULTS.cap) });
    return true;
  } catch { return false; }
}

/** 记一条失败（同一条 60 秒内同工具+同原因只记一次，避免刷屏）。 */
export function noteFailure(log, { at = Date.now(), key = '', tool = '', text = '' } = {}) {
  const cause = classifyFailure(text);
  const evt = { at, key, tool: String(tool || '').slice(0, 40), cause: cause.key, text: String(text || '').replace(/\s+/g, ' ').slice(0, 160) };
  const recent = (log.events || []).find((e) => e && e.tool === evt.tool && e.cause === evt.cause && at - Number(e.at || 0) < 60_000);
  if (!recent) {
    log.events = Array.isArray(log.events) ? log.events : [];
    log.events.push(evt);
    if (log.events.length > DEFAULTS.cap) log.events = log.events.slice(-DEFAULTS.cap);
  }
  return { evt, cause, counted: !recent };
}

/** 按窗口聚合：{total, causes:[{key,label,n}], tools:[{tool,n}], sample}（按次数降序）。 */
export function summarizeFailures(log, { now = Date.now(), windowMs = DEFAULTS.windowMs } = {}) {
  const from = now - windowMs;
  const evts = (log.events || []).filter((e) => e && Number(e.at) >= from);
  const causes = new Map();
  const tools = new Map();
  for (const e of evts) {
    causes.set(e.cause, (causes.get(e.cause) || 0) + 1);
    if (e.tool) tools.set(e.tool, (tools.get(e.tool) || 0) + 1);
  }
  const label = (k) => (CAUSES.find((c) => c.key === k)?.label ?? k);
  return {
    total: evts.length,
    causes: [...causes.entries()].map(([key, n]) => ({ key, label: label(key), n })).sort((a, b) => b.n - a.n),
    tools: [...tools.entries()].map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n),
    sample: evts.slice(-1)[0]?.text?.slice(0, 80) || '',
  };
}

/** 一句话摘要（没有失败返回空串）。 */
export function renderFailureDigest(log, opts = {}) {
  const s = summarizeFailures(log, opts);
  if (!s.total) return '';
  const mins = Math.round((opts.windowMs ?? DEFAULTS.windowMs) / 60_000);
  const causes = s.causes.slice(0, 3).map((c) => `${c.label}×${c.n}`).join('、');
  const tools = s.tools.slice(0, 3).map((t) => `${t.tool}×${t.n}`).join('、');
  return `最近 ${mins} 分钟失败 ${s.total} 次：${causes}${tools ? `（工具：${tools}）` : ''}${s.sample ? `；最后一条：${s.sample}` : ''}`;
}
