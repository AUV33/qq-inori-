// 黑话库落盘：只读降级、清理僵尸候选、上限丢弃日志。
//
// 从 app.mjs 的 main() 搬出（P3-RW-61，2026-11-01）。slangEntries/slangStoreWritable
// 由 app 持有，通过 getter/setter 读写。
/**
 * @param {object} ctx
 */
export function createSlangStore(ctx) {
  const {
    log, logAction, saveSlang, SLANG_FILE, SLANG_MAX_ENTRIES, getSlangEntries,
    setSlangEntries, getSlangStoreWritable,
  } = ctx;
  function saveSlangStore() {
    // [WIRING-FIX] 这里原来直接读 `slangStoreWritable`（app.mjs 的闭包变量），搬出后是未声明标识符：
    // 每次保存都 ReferenceError → 黑话库永远落不了盘，重启即丢。改为走注入的 getter。
    if (!getSlangStoreWritable()) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, getSlangEntries());
      // [SLANG-PRUNE-LOG] 清尸结果可核查：bridge.log + action-log 双写（日志会轮转，账本不会）
      if (result?.staled) {
        log(`[slang] 清理僵尸候选 ${result.staled} 条（标 stale）`);
        try { logAction({ t: 'slang', action: 'prune', staled: result.staled, total: result.entries?.length ?? 0 }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'slang-store-service.mjs:2840'); }
      }
      if (result?.dropped > 0) {
        setSlangEntries(result.entries);
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  return { saveSlangStore };
}
