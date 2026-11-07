// SnowLuma 看护：连续断线计数、心跳/连接刷新、静默超过阈值时拉起网关。
//
// 从 app.mjs 的 main() 搬出（P3-RW-62，2026-11-01）。状态随模块，app 通过
// noteOpen/noteClose/noteHeartbeat 更新；拉起只做一次/10 分钟。
/**
 * @param {object} ctx
 */
export function createSnowLumaWatchdog(ctx) {
  const { fs, path, __dirname, spawn, log } = ctx;
  let wsCloseStreak = 0;
  let wsLastOkAt = Date.now();
  let watchdogAt = 0;
  function watchdogSnowLuma(reason) {
    const now = Date.now();
    if (now - watchdogAt < 600000) return;
    if (now - wsLastOkAt < 180000) return;
    watchdogAt = now;
    try {
      // [WSH-POPUP] 这里以前传的是相对文件名 'silent-snowluma.vbs'，桥接 cwd 是 qq-bridge，
      // 脚本其实在上一级 → wscript 找不到文件就弹「Windows Script Host 找不到脚本文件」模态框，
      // 而这段是 10 分钟一次的看护重试，所以弹窗会反复出现（2026-10-30 02:24 实测抓到）。
      const vbsPath = path.resolve(__dirname, '..', '..', 'silent-snowluma.vbs');
      if (!fs.existsSync(vbsPath)) {
        log(`[SNOWLUMA-WATCHDOG] ${reason}：找不到 ${vbsPath}，跳过拉起（不再弹脚本错误框）`);
        return;
      }
      const cp = spawn('wscript', ['//nologo', vbsPath], { detached: true, stdio: 'ignore', windowsHide: true });
      cp.unref?.();
      log(`[SNOWLUMA-WATCHDOG] ${reason}：已尝试拉起 SnowLuma（10 分钟内只试一次）`);
    } catch (error) {
      log(`[SNOWLUMA-WATCHDOG] 拉起失败：${error?.message ?? error}`);
    }
  }

  function noteOpen() { wsCloseStreak = 0; wsLastOkAt = Date.now(); }
  function noteHeartbeat() { wsLastOkAt = Date.now(); }
  function noteClose() { wsCloseStreak += 1; return wsCloseStreak; }

  return { watchdogSnowLuma, noteOpen, noteHeartbeat, noteClose };
}
