// console-routes/tokens.mjs · 第三批迁出：[SPLIT 第三批] token 用量账本 5 个路由
//
// 契约与另两组一致：{ method, path, handle(ctx) }，ctx = { req, res, url, sendJson, readBody, deps, auth }。
// 分支体逐字来自 console-server.mjs 的 tokens 外层块，仅把 __deps. 改为 deps.。
//
// 行为保留要点：
//  - 原外层块开头的「组级 403：x-agent-token 一律拒绝」与全局 agent 白名单闸门（console-server 内
//    `if (req.headers['x-agent-token']) { ... agentAllowed 白名单 ... }`）完全重合——
//    /api/tokens/* 不在白名单，agent token 请求早已在全局闸门处 403，故此处不再重复该守卫。
//  - 原外层块末尾的「内部 404 兜底」由 router 未命中 → legacy ladder 末位 404 一并兜底，等价。
//  - /api/tokens/turns 对未知会话返回 404（「未找到该会话的用量记录」）的语义保留在 handler 内部。

export const tokenRoutes = [
  {
    method: 'GET',
    path: '/api/tokens/summary',
    handle: async ({ url, sendJson, deps }) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ...deps.tokenLedger.summary({ limit }), ledger: deps.tokenLedger.stats() });
    },
  },
  {
    method: 'GET',
    path: '/api/tokens/series',
    handle: async ({ url, sendJson, deps }) => {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
      sendJson(deps.tokenLedger.series({ hours, maxBuckets }));
    },
  },
  {
    method: 'GET',
    path: '/api/tokens/turns',
    handle: async ({ url, sendJson, deps }) => {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const detail = deps.tokenLedger.conversation(key, { turnLimit: limit });
      if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
      sendJson(detail);
    },
  },
  {
    method: 'GET',
    path: '/api/tokens/recent',
    handle: async ({ url, sendJson, deps }) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      sendJson({ ok: true, symbol: deps.priceTable.symbol, entries: deps.tokenLedger.recent(limit) });
    },
  },
  {
    method: 'POST',
    path: '/api/tokens/reset',
    handle: async ({ sendJson, deps }) => {
      deps.tokenLedger.reset();
      deps.log('控制台：token 用量账本已重置');
      sendJson({ ok: true });
    },
  },
];
