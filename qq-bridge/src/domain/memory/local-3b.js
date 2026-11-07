// [LOCAL-3B] 把已有的 Qwen2.5-3B 变成"按需服务"：要用时拉起，闲置 N 分钟自动杀。
// 参照 GitHub 上 llama-swap 的 ttl/RUNNING 思路，但只用一个已有模型文件，不引入新依赖。
//
// 2026-10-28 修：桥接重启会丢掉 child 句柄，旧实现只认 child.pid，
// 于是 20:39 起的实例活到第二天也没人回收（logs/local-3b.pid 还丢了）。
// 现在多一条路：没句柄时按端口找到 pid、核对进程名、补写 pid 文件，交给同一个 sweeper 管；
// 每次 touch 都刷新 pid 文件 mtime，重启后也能按"最后使用时间"判断闲置。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { LOG_DIR } from '../shared/project-paths.js';

const DEFAULT_PORT = 18080;
const PID_FILE = path.join(LOG_DIR, 'local-3b.pid');
const HEALTH_TIMEOUT_MS = 800;
const SPAWN_COOLDOWN_MS = 180 * 1000;
const KILL_GRACE_MS = 5000;
const PROCESS_NAME = 'llama-server.exe';

let child = null;
let lastSpawnAt = 0;
let lastUsedAt = 0;
let sweeper = null;

export function local3bConfig(cfg) {
  const a = cfg?.socialV2?.affect ?? {};
  return {
    port: Number(a.localPort) || DEFAULT_PORT,
    // 路径不再写死作者机器：配置（localExe/localModelPath）→ 环境变量（INORI_LLAMA_EXE/INORI_LOCAL_MODEL）→ 空。
    // 为空时调用方已有 existsSync 检查，会明确提示「本地模型未配置」并降级，而非尝试作者路径。
    exe: String(a.localExe || process.env.INORI_LLAMA_EXE || ''),
    modelPath: String(a.localModelPath || process.env.INORI_LOCAL_MODEL || ''),
    modelName: String(a.localModelName || 'qwen2.5-3b-instruct-q4_k_m'),
    idleMs: Math.max(60_000, Number(a.localIdleMs) || 10 * 60 * 1000),
    ctx: Number(a.localCtx) || 2048,
    ngl: Number.isFinite(Number(a.localNgl)) ? Number(a.localNgl) : 99,
  };
}

export function local3bBase(cfg) {
  return `http://127.0.0.1:${local3bConfig(cfg).port}`;
}

/** 看看本机是不是已经有别的实例在跑（默认顺带看 18080），避免起第二个把显存打爆 */
export async function anyResident3b(cfg, extraPorts = [18080]) {
  const cfgPort = local3bConfig(cfg).port;
  const ports = [...new Set([cfgPort, ...extraPorts.map(Number)].filter((p) => Number.isFinite(p) && p > 0))];
  for (const port of ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (r.ok) return port;
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:50'); }
  }
  return 0;
}

export async function local3bAlive(cfg) {
  try {
    const r = await fetch(`${local3bBase(cfg)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return r.ok;
  } catch { return false; }
}

/** 从 netstat -ano 输出里找某端口 LISTENING 的 PID（纯函数，便于测试） */
export function parseNetstatPid(output, port = DEFAULT_PORT) {
  const re = new RegExp(`[:.]${Number(port)}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const m = line.match(re);
    if (m) return Number(m[1]) || 0;
  }
  return 0;
}

/** 某个 pid 是不是 llama-server（避免 PID 复用杀错进程；纯函数便于测试） */
export function tasklistIsLlamaServer(output, pid) {
  const text = String(output ?? '');
  if (!text.includes(String(pid))) return false;
  return text.toLowerCase().includes(PROCESS_NAME);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function tasklistCheck(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3000 });
    return tasklistIsLlamaServer(out, pid);
  } catch { return false; }
}

/** 没有 child 句柄时（桥接重启后）：按端口找 pid、核对进程名、补写 pid 文件 */
export function adoptLocal3bPid(cfg, log = () => {}) {
  try {
    const c = local3bConfig(cfg);
    let existing = 0;
    try { existing = Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch { existing = 0; }
    // 账本已经在且活着：只核对身份，不重写文件——重写会刷新 mtime，闲置回收永远不触发
    if (existing && pidAlive(existing) && tasklistCheck(existing)) return existing;
    let pid = existing && pidAlive(existing) ? existing : 0;
    if (!pid) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 4000 });
      pid = parseNetstatPid(out, c.port);
      if (!pid) return 0;
    }
    if (!tasklistCheck(pid)) return 0;
    if (pid === existing) return pid;
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid), 'utf8');
    log(`[local-3b] 接管已有实例 pid=${pid}（端口 ${c.port}），闲置回收继续生效`);
    return pid;
  } catch { return 0; }
}

