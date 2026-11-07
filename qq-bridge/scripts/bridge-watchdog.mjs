#!/usr/bin/env node
// bridge-watchdog.mjs · 桥接看护：3100 连续掉线就把它拉起来（只读探测，不改任何状态）
//
// 为什么要有它：2026-10-27 18:50 桥接硬消失（crash.log 没有 exit 行，日志停在回合中途），
// 45 分钟没人发现。这不是代码崩溃，所以进程内的钩子救不了；只能在进程外面看门。
//
// 判据：TCP 能连上 3100 = 活着。连续 failThreshold 次（默认 3 次 × 20s = 1 分钟）才动手，
// 避免重启窗口里误判。拉起走 silent-bridge.vbs（和开机同一入口），拉完再验一次。
// 只写 state/watchdog.log，不碰 bridge 的状态文件。
//
// [WATCHDOG-2026-10-29] 昨夜发现两个问题：
//   ① 拉起只等 15 秒就判失败——桥接冷启动（SnowLuma 重连 + 表情同步）实测要 15~35 秒，
//      00:30 那次 15s 判失败、结果 33 秒后自己起来了；
//   ② 拉起是 fire-and-forget（stdio: 'ignore' + 不验 PowerShell 退出码），VBS 那条链失败时
//      watchdog 毫无记录，连着好几轮"拉起后 3100 仍无响应"，实际是根本没发出去或发出去就退了。
// 现在：拉起结果可观测（PowerShell 退出码/错误落日志），等活改成轮询 45s；VBS 仍不起就
// 直接 spawn node（stdio ignore，避免管道断开 EPIPE）兜底；recoverOnce 抽成可注入的流程，
// 单测里用假 launcher 覆盖三条分支。
// [HUNG-KILL 2026-10-31] 归因为 hung 时旧进程还握着 bridge.lock，只 re-spawn 会让新实例
// exit(2)；现在先 killPid(SIGKILL/taskkill) 再 recover，kill 失败下轮重试。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(BRIDGE_DIR, '..');
const LOG = path.join(BRIDGE_DIR, 'state', 'watchdog.log');
// [P1-1 掉线账本] 每次探测失败/恢复写一行 JSONL，health-check 直接读它做 24h 统计。
const INCIDENTS = path.join(BRIDGE_DIR, 'state', 'incidents.jsonl');
// [P1-2 归因] 桥接单实例锁（PID）与 crash.log（有没有 [exit]）是判死因的两个证据源。
const LOCK_FILE = path.join(BRIDGE_DIR, 'state', 'bridge.lock');
const CRASH_LOG = path.join(BRIDGE_DIR, 'state', 'crash.log');
const PORT = 3100;
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS) || 20_000;
const FAIL_THRESHOLD = Number(process.env.WATCHDOG_FAILS) || 3;
const VBS = path.join(ROOT, 'silent-bridge.vbs');

