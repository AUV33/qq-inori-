// 运行态小账本：会话 kind、控制台 token。
//
// 从 app.mjs 外提（2026-11-02，开放源码架构收敛）。只持有内存状态与文件读写函数，
// 不依赖 app 的运行态；路径与写函数由调用方注入。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 会话 kind 账本：sessionId -> { kind, at }，只留 30 天。 */
export function createSessionKindStore({ file, writeJson }) {
  let kinds = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  })();

  function record(sid, kind) {
    if (!sid || !kind) return;
    kinds[String(sid)] = { kind: String(kind), at: Date.now() };
    const cutoff = Date.now() - 30 * 86400000;
    for (const [id, rec] of Object.entries(kinds)) if (!(Number(rec?.at) >= cutoff)) delete kinds[id];
    try { writeJson(file, kinds); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-state.mjs'); }
  }

  return { get kinds() { return kinds; }, record };
}

/** 控制台 token：缺失时生成并写盘，之后复用；记录本次是否新建。 */
export function createConsoleTokenStore({ stateDir, writeText }) {
  const tokenFile = path.join(stateDir, 'console-token');
  let created = false;

  function loadOrCreate() {
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing) return existing;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try { console.error('[console-token] 读取失败，准备新建:', error?.message ?? error); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'runtime-state.mjs'); }
      }
    }
    const token = crypto.randomBytes(24).toString('hex');
    created = true;
    writeText(tokenFile, token);
    return token;
  }

  return { loadOrCreate, wasCreated: () => created };
}