/** 用过一次就记时间，供闲置清理；顺便刷新 pid 文件 mtime（跨重启的"最后使用"证据） */
export function touchLocal3b() {
  lastUsedAt = Date.now();
  try {
    if (fs.existsSync(PID_FILE)) fs.utimesSync(PID_FILE, new Date(), new Date());
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:119'); }
}

/**
 * 按需拉起（不阻塞、不抛错）。返回是否"现在就可直接调用"。
 * 第一次调用通常是 false（后台加载中），下一轮唤醒就能用。
 */
export async function ensureLocal3b(cfg, log = () => {}) {
  if (await local3bAlive(cfg)) { touchLocal3b(); return true; }
  const c = local3bConfig(cfg);
  if (!fs.existsSync(c.exe)) { log(`[local-3b] 缺少 llama-server：${c.exe}`); return false; }
  if (!fs.existsSync(c.modelPath)) { log(`[local-3b] 缺少模型文件：${c.modelPath}`); return false; }
  if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return false;
  const resident = await anyResident3b(cfg);
  if (resident) {
    log(`[local-3b] 本机已有本地 3B 在跑（:${resident}），不再起第二个（避免显存打爆）`);
    return false;
  }
  lastSpawnAt = Date.now();
  try {
    const logFile = path.join(LOG_DIR, 'local-3b.log');
    const out = fs.openSync(logFile, 'a');
    child = spawn(c.exe, [
      '-m', c.modelPath,
      '--host', '127.0.0.1',
      '--port', String(c.port),
      '-c', String(c.ctx),
      '-ngl', String(c.ngl),
      '--no-webui',
    ], { cwd: path.dirname(c.exe), detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    try { fs.writeFileSync(PID_FILE, String(child.pid), 'utf8'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:150'); }
    log(`[local-3b] 后台拉起（端口 ${c.port}，模型 ${path.basename(c.modelPath)}），加载完成后下一轮可用`);
    touchLocal3b();
    return false;
  } catch (error) {
    log(`[local-3b] 拉起失败（降级用规则）: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * 通用补全：给"用本地 3B 做结构化抽取"这类调用一个入口（不经过 DSH、不花云端 token）。
 * 模型没起时返回 null（调用方自己决定降级），不在这里拉长超时。
 */
export async function completeLocal3b(cfg, { prompt, maxTokens = 256, timeoutMs = 15000, temperature = 0.2, log = () => {} } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) return null;
  if (!(await local3bAlive(cfg))) { void ensureLocal3b(cfg, log).catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/memory/local-3b.js:169')); return null; }
  try {
    const res = await fetch(`${local3bBase(cfg)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: local3bConfig(cfg).modelName,
        messages: [{ role: 'user', content: text }],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15000)),
    });
    if (!res.ok) { log(`[local-3b] 补全失败 HTTP ${res.status}`); return null; }
    const data = await res.json();
    const out = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!out) return null;
    touchLocal3b();
    return out;
  } catch (error) {
    log(`[local-3b] 补全异常（降级）: ${error?.message ?? error}`);
    return null;
  }
}

/** 该不该杀掉这个实例：有 pid、且"最后一次使用"超过 idleMs。fromFile 用 pid 文件 mtime 当证据。 */
export function shouldSweep({ now = Date.now(), lastUsedAt = 0, lastSpawnAt = 0, pidFileMtime = 0, idleMs = 600000, pid = 0, fromFile = false } = {}) {
  if (!pid || !idleMs) return false;
  const basis = fromFile
    ? Number(pidFileMtime) || 0
    : Math.max(Number(lastUsedAt) || 0, Number(lastSpawnAt) || 0);
  if (!basis) return false;
  return now - basis >= idleMs;
}

export function startLocal3bSweeper(cfg, log = () => {}) {
  if (sweeper) return;
  // 启动先接管一次：上次桥接留下的实例也要能被回收
  try { adoptLocal3bPid(cfg, log); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:206'); }
  sweeper = setInterval(() => {
    (async () => {
      const alive = await local3bAlive(cfg);
      if (!alive) return;
      const c = local3bConfig(cfg);
      let pid = child?.pid || 0;
      let fromFile = false;
      if (!pid) {
        try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; fromFile = true; } catch { pid = 0; }
        if (!pid) pid = adoptLocal3bPid(cfg, log);
        if (pid) fromFile = true;
      }
      if (!pid) return; // 找不到可核对的进程，不碰
      if (!tasklistCheck(pid)) { // pid 被复用或不是 llama-server：清掉坏账，不杀
        try { fs.unlinkSync(PID_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:221'); }
        child = null;
        return;
      }
      let pidFileMtime = 0;
      try { pidFileMtime = fs.statSync(PID_FILE).mtimeMs; } catch { pidFileMtime = 0; }
      if (!shouldSweep({ lastUsedAt, lastSpawnAt, pidFileMtime, idleMs: c.idleMs, pid, fromFile })) return;
      try {
        process.kill(pid, 'SIGTERM');
        try { fs.unlinkSync(PID_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:230'); }
        log(`[local-3b] 闲置 ${Math.round(c.idleMs / 60000)} 分钟，已退出（释放显存）`);
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'local-3b.js:232'); }
      child = null;
    })().catch((e) => globalThis.__ignoredCatch?.(e, 'src/domain/memory/local-3b.js:236'));
  }, 60_000);
  sweeper.unref?.();
}


