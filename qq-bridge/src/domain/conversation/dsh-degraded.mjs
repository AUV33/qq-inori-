// dsh-degraded.mjs · DSH 上游不可达时的降级保底（硬代价·二）
//
// 定位：主 LLM 回复路径 submitPromptWithTurnSlot → api.sessions.prompt 跑的是 DSH 整段
// agent 运行时（preset/工具/流式）。DSH 只是一个本地代理（:3080），它背后的上游
// provider（deepseek-official）挂掉时，api.sessions.prompt 会抛网络/超时/5xx 错误。
//
// 之前这里「保底只做了一半」：本地 3B 那层（唤醒/群记忆/群事实/情绪）有降级，
// 但主回复路径 DSH 一掉就直接失败、没有缓冲也没有状态提示。
//
// 本模块提供策略 B（最保守、纯降级）：
//   1) DshUpstreamDownError —— 把「上游/代理不可达」从其它错误里区分出来；
//   2) isDshUpstreamDown —— 错误分类（连接/超时/5xx/429 = 不可达；401/403 = 鉴权失败，不算）；
//   3) bufferDshDown —— 把未处理的回合缓冲到 state/dsh-down-queue.jsonl（不丢消息）；
//   4) replayDshDownQueue —— DSH 恢复后把缓冲的回合重投出去。
//
// “11134”= Ollama 默认 API 端口 11434（本地 OpenAI 兼容端点），本策略 B 不实际调用它，
// 仅在诊断报告里澄清该端点当前无入口；如需本地兜底回复请走方案 A（未实现）。

import fs from 'node:fs';

/** DSH 上游/代理不可达时抛出的分类错误（调用方据此发状态提示、优雅降级）。 */
export class DshUpstreamDownError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'DshUpstreamDownError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 判断一个错误是否代表「DSH 上游/代理不可达」（应当触发降级），而不是「鉴权失败/配置错误」
 * （那种不该切降级，因为根因是密钥/配置，不是上游挂）。
 */
export function isDshUpstreamDown(err) {
  if (!err) return false;
  const name = err.name;
  const code = err.code;
  const status = typeof err.status === 'number'
    ? err.status
    : (err.response && typeof err.response.status === 'number' ? err.response.status : undefined);
  const msg = String(err.message || '');

  // 超时 / 信号中断
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  // 网络层：代理没起 / DNS 解析不到 / 连接超时 / 连接被重置 / 主机不可达
  if (
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
  ) return true;
  // 5xx = 上游/代理自身挂了；429 = 限流，按「稍后重试」处理（恢复后会重投）
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  // 文案线索（fetch failed / upstream / provider down / 连接 / 超时）
  if (/fetch failed|network (error|request failed)|ECONNREFUSED|upstream|provider (is )?(down|unavailable|error)|请求超时|连接被拒绝|connection (refused|reset|timeout)/i.test(msg)) return true;
  // 鉴权失败明确不算不可达（那是配置/密钥问题，不应触发降级）
  if (status === 401 || status === 403) return false;
  if (/\b401\b|\b403\b|鉴权|unauthorized|forbidden|认证失败|auth/i.test(msg)) return false;
  // 其余未知错误保守返回 false，避免误触发降级
  return false;
}

const QUEUE_FILE = 'dsh-down-queue.jsonl';

/** 把一个未处理的回合缓冲到 state/dsh-down-queue.jsonl。失败不阻断主流程。 */
export function bufferDshDown({ stateDataPath, entry }) {
  const p = stateDataPath(QUEUE_FILE);
  const rec = {
    at: new Date().toISOString(),
    status: 'pending',
    ...entry,
  };
  fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
}

/** 读取缓冲队列（全部条目，含已重投的）。 */
export function loadDshDownQueue({ stateDataPath }) {
  const p = stateDataPath(QUEUE_FILE);
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * DSH 恢复后重投缓冲的回合。
 * @param {object} args
 * @param {Function} args.stateDataPath
 * @param {Function} args.replayOne (key, text, kind) => Promise|void 重投单条（通常接 socialCore.deliverPromptNow）
 * @returns {{total:number, replayed:number, skipped:number}}
 */
export async function replayDshDownQueue({ stateDataPath, replayOne }) {
  const items = loadDshDownQueue({ stateDataPath });
  let replayed = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.status !== 'pending') { skipped++; continue; }
    if (!item.key || typeof item.text !== 'string') { item.status = 'skip-no-key'; skipped++; continue; }
    // 只重投用户聊天回合（kind:'chat'）；后台任务（slang/群事实/isolated 等）内容不适合当聊天重发，
    // 它们本就是周期任务，下一轮会自然重试。未重投的非聊天项保留在队列供排查。
    if (item.kind && item.kind !== 'chat') { item.status = 'skip-non-chat'; skipped++; continue; }
    try {
      await replayOne(item.key, item.text, item.kind);
      item.status = 'replayed';
      item.replayedAt = new Date().toISOString();
      replayed++;
    } catch (error) {
      if (typeof globalThis.__ignoredCatch === 'function') globalThis.__ignoredCatch(error, 'dsh-degraded:replay');
      else console.error('[dsh-replay] 单条重投失败:', error?.message ?? error);
    }
  }
  const p = stateDataPath(QUEUE_FILE);
  try {
    fs.writeFileSync(p, items.map((e) => JSON.stringify(e)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  } catch { /* 回写失败不致命 */ }
  return { total: items.length, replayed, skipped };
}
