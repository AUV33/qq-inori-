// console-routes/admin.mjs · 管理类路由（需管理员令牌）
//
// [DEGRADED] DSH 降级保底相关（策略 B：DSH 挂掉时缓冲消息 + 发状态提示，不切本地回复）：
//   GET  /api/admin/dsh-queue  —— 查看缓冲队列（state/dsh-down-queue.jsonl）状态
//   POST /api/admin/dsh-replay —— DSH 恢复后重投缓冲的未处理回合（调 app 注入的 dshReplay）
import { loadDshDownQueue } from '../../domain/conversation/dsh-degraded.mjs';

// 需要管理员令牌才放行；鉴权函数不可用或失败一律拒绝（失败关闭）。
// 令牌来源与控制台全局鉴权一致：?token= 或 x-console-token 头。
function requireOwner(ctx) {
  const suppliedToken = String(ctx.url.searchParams.get('token') ?? ctx.req.headers['x-console-token'] ?? '');
  try {
    if (typeof ctx.auth?.ownerPrivateTokenOk === 'function') {
      if (ctx.auth.ownerPrivateTokenOk(suppliedToken)) return null;
    }
  } catch { /* 鉴权异常按拒绝处理 */ }
  return { ok: false, error: '需要管理员令牌', code: 403 };
}

export const adminRoutes = [
  {
    method: 'GET',
    path: '/api/admin/dsh-queue',
    handle: async (ctx) => {
      const denied = requireOwner(ctx);
      if (denied) return ctx.sendJson(denied, denied.code || 403);
      const items = loadDshDownQueue({ stateDataPath: ctx.deps.stateDataPath });
      const pending = items.filter((i) => i.status === 'pending');
      return ctx.sendJson({ ok: true, total: items.length, pending: pending.length, recent: items.slice(-50) });
    },
  },
  {
    method: 'POST',
    path: '/api/admin/dsh-replay',
    handle: async (ctx) => {
      const denied = requireOwner(ctx);
      if (denied) return ctx.sendJson(denied, denied.code || 403);
      const result = ctx.deps.dshReplay ? ctx.deps.dshReplay() : { ok: false, error: 'dshReplay 未注入' };
      return ctx.sendJson({ ok: true, result });
    },
  },
];
