// state-io.mjs · 纯工具 + 文件态读写（从 app.mjs 抽出，2026-11-07 Wave 3）
//
// 这些函数只依赖 node 的 fs/path 与注入的 STATE_DIR/STATE_DATA_DIR +
// writeJsonDocument/atomicWriteJson/readJsonSafe/log，不引用任何 main 闭包局部状态。
// app.mjs 仍保留模块级细委托绑定（unquoteJsonString/stripUrls/sanitizeRoleName/
// oneBotError/loadWishState/saveWishState/loadInterestEncounters/saveInterestEncounters/
// loadUnsentState/saveUnsentState/readRoleState/writeRoleState）以守住 test-app-facade-wiring
// 的源码契约（其中多个在 consoleDeps getter 里被引用）。
import fs from 'node:fs';
import path from 'node:path';

export function createStateIo({ STATE_DIR, STATE_DATA_DIR, writeJsonDocument, atomicWriteJson, readJsonSafe, log }) {
  const WISH_FILE = path.join(STATE_DIR, 'wishes.json');
  const UNSENT_FILE = path.join(STATE_DIR, 'unsent.json');
  const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
  const INTEREST_FILE = path.join(STATE_DATA_DIR, 'interest-encounters.json');

  function loadWishState() {
    try { return JSON.parse(fs.readFileSync(WISH_FILE, 'utf8')); } catch { return { items: [] }; }
  }

  function saveWishState(s) {
    try {
      // [WRITE-CHECK] writeJsonDocument 失败是"返回 {ok:false}"而不是抛异常：不检查返回值
      // 就等于静默丢写（重启后读回旧值）。这两个状态是"她约好的事"，丢了用户能感知。
      const r = writeJsonDocument(WISH_FILE, s, { source: 'bridge/wish' });
      if (r && r.ok === false) log(`[wish] 保存失败：${r.error ?? '未知错误'}（重启后会读回旧值）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'state-io.mjs:24'); }
  }

  function loadInterestEncounters() { try { return JSON.parse(fs.readFileSync(INTEREST_FILE, 'utf8')); } catch { return { items: [] }; } }
  function saveInterestEncounters(s) { try { fs.mkdirSync(STATE_DATA_DIR, { recursive: true }); atomicWriteJson(INTEREST_FILE, s); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'state-io.mjs:25'); } }

  function loadUnsentState() {
    try { return JSON.parse(fs.readFileSync(UNSENT_FILE, 'utf8')); } catch { return { items: [] }; }
  }
  function saveUnsentState(s) {
    try {
      const r = writeJsonDocument(UNSENT_FILE, s, { source: 'bridge/unsent' });
      if (r && r.ok === false) log(`[unsent] 保存失败：${r.error ?? '未知错误'}（挂心事会丢）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'state-io.mjs:32'); }
  }

  function readRoleState() {
    return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
  }
  function writeRoleState(role, mode) {
    atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
  }

  // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
  function unquoteJsonString(value) {
    if (typeof value !== 'string') return value;
    const t = value.trim();
    if (t.startsWith('"')) {
      try {
        const parsed = JSON.parse(t);
        if (typeof parsed === 'string') return parsed;
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'state-io.mjs:46'); }
    }
    return value;
  }

  // [MEMORY-INJECT] 检索/分类前先把 URL 剔掉：他发链接时，网址本身是语义噪声
  // （实测 query=https://api.xiaohe… 曾把「生日」记忆检索出来，属误伤而非命中）
  function stripUrls(s) {
    return String(s ?? '')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/www\.\S+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sanitizeRoleName(name) {
    return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
  }

  function oneBotError(action, res, body) {
    const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
    return `OneBot ${action} 失败: ${body?.wording || body?.retcode || res.status}${hint}`;
  }

  return {
    loadWishState, saveWishState, loadInterestEncounters, saveInterestEncounters,
    loadUnsentState, saveUnsentState, readRoleState, writeRoleState,
    unquoteJsonString, stripUrls, sanitizeRoleName, oneBotError,
  };
}
