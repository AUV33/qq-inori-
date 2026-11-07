// [RERANK-ONDEMAND] 交叉重排服务（8792）按需拉起。
//
// 背景：以前是「启动即拉起 + 每 60s 保活」，空转时白占约 4 GB 提交内存。
// 现在只在真要重排时（记忆注入前）检查一次：在线就什么也不做，不在线就 detached 拉起，
// 服务端自己空闲退出（见 scripts/rerank-server.py 的 RERANK_IDLE_EXIT）。
//
// 设计约束：
// - 不 await、不抛错：拉不起来就当这一轮不重排（调用方本来就有静默回退）。
// - 冷却 120s：避免模型还在加载（20~30s）时被下一轮重复拉起。
// - 不做「已在线」缓存：服务空闲退出后必须能被重新发现，否则永远不会再拉起。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bridgePath, LOG_DIR } from '../shared/project-paths.js';

const HEALTH_URL = 'http://127.0.0.1:8792/health';
const SERVER_PY = bridgePath('scripts', 'rerank-server.py');
const SERVER_LOG = path.join(LOG_DIR, 'rerank-server.log');
const SPAWN_COOLDOWN_MS = 120 * 1000;
const HEALTH_TIMEOUT_MS = 700;

let lastSpawn = 0;

async function isAlive() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 确保 8792 在线；不在线就在后台拉起（不阻塞调用方）。
 * @param {(msg: string) => void} [log]
 * @returns {Promise<boolean>} 拉起动作是否已发出（不代表已就绪）
 */
export async function ensureRerank(log = () => {}) {
  if (await isAlive()) return true;
  if (Date.now() - lastSpawn < SPAWN_COOLDOWN_MS) return false;
  lastSpawn = Date.now();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(SERVER_LOG, 'a');
    const child = spawn('python', [SERVER_PY], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    // [SPAWN-ERROR] spawn 的 ENOENT 是**异步** error 事件：不挂监听会变成 uncaughtException，
    // 把整个桥接进程带走（机器上没装 python / PATH 变了就会踩到）。这里只记日志，这一轮不重排。
    child.on('error', (error) => log(`[rerank] 拉起失败: ${error?.message ?? error}`));
    child.unref();
    log('[rerank] 服务不在线，已按需拉起 bge-reranker-v2-m3（空闲会自动退出）');
    return true;
  } catch (error) {
    log(`[rerank] 拉起失败: ${error?.message ?? error}`);
    return false;
  }
}
