// [CRASH-FORENSICS] 死因取证（2026-10-25：桥接连死 3 次均无日志痕迹，系统事件/WER 零崩溃记录
// → 判定为外部 kill（停止全部.bat / 关控制台窗口），非代码崩溃。本模块把「下次死亡的时刻与方式」钉死：
//  - 致命行：catchable 的（uncaughtException / unhandledRejection / SIGTERM / exit）全部先落盘再走
//  - 心跳行：每 5 分钟一条。外部 kill（taskkill /F）到不了 handler，死亡窗口 = 最后一条心跳 → 检测时刻
// 单独成模块（不塞进 bridge.js 巨文件）：并行写入者覆盖 bridge.js 时本文件不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStartupFingerprint, formatFingerprint } from './domain/shared/startup-fingerprint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.join(HERE, '..');
const STATE_DIR = path.join(BRIDGE_DIR, 'state');
const CRASH_LOG = path.join(STATE_DIR, 'crash.log');
// [P0-FIX] 本模块经 --import 最先加载，模块顶层即向 state/crash.log 写入（见下方
// crashLog('startup')）。但 STATE_DIR 直到 app.mjs 才创建，若进程在最早启动阶段崩溃
// （config 解析/依赖加载失败、rm -rf state 后首次启动），appendFileSync 会因目录不存在
// 抛 ENOENT 被静默吞掉 → 正是当初建此模块要解决的"连死无日志"场景。这里先建好目录。
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (error) { /* best-effort */ }

// [P1-3] 启动指纹只算一次：git / config.json 读取有 IO 成本，进程生命周期内版本不该变。
// 任何一步失败都降级 unknown（见 startup-fingerprint.js），绝不挡启动。
const STARTUP_FINGERPRINT = formatFingerprint(buildStartupFingerprint({
  root: path.join(BRIDGE_DIR, '..'),
  configPath: path.join(BRIDGE_DIR, 'config.json'),
}));

function crashLog(kind, detail = '') {
  try {
    const rss = Math.round((process.memoryUsage?.().rss ?? 0) / 1048576);
    const now = new Date();
    // [LOCAL-TIME] 同时写本地时间：之前只写 UTC，排查时容易把 04:24Z 误读成凌晨 4 点（实际是本地 12:24）
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    fs.appendFileSync(CRASH_LOG, `${now.toISOString()} [local ${local}] [${kind}] pid=${process.pid} rss=${rss}MB ${String(detail).slice(0, 2000)}\n`, 'utf8');
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'crash-forensics.js:30'); }
  // [ERROR-OBSERVED] 致命/未处理错误是完整性维最该看到的错误来源，统一从这里上报（best-effort）。
  if (kind !== 'heartbeat' && kind !== 'startup' && kind !== 'exit') {
    try { globalThis.__ignoredCatch?.(new Error(String(detail).slice(0, 200)), `crash-forensics:${kind}`); } catch (error) { void error; }
  }
}

// [SINGLE-FATAL-POLICY] 本模块由 --import 最先加载，是**唯一**的致命策略拥有者。
// 旧实现在这里直接 process.exit(1)，而 app.mjs 后注册的 uncaughtException handler
// 负责 saveState()/releaseLock() —— 前者抢先退出会让状态的最后一次保存永远跑不到。
// 现在宿主通过 __setCrashBeforeFatal 注入"退出前要做的事"，本模块保证先调用再退出。
let beforeFatal = null;
globalThis.__setCrashBeforeFatal = (fn) => { if (typeof fn === 'function') beforeFatal = fn; };
function fatal(kind, err) {
  crashLog(kind, err?.stack ?? String(err));
  try { if (beforeFatal) beforeFatal(kind, err); } catch (error) { crashLog('before-fatal-failed', error?.stack ?? String(error)); }
  process.exit(1);
}

// [UNCAUGHT-POLICY] 单点同步异常不再一枪打死整个 QQ 机器人（历史：一次 ReferenceError
// 让全群全私聊失联）。与 unhandledRejection 同策略：60s 内累计 3 次才判定失控退出；否则只
// 落盘取证，让单条消息/单个会话的异常被隔离，其余会话继续服务。代价：极个别会把进程置于
// 不一致状态的同步错误可能多活一会儿——但 7×24 服务里「一个会话崩全挂」比「单点异常被隔离」更糟。
// 限频致命策略共用的常量（先于两个 handler 声明，避免源码顺序错位 / TDZ 歧义）。
const REJECTION_WINDOW_MS = 60_000;
const REJECTION_FATAL_COUNT = 3;
const RECENT_UNCAUGHT = [];
const RECENT_REJECTIONS = [];
process.on('uncaughtException', (err) => {
  crashLog('uncaughtException', err?.stack ?? String(err));
  const now = Date.now();
  while (RECENT_UNCAUGHT.length && now - RECENT_UNCAUGHT[0] > REJECTION_WINDOW_MS) RECENT_UNCAUGHT.shift();
  RECENT_UNCAUGHT.push(now);
  if (RECENT_UNCAUGHT.length >= REJECTION_FATAL_COUNT) {
    fatal('uncaughtException-fatal', new Error(`60s 内 ${RECENT_UNCAUGHT.length} 次未捕获异常，判定失控退出`));
  }
});
// [UNHANDLED-POLICY] 未处理的 Promise rejection 不再一枪打死整个桥接。
// 实证：2026-11-02 一次 `ReferenceError: path is not defined`（单条 async 分支）
// 就让进程 exit(1)，全群全私聊一起断。单次偶发错误只落盘，60s 内 3 次才判失控。
process.on('unhandledRejection', (reason) => {
  crashLog('unhandledRejection', reason?.stack ?? String(reason));
  const now = Date.now();
  while (RECENT_REJECTIONS.length && now - RECENT_REJECTIONS[0] > REJECTION_WINDOW_MS) RECENT_REJECTIONS.shift();
  RECENT_REJECTIONS.push(now);
  if (RECENT_REJECTIONS.length >= REJECTION_FATAL_COUNT) {
    fatal('unhandledRejection-fatal', new Error(`60s 内 ${RECENT_REJECTIONS.length} 次未处理 rejection，判定失控退出`));
  }
});
// [SIGTERM-ORDER] 这里只落盘、不退出：app.mjs 在同一信号上还要 saveState()/releaseLock()。
// 旧写法在这里 process.exit(0)，后面的监听器不再执行 —— 用 start.bat（--import）启动时状态的最后一次保存被整个跳过。
process.on('SIGTERM', () => {
  crashLog('SIGTERM', '收到 SIGTERM（taskkill /F 不会走到这里）');
  // [AUDIT-FIX] 只有宿主（app.mjs）也注册了 SIGTERM 时，这里才应该"只落盘不退出"；
  // 若 app.mjs 顶层求值就失败，宿主 handler 从未注册，必须自己退出，否则进程永远杀不掉。
  if (process.listenerCount('SIGTERM') <= 1) process.exit(0);
});
process.on('exit', (code) => crashLog('exit', `code=${code}`));
crashLog('startup', `node=${process.version} ${STARTUP_FINGERPRINT}`);
// [HEARTBEAT] 1 分钟一次，死亡窗口精度从 5 分钟降到 1 分钟；unref 不阻止正常退出。
const heartbeatTimer = setInterval(() => crashLog('heartbeat', ''), 60 * 1000);
heartbeatTimer.unref?.();

export {};
