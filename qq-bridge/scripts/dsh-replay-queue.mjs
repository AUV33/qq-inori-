// dsh-replay-queue.mjs · 触发 DSH 降级缓冲队列重投（策略 B 的「缓冲」闭环）
//
// 用法：
//   npm run dsh:replay            # 对本地运行中的桥接（3100）发起重投
//   node scripts/dsh-replay-queue.mjs [--view]   # --view 只查看队列、不重投
//
// 仅当 DSH 已恢复（dshReady）时才会真正重投；否则返回 dsh-not-ready。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const viewOnly = args.has('--view');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readConsoleToken(cfg) {
  if (cfg.consoleToken) return cfg.consoleToken;
  try {
    return fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function main() {
  const cfg = readConfig();
  const port = Number(cfg.consolePort ?? 3100);
  const token = readConsoleToken(cfg);
  if (!token) {
    console.error('[dsh-replay] 未找到控制台令牌（config.json 的 consoleToken 或 state/console-token）。');
    process.exit(2);
  }
  const endpoint = viewOnly ? '/api/admin/dsh-queue' : '/api/admin/dsh-replay';
  const url = `http://127.0.0.1:${port}${endpoint}?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: viewOnly ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: viewOnly ? undefined : '{}',
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  console.log(JSON.stringify(json, null, 2));
  process.exit(res.ok && json.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[dsh-replay] 调用失败（桥接是否在运行？）:', error?.message ?? error);
  process.exit(1);
});
