// [SPLIT 阶段1] 控制台 HTTP 工具，从 console-server.mjs (146–210) 抽出。
//
// 三个东西都是「只依赖传入的 req/res」的纯工具，没有任何闭包状态：
//   · SECURITY_HEADERS —— 所有响应统一的安全头
//   · createSendJson(res) —— 生成绑定该 res 的 sendJson
//   · readBody(req) —— 带 1MB 上限 / 30s 超时 / JSON 对象校验的请求体读取
// 抽出后可独立单测（尤其是请求体超限与超时这两条边界）。
// [CSP] 不再放开 script-src 'unsafe-inline'：控制台页面确实有内联 <script>（主题引导 + 主逻辑
// 2300 行，外置风险高），所以改为**按实际 HTML 内容计算 SHA-256 白名单**。只有响应里真实存在的
// 那几段内联脚本能执行，任何被注入的新内联脚本没有对应 hash 会被浏览器拦下。
// 动态计算而非硬编码 hash：前端改一行也不会因为忘记同步 CSP 而整页白屏。
import { createHash } from 'node:crypto';

const CSP_BASE = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function cspForHtml(html) {
  let csp = CSP_BASE;
  const seen = new Set();
  const source = String(html ?? '');
  INLINE_SCRIPT_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_SCRIPT_RE.exec(source)) !== null) {
    const body = match[1];
    if (!body || !body.trim()) continue;
    const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    if (seen.has(hash)) continue;
    seen.add(hash);
    csp += ` ${hash}`;
  }
  return csp;
}

export const SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  // 非 HTML 响应（JSON / 204）用不含任何内联脚本白名单的 CSP，最严格。
  'Content-Security-Policy': CSP_BASE,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
});

export function headersForHtml(html) {
  return { ...SECURITY_HEADERS, 'Content-Security-Policy': cspForHtml(html) };
}

export function createSendJson(res) {
  return (obj, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
    res.end(JSON.stringify(obj, null, 2));
  };
}

// 返回 Promise<object>。拒绝时 Error 上带 statusCode，供上层 catch 转成对应 HTTP 状态。
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const MAX_BODY_BYTES = 1_000_000;
    const chunks = [];
    let total = 0;
    let settled = false;
    let bodyTimer = null;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      const err = new Error(message);
      err.statusCode = status;
      reject(err);
    };
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (bodyTimer) clearTimeout(bodyTimer);
      resolve(val);
    };
    // 提前按 Content-Length 拒绝超限请求体
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      fail(413, '请求体过大（超过 1MB）');
      return;
    }
    bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
    req.on('data', (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) { done({}); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(400, '请求体必须是 JSON 对象');
        return;
      }
      done(parsed);
    });
    // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
    req.on('error', () => fail(400, '请求体读取失败'));
    req.on('aborted', () => fail(400, '请求体读取中断'));
  });
}
