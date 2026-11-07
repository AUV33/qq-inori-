// @ts-check
// mcp-helpers.js · 从 mcp-snowluma-safe.js 抽出的纯/近纯辅助函数（2026-11 拆分）。
//
// 这些函数只依赖 node 内置（fs/path）与彼此，不触碰 server / cfg / consoleToken /
// 工具注册状态，因此可以独立成模块、被 mcp-snowluma-safe.js 重新 import，行为完全等价。
// 若改动这里的私网判定或 API 调用语义，必须同步回 mcp-snowluma-safe.js 的调用方；
// 不要在别处再写第三份同义实现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function getConfig() {
  return loadConfig();
}

export function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行。
export function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-helpers.js'); }
  }
  return value;
}

export async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
export function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

export function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch (error) {
    try { process.stderr.write(`[mcp-snowluma] 读 config.consoleToken 失败: ${error?.message ?? error}\n`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-helpers.js'); }
  }
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { process.stderr.write(`[mcp-snowluma] 读 state/console-token 失败: ${error?.message ?? error}\n`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-helpers.js'); }
    }
    return '';
  }
}

export function errText(e) {
  if (e == null) return '未知错误';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name || String(e);
  if (typeof e === 'object') {
    const m = e.message ?? e.error ?? e.code;
    if (typeof m === 'string' && m) return m;
    try { const j = JSON.stringify(e); if (j && j !== '{}') return j.slice(0, 300); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-helpers.js'); }
  }
  return String(e);
}

export function apiErrorText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try { return v.message || v.error || JSON.stringify(v).slice(0, 400); } catch { return '（无法序列化的错误）'; }
  }
  return String(v);
}

/**
 * @param {string} path
 * @param {any} [init] 透传 fetch 的 init（method/body/headers 等）；timeoutMs 为本函数专用字段
 */
export async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略（confused deputy 修复）。
  headers['x-agent-call'] = '1';
  let res;
  try {
    res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`请求被中断（${error?.name}，超时 ${Math.round(timeoutMs / 1000)}s）：通常是这一轮被取消/让位，或者等待太久。`);
    }
    throw new Error(errText(error));
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(apiErrorText(body?.error) || `桥接 API HTTP ${res.status}`);
  }
  // 桥接部分端点用 200 + {ok:false,error} 表达业务失败（如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型（静默错误）。
  // 例外：preSleepBlocked 是「现在还不能睡」的结构化提示，原样交给模型。
  if (body && typeof body === 'object' && body.ok === false && !body.preSleepBlocked) {
    throw new Error(apiErrorText(body.error) || '桥接 API 返回 ok:false（未说明原因）');
  }
  return body;
}
