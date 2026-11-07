// [SPLIT 阶段2] 从 console-server.mjs 巨型 ladder 迁出的第一组路由：只读总览类。
//
// 契约：每组导出一个数组，元素为 { method, path, handle(ctx) }。
// ctx = { req, res, url, sendJson, readBody, deps, auth } —— deps 即原 __deps，
// auth 是 createConsoleAuth(deps) 的返回对象。所有自由变量都显式经 ctx 取得，
// 模块不持有状态、不 import console-server.mjs，因此可独立构造 ctx 单测。
//
// 迁移原则：分支体逐字搬移，只把 `__deps.` → `deps.`；不改判断顺序、不改错误处理。
import { collectOverview, renderOverviewText } from '../../domain/leaves/inori-overview.js';

export const readOnlyRoutes = [
  {
    method: 'GET',
    path: '/api/state/overview',
    handle: async ({ sendJson }) => {
      // 只读跨域总览：任务 / 关系 / 媒体 / 学习引用。每次现算，不落盘、不改任何源账本。
      // 管理端信息（人物、任务全文）只给控制台令牌；带 agent token 的调用在关卡处已被拒。
      try {
        const model = collectOverview();
        sendJson({ ok: true, overview: model, text: renderOverviewText(model) });
      } catch (error) {
        sendJson({ ok: false, error: `生成总览失败：${error?.message || error}` }, 500);
      }
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/presets',
    handle: async ({ sendJson, deps }) => {
      let presets = [];
      try {
        const { presets: list } = deps.unwrap(await deps.api.agentPresets.list({}), 'agentPreset.list');
        presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-routes/read-only:presets'); }
      sendJson({ presets });
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/console/metrics',
    handle: async ({ url, sendJson, deps }) => {
      // [METRICS] 行为指标（只读）：回复延迟 / 重复率 / 未读积压 / 唤醒 / token
      try {
        const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get('hours')) || 24));
        const tokenRows = [];
        try {
          for (const line of deps.fs.readFileSync(deps.path.join(deps.STATE_DIR, 'token-usage.jsonl'), 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { tokenRows.push(JSON.parse(line)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-routes/read-only:metrics-rows'); }
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-routes/read-only:metrics-read'); }
        const report = deps.computeMetrics({
          conversations: deps.socialV2.conversations,
          tokenRows,
          windowMs: hours * 3600 * 1000,
        });
        sendJson({ ok: true, ...report });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/console/quality-trends',
    handle: async ({ url, sendJson, deps }) => {
      // [QUALITY-TRENDS] 记忆 / 经验 / 技能 / 认知的近 7・30 天趋势（只读）
      try {
        const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
        const readJsonl = (file) => {
          try {
            return deps.fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
              .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
          } catch { return []; }
        };
        const memoryDays = [];
        try {
          for (const name of deps.fs.readdirSync(deps.MEM_DIR)) {
            if (!/^memory.*\.jsonl$/i.test(name)) continue;
            for (const e of readJsonl(deps.path.join(deps.MEM_DIR, name))) if (e?.day) memoryDays.push(e.day);
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-routes/read-only:trends-memory'); }
        const lessons = readJsonl(deps.stateDataPath('lessons.jsonl'));
        let skills = [];
        try {
          const raw = JSON.parse(deps.fs.readFileSync(deps.stateDataPath('skills.json'), 'utf8'));
          skills = Array.isArray(raw) ? raw : (raw.items ?? []);
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-routes/read-only:trends-skills'); }
        const cognition = readJsonl(deps.stateDataPath('cognition.jsonl'));
        const trends = deps.buildTrends({
          memory: memoryDays,
          lessonsAdded: lessons.map((l) => l.at),
          lessonsUsed: lessons.map((l) => l.usedAt),
          skillsUsed: skills.map((s) => s.lastUsedAt),
          cognitionAdded: cognition.map((c) => c.at),
        }, { days });
        sendJson({ ok: true, ...trends, sources: deps.TREND_SOURCES });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    },
  },
];
