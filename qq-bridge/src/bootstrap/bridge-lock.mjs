// bridge-lock.mjs · 单实例锁（从 app.mjs 抽出，2026-11-06 Wave 1）
//
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），否则接管。
// 进程退出/崩溃后锁自动失效（PID 校验）。
//
// 抽出时保持逻辑逐字一致；app.mjs 仍保留模块级细委托绑定（acquireLock/releaseLock/
// consolePortInUse）以守住 test-app-facade-wiring 的源码契约（consoleDeps 的
// `get releaseLock() { return releaseLock; }` 要求该标识符在 app.mjs 内可声明/导入）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJsonSafe } from './fs-utils.mjs';

export function createBridgeLock({ STATE_DIR, ROOT }) {
  const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

  /**
   * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
   *
   * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
   * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
   * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
   * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
   */
  let portProbeFailed = false;
  function consolePortInUse() {
    try {
      const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
      const port = Number(cfg?.consolePort) || 3100;
      let out;
      if (process.platform === 'win32') {
        out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      } else {
        out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      }
      return new RegExp(`[:.]${port}\\s`).test(out);
    } catch {
      // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
      // 这是有意的 fail-closed：正常运行几天的实例锁文件同样很旧，不能靠锁 mtime 猜「过期」。
      portProbeFailed = true;
      return true;
    }
  }
  function portProbeFailureHint() {
    return portProbeFailed
      ? `（注意：本次控制台端口探测失败，netstat/ss 不可用，无法确认是否真有实例。请先确认没有桥接在运行，再手动删除 ${LOCK_FILE} 后重试；不要为了绕过而改小锁窗口，那会造成双实例抢消息。）`
      : '';
  }

  function acquireLock() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
    const tryCreate = () => {
      try {
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (tryCreate()) return;
    // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
    let stale = false;
    // [LOCK-FRESH] 启动窗口：第一个实例刚写锁、还没 LISTENING 时，端口探测会误判「没人在跑」。
    // 锁文件 90 秒内一律不偷，避免第二个实例把正在启动的实例锁删掉。
    let lockFresh = false;
    try { lockFresh = Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 90_000; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'bridge-lock.mjs:60'); }
    try {
      const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      if (!content) {
        stale = true;
      } else {
        const pid = Number(content);
        if (!Number.isInteger(pid) || pid <= 0) {
          stale = true;
        } else {
          try {
            process.kill(pid, 0);
            // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
            // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
            if (!consolePortInUse()) {
              if (lockFresh) {
                console.error(`[bridge] 锁文件很新（PID ${pid} 仍在），控制台端口还没起来：另一个实例可能正在启动，拒绝抢锁。`);
                process.exit(2);
              }
              stale = true;
            }
          } catch (error) {
            if (error.code === 'ESRCH') {
              stale = true;
            } else if (error.code === 'EPERM') {
              // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
              // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
              // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
              // 而且提示信息把人引向「已有实例在运行」这个错误方向。
              // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
              if (consolePortInUse()) {
                console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
                console.error('[bridge] 若 http://127.0.0.1:3100/api/status 无响应，说明旧实例假死：看护会在约 60 秒内杀掉并重启；急用可 taskkill /PID ' + pid + ' /F。');
                process.exit(2);
              }
              if (lockFresh) {
                console.error(`[bridge] 锁文件很新（PID ${pid} 无权限探测）且控制台端口还没起来：按“可能正在启动”处理，拒绝抢锁。`);
                process.exit(2);
              }
              console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
              stale = true;
            } else {
              console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
              process.exit(2);
            }
          }
        }
      }
    } catch (readError) {
      console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
      process.exit(1);
    }
    if (stale) {
      console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
      try { fs.unlinkSync(LOCK_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'bridge-lock.mjs:113'); }
      if (tryCreate()) return;
    }
    console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。${portProbeFailureHint()}`);
    console.error('[bridge] 若 http://127.0.0.1:3100/api/status 无响应，说明旧实例假死：看护会在约 60 秒内杀掉并重启；急用可 taskkill /PID ' + '（见锁文件）' + ' /F。');
    process.exit(2);
  }
  function releaseLock() {
    try {
      if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'bridge-lock.mjs:124'); }
  }

  return { acquireLock, releaseLock, consolePortInUse };
}
