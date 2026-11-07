// SnowLuma token 自愈：发现新 token/端点、写回 config、重连 SDK。
//
// 从 app.mjs 的 main() 搬出（P3-RW-44，2026-11-01）。断线看护/拉起网关仍在 app；
// 本模块只负责「token 变了就修」这一条链。
/**
 * @param {object} ctx
 */
export function createSnowLumaToken(ctx) {
  const {
    cfg, bot, path, ROOT, log, persistSnowLumaEndpoint, persistToken,
    discoverSnowLumaConnection,
  } = ctx;
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    const wsUrl = r.wsUrl || cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken, wsUrl, httpUrl: r.baseUrl
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'snowluma-token-service.mjs:12578'); }
      try { bot.connect(); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'snowluma-token-service.mjs:12579'); }
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      if (r.updated) log(`🔄 已把当前 token 写回 config.json（${String(r.from).slice(0, 4)}… → ${String(r.to).slice(0, 4)}…）`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'snowluma-token-service.mjs:12589'); }
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  return { applyHealedTokens, syncTokenToFile, healTokenIfStale };
}