function log(line) {
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  try { fs.appendFileSync(LOG, `[${ts}] ${line}\n`, 'utf8'); } catch { /* 记录失败不挡看护 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── P1-1 / P1-2：掉线账本与归因 ──────────────────────────────────────────────
// 以前只能看到「连不上」，分不清崩溃/被强杀/卡死。现在每次掉线都落一行证据，
// 让 72 小时验收可以说出「哪天几点、因为什么、怎么恢复、花了多久」。

/** 读桥接单实例锁里的 PID；没有锁/坏值返回 null（不抛错）。 */
export function readBridgePid(lockFile = LOCK_FILE, readFile = fs.readFileSync) {
  try {
    const pid = Number(String(readFile(lockFile, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** PID 是否还活着（signal 0）。EPERM = 进程存在但没权限探测，按活着算。 */
export function isPidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 杀掉「进程在、端口不通」的旧桥接。
 * 先走 process.kill(SIGKILL)；Windows 上失败再走 taskkill /F 兜底。
 * 绝不杀自己（看护进程的 pid）。
 */
export function killPid(pid, { kill = process.kill, spawnSyncFn = spawnSync, selfPid = process.pid } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) return { ok: false, error: 'bad-or-self-pid' };
  try {
    kill(pid, 'SIGKILL');
    return { ok: true, by: 'signal' };
  } catch (error) {
    if (process.platform === 'win32') {
      try {
        const r = spawnSyncFn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 5000 });
        if (r?.status === 0) return { ok: true, by: 'taskkill' };
        return { ok: false, error: `taskkill exit ${r?.status ?? '?'}` };
      } catch (e2) {
        return { ok: false, error: String(e2?.message ?? e2) };
      }
    }
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** crash.log 末尾的最后一个 [startup] pid——锁文件被正常退出删掉时用它兜底。 */
function lastStartupPid(text) {
  const matches = [...String(text ?? '').matchAll(/\[startup\] pid=(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

/**
 * 归因三分（规划 §3 P1-2）：
 *  - 进程在、端口不通 → `hung`（卡死）
 *  - 进程不在、crash.log 有该 PID 的 `[exit]` → `exited`（正常退出）
 *  - 进程不在、没有 `[exit]` → `killed`（被杀 / 崩到没走 handler，例如 taskkill /F）
 * 锁文件不存在时用 crash.log 最后一条 `[startup]` 的 PID 兜底；都没有 → `unknown`。
 */
export function classifyDrop({ pid, pidAlive, crashLogText = '' } = {}) {
  const text = String(crashLogText ?? '');
  const target = Number.isInteger(pid) && pid > 0 ? pid : lastStartupPid(text);
  if (!target) return 'unknown';
  if (pidAlive) return 'hung';
  return new RegExp(`\\[exit\\] pid=${target}(?:\\s|$)`, 'm').test(text) ? 'exited' : 'killed';
}

/** 追加一行掉线账；写失败不得拖垮看护。 */
export function appendIncident(record, { file = INCIDENTS, appendFile = fs.appendFileSync } = {}) {
  try {
    appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 只读 crash.log 尾部 64KB 用于归因，避免大文件全量读。 */
function readCrashLogTail(bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(CRASH_LOG, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** 探测一次失败时的归因快照（PID 取自锁文件，存活用 signal 0 判）。 */
export function dropContext({ pid, crashLogText } = {}) {
  const bridgePid = pid === undefined ? readBridgePid() : pid;
  const alive = isPidAlive(bridgePid);
  return {
    pid: bridgePid,
    pidAlive: alive,
    cause: classifyDrop({ pid: bridgePid, pidAlive: alive, crashLogText: crashLogText ?? readCrashLogTail() }),
  };
}

/** 写一条掉线账（event + 归因 + 可选恢复信息），时间用本地 ISO。 */
export function recordIncident(event, { port = PORT, cause = 'unknown', pid = null, pidAfter = null, fails = null, by = null, recoveryMs = null, appendFile = fs.appendFileSync, file = INCIDENTS } = {}) {
  const record = { ts: new Date().toISOString(), event, port, cause, pid };
  if (pidAfter !== null) record.pidAfter = pidAfter;
  if (fails !== null) record.fails = fails;
  if (by !== null) record.by = by;
  if (recoveryMs !== null) record.recoveryMs = recoveryMs;
  return appendIncident(record, { file, appendFile });
}


/**
 * 只读探测：不只看「端口能连上」，还要求桥接真的回了 HTTP。
 *
 * 为什么不能只做 TCP connect：进程假死（事件循环被同步锁/死循环卡住）时，
 * 内核仍会完成 TCP 握手（连接进 backlog），connect 成功但没有任何字节回来。
 * 2026-11-07 的假死就是这样：看护连续 150 轮报「存活正常」，实际桥接已停止工作。
 * 这里发一个 /api/status 请求，收到任何 HTTP 响应（含 401 鉴权失败）都算活。
 */
export function probe(port = PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => {
      try {
        sock.write('GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      } catch { done(false); }
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.startsWith('HTTP/')) done(true);
    });
    sock.once('error', () => done(false));
    sock.once('close', () => done(false));
  });
}

/** 轮询等活：桥接冷启动要十几秒，不能一锤子判死。 */
export async function waitAlive(probeFn = probe, timeoutMs = 45_000, stepMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeFn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

/** 走和开机一样的入口（silent-bridge.vbs）；把 PowerShell 的退出码/错误带回来，失败不再是黑箱。 */
export function startViaVbs({ timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const script = [
      '-NoProfile',
      '-Command',
      `Start-Process wscript.exe -ArgumentList '//nologo','${VBS.replace(/'/g, "''")}' -WindowStyle Hidden`,
    ];
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn('powershell', script, { cwd: ROOT, windowsHide: true, env: { ...process.env, BRIDGE_LAUNCH_SOURCE: 'watchdog-vbs' } });
    } catch (error) {
      finish({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => finish({ ok: false, error: String(e?.message ?? e) }));
    child.on('exit', (code) => finish({ ok: code === 0, error: code === 0 ? '' : (err.trim() || `powershell exit ${code}`) }));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: true, error: 'timeout' }); }, timeoutMs);
  });
}

/** 兜底：直接起 node。stdio 用 ignore——管道写在父进程退出后会 EPIPE 把桥接打死（2026-10-29 踩过）。 */
export function startDirect() {
  try {
    const child = spawn(process.execPath, ['--import', './src/crash-forensics.js', 'src/bridge.js'], {
      cwd: BRIDGE_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, BRIDGE_LAUNCH_SOURCE: 'watchdog-direct', CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 一次恢复尝试：先 VBS（正常入口），等活 45s；不行就直接起 node，等 30s。
 * 依赖全部可注入，单测里用假 launcher / 假 wait 验证三条分支。
 * @returns {Promise<{by:'vbs'|'direct'|'none', ok:boolean}>}
 */
export async function recoverOnce({
  startVbs = startViaVbs,
  startNode = startDirect,
  // 注意签名：这里的 wait 收「毫秒」，不是 probe 函数——2026-10-29 第一次真机验证时
  // 直接把 waitAlive 传进来，waitAlive(45000) 把 45000 当 probeFn，watchdog 自己崩了。
  wait = (ms) => waitAlive(probe, ms),
  log = () => {},
} = {}) {
  const v = await startVbs();
  log(v?.ok ? 'VBS 拉起已发出' : `VBS 拉起失败：${v?.error || '未知错误'}`);
  if ((v?.ok || v?.error === 'timeout') && await wait(45_000)) return { by: 'vbs', ok: true };
  log('VBS 拉起 45s 内没起来，改直接起 node');
  const d = startNode();
  log(d?.ok ? `直接起 node pid=${d.pid}` : `直接拉起失败：${d?.error || '未知错误'}`);
  if (!d?.ok) return { by: 'none', ok: false };
  if (await wait(30_000)) return { by: 'direct', ok: true };
  return { by: 'direct', ok: false };
}

/**
 * 看护主循环。抽出来是为了能单测「掉线 → 记一笔 → 恢复 → 记一笔」的状态迁移，
 * 依赖全部可注入（探测 / 拉起 / 等待 / 记账 / 归因 / 日志）。
 */
export async function runLoop({
  probeFn = probe,
  recover = recoverOnce,
  wait = sleep,
  intervalMs = INTERVAL_MS,
  failThreshold = FAIL_THRESHOLD,
  logFn = log,
  record = recordIncident,
  context = dropContext,
  pidAfter = readBridgePid,
  pidNow = readBridgePid,
  killFn = killPid,
  maxIterations = Number.POSITIVE_INFINITY,
  heartbeatEvery = 30,
} = {}) {
  let fails = 0;
  let pending = null; // 本轮掉线上下文：{ at, pid, cause, fails, attempted }
  let lastRecoveryBy = null;
  let iterations = 0;
  for (;;) {
    const alive = await probeFn();
    if (alive) {
      if (pending) {
        const recoveryMs = Date.now() - pending.at;
        logFn(`3100 恢复（此前连续失败 ${Math.max(pending.fails, fails)} 次，用时 ${Math.round(recoveryMs / 1000)}s）`);
        record('recovered', {
          cause: pending.cause,
          pid: pending.pid,
          pidAfter: pidAfter(),
          fails: Math.max(pending.fails, fails),
          // 没发起过拉起 = 自己回来的（self）；发起过但没成功 = unknown。
          by: lastRecoveryBy ?? (pending.attempted ? 'unknown' : 'self'),
          recoveryMs,
        });
      } else if (fails > 0) {
        logFn(`3100 恢复（此前连续失败 ${fails} 次）`);
      }
      fails = 0;
      pending = null;
      lastRecoveryBy = null;
    } else {
      fails += 1;
      if (fails === 1) {
        const ctx = context();
        pending = { at: Date.now(), pid: ctx.pid, cause: ctx.cause, fails: 1, attempted: false, killed: false };
        logFn(`3100 连不上，开始计数（归因：${ctx.cause}${ctx.pid ? ` pid=${ctx.pid}` : ''}）`);
        record('down', { cause: ctx.cause, pid: ctx.pid, fails: 1 });
      } else {
        if (pending) pending.fails = fails;
        record('probe_fail', { cause: pending?.cause ?? 'unknown', pid: pending?.pid ?? null, fails });
      }
      if (fails >= failThreshold) {
        if (pending) pending.attempted = true;
        // [HUNG-KILL] 进程在、端口不通时，旧进程还握着 bridge.lock；
        // 只 re-spawn 会让新实例 exit(2)（已有实例在运行），看护永远不恢复。
        if (pending?.cause === 'hung' && pending.pid && !pending.killed) {
          // [PID-REUSE] 缓存的 pid 是 fails=1 时的快照，到动手至少过了 40 秒；这期间
          // 原桥接可能已退出、pid 被 Windows 复用。先重读 bridge.lock，pid 变了就不杀。
          const currentPid = pidNow();
          if (currentPid && Number(currentPid) !== Number(pending.pid)) {
            logFn(`3100 判定 hung，但 bridge.lock 的 pid 已变（${pending.pid} → ${currentPid}），跳过强杀`);
          } else {
            const kr = killFn(pending.pid);
            pending.killed = kr.ok;
            logFn(kr.ok
              ? `3100 判定 hung，已杀掉旧桥接 pid=${pending.pid}（${kr.by}）`
              : `3100 判定 hung，杀旧进程失败 pid=${pending.pid}：${kr.error || '未知错误'}`);
            record('kill', { cause: 'hung', pid: pending.pid, by: kr.ok ? kr.by : 'failed', fails });
          }
        }
        logFn(`3100 连续 ${fails} 次连不上，拉起桥接：${VBS}`);
        const r = await recover({ log: logFn });
        logFn(r.ok ? `拉起成功（${r.by === 'vbs' ? 'VBS' : '直接起 node'}）` : '拉起失败，等下轮再试');
        lastRecoveryBy = r.ok ? r.by : null;
        if (!r.ok) record('recovery_failed', { cause: pending?.cause ?? 'unknown', pid: pending?.pid ?? null, fails });
        fails = 0;
      }
    }
    iterations += 1;
    // [HB] 健康时也留一行心跳：否则"看护活着"在磁盘上零证据，health/人眼都看不出它死了。
    if (heartbeatEvery > 0 && iterations % heartbeatEvery === 0) {
      logFn(`[hb] watchdog 存活 pid=${process.pid} 第 ${iterations} 轮探活正常`);
    }
    if (iterations >= maxIterations) return;
    await wait(intervalMs);
  }
}

// ── [DEPS] 依赖服务看护：只启动缺失的，绝不重启活着的 ──────────────────────
// 2026-11-04 实测一天内栈整体掉线 3 次（14:18/14:36/14:42）；现有看护只管 3100，
// DSH/SnowLuma/嵌入 掉了没人管，她就离线。这里补 3080/3000/8790 的“只补缺”看护：
// 连续 2 次（约 60s）缺失才动作，10 分钟冷却，动作是官方 启动全部.bat -q（按端口去重）。
export const DEP_PORTS = Object.freeze([
  { name: 'dsh', port: 3080 },
  { name: 'onebot', port: 3000 },
  { name: 'embed', port: 8790 },
]);

export function missingDeps(status = {}) {
  return DEP_PORTS.filter((d) => status[d.name] === false).map((d) => d.name);
}

export function startMissingDeps({ spawnFn = spawn } = {}) {
  try {
    const bat = path.join(ROOT, '启动全部.bat');
    const child = spawnFn(process.env.ComSpec || 'cmd.exe', ['/c', bat, '-q'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function createDepWatcher({
  probeFn = probe,
  startAll = startMissingDeps,
  logFn = log,
  failThreshold = 2,
  cooldownMs = 10 * 60 * 1000,
  now = Date.now,
  // [MEMORY-BUDGET] 用户机器内存有限，默认只观察、不自动拉起全栈；
  // 需要自动恢复时显式 WATCHDOG_DEPS_AUTOSTART=1。
  autoStart = false,
} = {}) {
  let misses = 0;
  let lastStartAt = null;
  async function tick() {
    const status = {};
    for (const d of DEP_PORTS) status[d.name] = await probeFn(d.port);
    const missing = missingDeps(status);
    if (!missing.length) {
      if (misses) logFn('[deps] 依赖全部在线');
      misses = 0;
      return { missing, started: false };
    }
    misses += 1;
    if (misses < failThreshold) {
      logFn(`[deps] 探测失败（${missing.join(',')}），第 ${misses} 次`);
      return { missing, started: false };
    }
    if (lastStartAt !== null && now() - lastStartAt < cooldownMs) {
      logFn(`[deps] 仍缺 ${missing.join(',')}（冷却中，不重复拉起）`);
      return { missing, started: false };
    }
    if (!autoStart) {
      lastStartAt = now();
      misses = 0;
      logFn(`[deps] 仍缺 ${missing.join(',')}；只观察不自动启动（WATCHDOG_DEPS_AUTOSTART=1 才启用）`);
      return { missing, started: false, observed: true };
    }
    lastStartAt = now();
    misses = 0;
    logFn(`[deps] 连续 ${failThreshold} 次缺 ${missing.join(',')}，启动缺失服务（start-all）`);
    const r = startAll();
    logFn(`[deps] start-all ${r?.ok ? '已发出' : '失败：' + (r?.error || '未知错误')}`);
    return { missing, started: Boolean(r?.ok) };
  }
  return { tick };
}

async function main() {
  // 单实例：重复拉起（开机自启 + 手动）时只保留一个，避免桥接短暂无响应时被同时拉起两次。
  const pidFile = path.join(BRIDGE_DIR, 'state', 'watchdog.pid');
  const logFile = path.join(BRIDGE_DIR, 'state', 'watchdog.log');
  try {
    const prev = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(prev) && prev > 0 && prev !== process.pid) {
      let alive = false;
      try { process.kill(prev, 0); alive = true; } catch { /* 旧的已死，接管 */ }
      if (alive) {
        // [STALE-SINGLETON] pid 存活不等于看护活着：pid 会被复用，文件也可能残留。
        // 旧实现只看 kill(prev,0)，一旦 pid 被别的进程占用就误判"已有 watchdog"并
        // exit(0)，静默进入 0 看护。现在再看一眼 watchdog.log 是否还在更新。
        let logAgeMs = Number.POSITIVE_INFINITY;
        try { logAgeMs = Date.now() - fs.statSync(logFile).mtimeMs; } catch { /* 没日志当作过期 */ }
        if (logAgeMs < 40 * 60 * 1000) {
          log(`已有 watchdog 在跑（pid=${prev}，日志 ${Math.round(logAgeMs / 60000)} 分钟前更新），本实例退出`);
          process.exit(0);
        }
        log(`旧看护 pid=${prev} 进程还在但日志已 ${Number.isFinite(logAgeMs) ? Math.round(logAgeMs / 60000) + ' 分钟' : '很久'}没更新，判定为僵尸，接管`);
      }
    }
  } catch { /* 首次运行没有锁文件 */ }
  try { fs.writeFileSync(pidFile, String(process.pid), 'utf8'); } catch { /* 锁失败不挡看护 */ }
  // [WATCHDOG-VISIBLE] 看护自己的死因也要留痕：旧实现被外部杀/关控制台时一行都没有，
  // 死了三天只能从"日志停在某天"反推。exit/SIGTERM 都落一行，pid 文件顺手清掉。
  const cleanupPid = () => {
    try {
      const cur = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (cur === process.pid) fs.rmSync(pidFile, { force: true });
    } catch { /* 清不掉不影响退出 */ }
  };
  process.on('exit', cleanupPid);
  process.on('SIGINT', () => { log('watchdog 收到 SIGINT，退出'); process.exit(0); });
  process.on('SIGTERM', () => { log('watchdog 收到 SIGTERM，退出'); process.exit(0); });
  process.on('uncaughtException', (error) => { log(`watchdog 未捕获异常（退出）：${String(error?.stack ?? error).slice(0, 500)}`); process.exit(1); });
  process.on('unhandledRejection', (error) => { log(`watchdog 未处理 rejection：${String(error?.stack ?? error).slice(0, 500)}`); });

  log(`watchdog 启动 pid=${process.pid} 端口=${PORT} 间隔=${INTERVAL_MS}ms 阈值=${FAIL_THRESHOLD}`);
  // [DEPS] 每 30s 检查依赖服务；只补缺、不重启活着的。首次 10s 后先探一次。
  const depWatcher = createDepWatcher({ logFn: log, autoStart: process.env.WATCHDOG_DEPS_AUTOSTART === '1' });
  const depTimer = setInterval(() => { depWatcher.tick().catch(() => {}); }, 30_000);
  depTimer.unref?.();
  const depBoot = setTimeout(() => { depWatcher.tick().catch(() => {}); }, 10_000);
  depBoot.unref?.();
  log('依赖看护已启动（dsh:3080 / onebot:3000 / embed:8790）');
  await runLoop();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { log(`watchdog 自身退出：${String(error?.stack ?? error)}`); process.exitCode = 1; });
}
