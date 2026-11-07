// 模型目录：优先 DSH 的 session 模型清单，失败回落内置清单，并缓存价格表。
//
// 从 app.mjs 的 main() 搬出（P3-RW-53，2026-11-01）。只读 API/写内存缓存，不发消息。
/**
 * @param {object} ctx
 */
export function createModelCatalog(ctx) {
  const { cfg, log, api, state, TOKEN_USAGE_FILE, createTurnCollector, createSessionTelemetry, createTokenLedger, resolvePriceTable } = ctx;
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  return { fetchModelCatalog };
}
