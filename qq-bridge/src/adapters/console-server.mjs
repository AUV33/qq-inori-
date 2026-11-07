// console-server.mjs · HTTP 控制台（3100）的全部路由（从 app.mjs 的 main() 搬出，2026-10-28 M-1）
//
// 为什么单独成模块：
//   这是工程里最大的一块（170+ 路由；纯工具与部分只读路由已拆出），也是**唯一能改配置、改模式、重启进程**的
//   入口。它以前和 main() 的其他逻辑共享 300 多个闭包变量，改一个路由只能看控制台有没有报错。
//   搬出来之后，依赖面变成显式的 __deps（app.mjs 里用 getter/setter 提供活绑定），
//   模块自身只 import 显式的纯函数/策略模块，不持有跨请求状态。
//
// 关键设计：
//   · 所有自由变量都经 __deps 访问；可变的（currentMode / lastMode / slangEntries …）
//     在 app.mjs 里是 getter+setter，模块内赋值会写回真正的局部变量，不会产生"两份状态"。
//   · 这是**同步**函数：原实现返回 server 实例，包装层保持一致。
//   · 路由顺序就是匹配优先级，搬迁没有重排；新增路由请读现有风格。
import { CONSOLE_TOOL_FLAGS } from '../domain/shared/tool-flags.js';
// [HOST-ACTION-POLICY] shell 命令白名单 + 注入字符拦截（S1 安全收口）。
import { validateHostShell, getHostShellAllowlist } from '../domain/shared/host-action-policy.js';
import { catchStats } from '../domain/shared/best-effort.js';
import { checkSendRate, reserveSendTimes, rollbackSendTimes, normalizeSendMessages, validateMessageBounds } from '../domain/send/send-service.js';
import { createIntention, transitionIntention, activeIntentions, loadIntentions, saveIntentions } from '../domain/leaves/inori-intentions.js';
import { appendOutcome, createOutcome } from '../domain/leaves/inori-outcome.js';
import { createLanguageEpisode, appendLanguageEpisode, readLanguageEpisodes, findLanguageEpisodes, findLanguageEpisodesByContext, markLanguageEpisodeUsed, saveLanguageEpisodes, renderLanguageEpisodeBlock } from '../domain/leaves/inori-language-episodes.js';
import { collectOverview, renderOverviewText } from '../domain/leaves/inori-overview.js';
// [LEGISLATION] 宪章 §5.3/§5.7：承诺/拒绝/自我信任三本账（只有她能写）。
import { createLegislationStore, LegislationError } from '../domain/life/legislation.mjs';
// [SPLIT 阶段1] 鉴权与 HTTP 工具迁出（纯函数，无闭包状态）：
import { SECURITY_HEADERS, headersForHtml, createSendJson, readBody as readBodyImpl } from './console-http-utils.mjs';
import { createConsoleAuth } from './console-auth.mjs';

// [PROTO-SANITIZE] 展开外部请求体前递归剔除 __proto__/constructor/prototype，阻断原型污染。
// JSON.parse 不会触发原型 setter，但随后的 { ...body } 展开会；故在合并进配置对象前先清理。
function stripDangerousKeys(value) {
  if (Array.isArray(value)) return value.map(stripDangerousKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = stripDangerousKeys(v);
    }
    return out;
  }
  return value;
}

// [SPLIT 阶段2/3] 路由器 + 已迁出的路由组：
import { createConsoleRouter } from './console-router.mjs';
import { readOnlyRoutes } from './console-routes/read-only.mjs';
import { roleRoutes } from './console-routes/roles.mjs';
import { workRoutes } from './console-routes/works.mjs';
import { tokenRoutes } from './console-routes/tokens.mjs';
import { slangRoutes } from './console-routes/slang.mjs';
export function startConsoleServerCore(__deps) {

    const port = __deps.cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(__deps.cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : __deps.loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    // 三本 append-only 账：commitments / declined / self-trust（写在 data/state/mind/）。
    // 惰性创建：启动期不碰依赖、不建目录；测试不调这个端点就不需要 stateDataPath。
    let legislationStore = null;
    const getLegislationStore = () => {
      if (!legislationStore) legislationStore = createLegislationStore({ root: __deps.stateDataPath('mind'), now: Date.now });
      return legislationStore;
    };
    if (!tokenValid && configuredToken) __deps.log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) {
      const created = typeof __deps.wasConsoleTokenCreatedOnLoad === 'function' && __deps.wasConsoleTokenCreatedOnLoad();
      // [TOKEN-FINGERPRINT] 日志里不打令牌片段（哪怕是前 6 位）：只给 sha256 前 8 位，
      // 够区分"换了没换"，又不给爆破/撞库留任何材料。
      let fp = '?';
      try { fp = __deps.crypto.createHash('sha256').update(String(consoleToken)).digest('hex').slice(0, 8); } catch { fp = '?'; }
      __deps.log(`控制台未配置 consoleToken，${created ? '已生成并保存新令牌' : '继续使用已保存的令牌（未更换）'}：指纹 ${fp}（完整值保存在 state/console-token）`);
    }
    // [SPLIT 阶段1] 鉴权函数组已迁至 ./console-auth.mjs；解构接回同名局部变量，
    // 后续所有路由的调用点一字不改，依赖面显式化为 deps（行为零变化）。
    const auth = createConsoleAuth(__deps);
    const {
      tokenEq, agentTokenOk, isLiveAgentToken, isReadToken, selfStateTokenOk,
      callerKeyForToken, callerTokenIsOwner, ownerPrivateTokenOk,
    } = auth;
    const v2SessionAllowed = __deps.isSessionAllowedInCurrentMode;
    // [SPLIT 阶段3] method+pathname 路由表：已迁出的路由由此精确分发；
    // 未命中返回 null，下方 legacy ladder 继续处理（路由顺序/优先级不变）。
    const router = createConsoleRouter([readOnlyRoutes, roleRoutes, workRoutes, tokenRoutes, slangRoutes]);
    const server = __deps.http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      // [SPLIT 阶段1] SECURITY_HEADERS / createSendJson 已迁至 ./console-http-utils.mjs
      const sendJson = createSendJson(res);
      // [SPLIT 阶段1] readBody 实现已迁至 ./console-http-utils.mjs（1MB 上限 / 30s 超时 / JSON 对象校验不变）
      const readBody = () => readBodyImpl(req);
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return __deps.crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        if (req.method === 'GET' && url.pathname === '/') {
          const page = '<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>';
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...headersForHtml(page) });
          res.end(page);
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1（缺令牌时 x-agent-token 为空串），这里只要看到
      // 这个声明就要求令牌必须命中某个活跃会话，端点自己漏写校验也不会退回管理端。
      if (req.headers['x-agent-call'] !== undefined) {
        if (!isLiveAgentToken(req.headers['x-agent-token']) && !isReadToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '未授权：会话令牌已失效（会话可能刚被重置/轮换）。这一次不要重复调工具——下一次唤醒会自动带新令牌；急的话让主人发一句话触发唤醒。' }, 403);
          return;
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:266'); }
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (__deps.socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (__deps.cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && __deps.currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        // [SPLIT 阶段3] 先查路由表；命中交给独立模块，未命中 fallthrough 到 legacy ladder。
        // 分发点必须在鉴权/Host/CSRF/agent 全部关卡之后 —— 否则会绕过鉴权（安全回归高发点）。
        const dispatched = router.match(req.method, url.pathname);
        if (dispatched) {
          await dispatched({ req, res, url, sendJson, readBody, deps: __deps, auth });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          let page;
          try {
            page = __deps.fs.readFileSync(__deps.path.join(__deps.ROOT, 'public', 'console.html'), 'utf8');
          } catch {
            page = '控制台页面缺失：qq-bridge/public/console.html';
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headersForHtml(page) });
          res.end(page);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = __deps.readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: __deps.currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady: __deps.dshReady,
              socialV2Paused: __deps.socialV2.paused,
            });
            return;
          }
          // 名单文件存在时它就是权威（见 allowlist.allowed）：状态里必须显示真正生效的那份，
          // 否则控制台会显示「刚加的人不在名单」，与实际行为不一致。
          const wallEntries = (() => {
            try { return typeof __deps.readWallEntries === 'function' ? __deps.readWallEntries() : null; } catch { return null; }
          })();
          sendJson({
            mode: __deps.currentMode,
            closedAgentPreset: __deps.closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady: __deps.dshReady,
            ownerQQ: __deps.cfg.ownerQQ ?? null,
            allowGroups: wallEntries ? wallEntries.group.map(String) : (__deps.cfg.allow?.groups ?? []),
            allowPrivate: wallEntries ? wallEntries.private.map(String) : (__deps.cfg.allow?.private ?? []),
            socialV2Paused: __deps.socialV2.paused,
            onebot: typeof __deps.oneBotHealth === 'function' ? __deps.oneBotHealth() : null,
            activity: __deps.readActivityTail(100),
            // [CATCH] 空 catch 的计数出口：只在管理端可见，不进入 agent 状态。
            catchStats: catchStats()
          });
          return;
        }
        // [SPLIT 阶段2] GET /api/state/overview 已迁至 ./console-routes/read-only.mjs（由 router 分发）
        // [SPLIT 阶段2] GET /api/presets 已迁至 ./console-routes/read-only.mjs（由 router 分发）
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = __deps.normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${__deps.VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = __deps.readJsonSafe(__deps.path.join(__deps.STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          __deps.atomicWriteJson(__deps.path.join(__deps.STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          __deps.closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            __deps.unwrap(await __deps.api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            __deps.log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (__deps.currentMode === 'reserved' && requestedMode !== 'reserved') {
            __deps.cleanupSocialForModeChange();
            __deps.log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (__deps.currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            __deps.clearAllSocialV2Timers();
            __deps.drainAllPromptQueues('模式切换，已取消排队中的投递');
            __deps.log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          __deps.currentMode = requestedMode;
          __deps.lastMode = requestedMode;
          __deps.reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of __deps.socialV2.conversations.keys()) {
              __deps.setupSleepTimerV2(key);
              __deps.scheduleProactiveCheckV2(key);
            }
            __deps.log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          __deps.log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        // [SPLIT 第二批] 人格管理 / 角色切换 9 个路由已迁至 ./console-routes/roles.mjs（router 分发）

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = __deps.resolvePresetName(url.searchParams.get('preset'));
          try {
            const { prefix } = __deps.readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: __deps.presetPromptWarnings(prefix),
              status: __deps.presetStatus(preset),
              presets: Object.values(__deps.PRESET_NAMES).map((n) => __deps.presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: __deps.presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = __deps.resolvePresetName(body.preset);
          let nextText;
          try {
            const { text, prefix } = __deps.readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: __deps.presetPromptWarnings(prefix), synced: __deps.fs.existsSync(__deps.installedPresetYaml(preset)), requiresRestart: false, status: __deps.presetStatus(preset) });
              return;
            }
            nextText = __deps.renderPresetPromptYaml(text, body.content, preset === __deps.PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = __deps.presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = __deps.backupPresetFile(preset);
            __deps.atomicWriteText(__deps.presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = __deps.installedPresetYaml(preset);
            if (__deps.fs.existsSync(installed)) {
              __deps.fs.copyFileSync(__deps.presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && __deps.fs.existsSync(sourceBackup)) {
              try { __deps.fs.copyFileSync(sourceBackup, __deps.presetSourceYaml(preset)); } catch (rollbackError) {
                try { __deps.log(`控制台：${preset} 回滚失败（可能留下半截）: ${rollbackError?.message ?? rollbackError}`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:618'); }
              }
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          __deps.log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: __deps.fs.existsSync(__deps.installedPresetYaml(preset)),
            requiresRestart: true,
            status: __deps.presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          try {
            sendJson({ ok: true, backups: __deps.listPresetBackups(__deps.resolvePresetName(url.searchParams.get('preset'))) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = __deps.resolvePresetName(body.preset);
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = __deps.listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = __deps.path.join(__deps.PRESET_BACKUP_DIR, target);
            const restored = __deps.fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = __deps.extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = __deps.presetPromptBlockers(restoredPrefix, preset === __deps.PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            __deps.backupPresetFile(preset);
            __deps.atomicWriteText(__deps.presetSourceYaml(preset), restored);
            const installed = __deps.installedPresetYaml(preset);
            if (__deps.fs.existsSync(installed)) __deps.fs.copyFileSync(__deps.presetSourceYaml(preset), installed);
            __deps.log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const body = await readBody();
          const idx = __deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = { ...__deps.slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && __deps.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined) {
            if (![__deps.SLANG_STATUS.CANDIDATE, __deps.SLANG_STATUS.CONFIRMED, __deps.SLANG_STATUS.REJECTED].includes(body.status)) {
              sendJson({ ok: false, error: '无效状态' }, 400); return;
            }
            // 护栏：直接置「已确认」必须已填含义，否则会被注入 AI 上下文（与 confirm 入口一致）
            if (body.status === __deps.SLANG_STATUS.CONFIRMED && !String(entry.meaning ?? '').trim()) {
              sendJson({ ok: false, error: '请先填写含义再置为已确认，否则不会注入 AI 上下文' }, 400); return;
            }
            entry.status = body.status;
          }
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          __deps.slangEntries[idx] = entry;
          __deps.saveSlangStore();
          __deps.log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const body = await readBody();
          const idx = __deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = __deps.slangEntries[idx];
          // 终态护栏：已确认幂等返回；已拒绝不可再确认（与批量 confirm 的「只认候选」一致）
          if (entry.status === __deps.SLANG_STATUS.CONFIRMED) { sendJson({ ok: true, entry, skipped: true }); return; }
          if (entry.status === __deps.SLANG_STATUS.REJECTED) { sendJson({ ok: false, error: '已拒绝的黑话不可再确认' }, 400); return; }
          const draft = { ...entry };
          if (body.meaning !== undefined) draft.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) draft.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) draft.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) draft.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) draft.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!String(draft.meaning ?? '').trim()) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          draft.status = __deps.SLANG_STATUS.CONFIRMED;
          draft.updatedAt = new Date().toISOString();
          __deps.slangEntries[idx] = draft;
          __deps.saveSlangStore();
          __deps.log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry: draft });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = __deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = __deps.slangEntries[idx];
          if (entry.status === __deps.SLANG_STATUS.REJECTED) { sendJson({ ok: true, entry, skipped: true }); return; }
          const draft = { ...entry, status: __deps.SLANG_STATUS.REJECTED, updatedAt: new Date().toISOString() };
          __deps.slangEntries[idx] = draft;
          __deps.saveSlangStore();
          __deps.log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry: draft });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = __deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = __deps.slangEntries.splice(idx, 1);
          __deps.saveSlangStore();
          __deps.log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(__deps.state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(__deps.cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of __deps.pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          // [WALL-SYNC] 运行时以 allowlist.txt 为准（见 allowed()）；控制台必须显示生效值，
          // 否则在这里改「白名单」会静默无效（审计 2026-10-26 抓到的真实 bug）。
          const wall = __deps.readWallEntries();
          const effective = wall
            ? { private: wall.private, groups: wall.group }
            : (__deps.cfg.allow ?? { private: [], groups: [] });
          sendJson({ allow: effective, deny: __deps.cfg.deny ?? { private: [], groups: [] }, ownerQQ: __deps.cfg.ownerQQ ?? null, source: wall ? 'allowlist.txt' : 'config.json' });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = __deps.path.join(__deps.ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = __deps.readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = __deps.cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = __deps.normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          __deps.atomicWriteJson(configFile, file);
          __deps.cfg.allow = { private: allow.private, groups: allow.groups };
          __deps.cfg.deny = { private: deny.private, groups: deny.groups };
          __deps.cfg.ownerQQ = ownerQQ;
          // [WALL-SYNC] 墙文件存在时，控制台的增删同步写进 allowlist.txt（行级编辑，保留注释）。
          // 这是运行时真正生效的名单；不同步的话控制台就是在改一份没人读的配置。
          try {
            if (__deps.readWallEntries()) {
              __deps.writeWallEntries({ private: allow.private, groups: allow.groups });
              __deps.log(`控制台：白名单已同步到 allowlist.txt（私聊 ${allow.private.length}，群 ${allow.groups.length}）`);
            }
          } catch (error) {
            __deps.log(`控制台：白名单写墙失败（config 已更新）: ${error?.message ?? error}`);
          }
          __deps.reconcileSessionPolicies();
          __deps.log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(__deps.cfg.dsh?.provider || 'deepseek-official');
          const model = String(__deps.cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = __deps.REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!__deps.modelCatalogInFlight) {
              __deps.modelCatalogInFlight = __deps.withTimeout(__deps.fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { __deps.modelCatalogInFlight = null; });
            }
            const catalog = __deps.unwrap(await __deps.modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => __deps.REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!__deps.modelCatalogErrorLogged.has(reason)) {
              __deps.modelCatalogErrorLogged.add(reason);
              __deps.log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(__deps.cfg.dsh?.reasoningEffort || __deps.REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: __deps.REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = __deps.normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = __deps.path.join(__deps.ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = __deps.readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          __deps.atomicWriteJson(configFile, file);
          __deps.cfg.dsh = { ...(__deps.cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          __deps.modelSelectionEpoch += 1;
          __deps.log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: __deps.cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: __deps.stateDirHardened,
              path: __deps.STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? __deps.manualDirCommand(__deps.STATE_DIR)
                : `chmod 700 "${__deps.STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            __deps.stateDirHardened = null;
            __deps.hardenStateDirAcl();
            sendJson({ ok: __deps.stateDirHardened === true, hardened: __deps.stateDirHardened, path: __deps.STATE_DIR });
            return;
          }
          const configFile = __deps.path.join(__deps.ROOT, 'config.json');
          const file = __deps.readConfigObject(configFile);
          // [PROTO-SANITIZE] 展开请求体前剔除危险键。
          const next = { ...(file.security ?? {}), ...stripDangerousKeys(body) };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          __deps.atomicWriteJson(configFile, file);
          __deps.cfg.security = { ...(__deps.cfg.security ?? {}), ...next };
          __deps.log(`控制台：安全拦截通知已更新（interceptNotify=${__deps.cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: __deps.cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = __deps.crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = __deps.path.join(__deps.ROOT, 'config.json');
          const file = __deps.readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          __deps.atomicWriteJson(configFile, file);
          __deps.cfg.consoleToken = generated ? '' : newToken;
          __deps.atomicWriteText(__deps.path.join(__deps.STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          __deps.log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (__deps.SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!__deps.allowed(kind, id, __deps.cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!__deps.modeAllowed(`${kind}:${id}`, kind, id, __deps.cfg, __deps.currentMode)) { sendJson({ ok: false, error: `当前模式（${__deps.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = __deps.escapeCqText(__deps.redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await __deps.bot.sendPrivateMessage(id, __deps.text(safeMessage))
              : await __deps.bot.sendGroupMessage(id, __deps.text(safeMessage));
            __deps.log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            __deps.enterActive(key);
            __deps.log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            __deps.leaveActive(key);
            __deps.log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of __deps.social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...__deps.social.states.keys(), ...__deps.social.recentMessages.keys()]);
          for (const k of keys) {
            const st = __deps.social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: __deps.cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = __deps.path.join(__deps.ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = __deps.readConfigObject(configFile);
          // [PROTO-SANITIZE] 展开请求体前剔除危险键。
          const merged = { ...(file.social ?? {}), ...stripDangerousKeys(body) };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          __deps.atomicWriteJson(configFile, file);
          __deps.cfg.social = { ...__deps.cfg.social, ...merged };
          __deps.log('控制台：社交配置已更新');
          sendJson({ ok: true, config: __deps.cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await __deps.flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 记忆库有序整理：POST /api/console/memory/organize {apply?} ──────────
        if (req.method === 'POST' && url.pathname === '/api/console/memory/organize') {
          const body = await readBody();
          try {
            const r = __deps.organizeMemoryFiles({ apply: body?.apply === true });
            sendJson({ ok: true, ...r });
          } catch (error) { sendJson({ ok: false, error: String(error?.message ?? error) }, 500); }
          return;
        }
        // ── 手动给表情打标（运维/验证用）：POST /api/console/stickers/caption {limit?, force?} ──
        if (req.method === 'POST' && url.pathname === '/api/console/stickers/caption') {
          const body = await readBody();
          try {
            const r = await __deps.captionStickerLibrary({ limit: Number(body?.limit) || 2, force: body?.force === true });
            sendJson(r);
          } catch (error) { sendJson({ ok: false, error: String(error?.message ?? error) }, 500); }
          return;
        }
        // ── 手动让她现在写日记（运维/验证用）：POST /api/console/diary {day?} ──
        if (req.method === 'POST' && url.pathname === '/api/console/diary') {
          const body = await readBody();
          const day = String(body?.day ?? '').trim() || new Date().toLocaleDateString('sv-SE');
          try {
            await __deps.startDiarySession(day === new Date().toLocaleDateString('sv-SE') ? undefined : day, { force: body?.force === true });
            sendJson({ ok: true, day, attempts: __deps.diaryAttempts(day), written: __deps.todayDiaryWritten(day) });
          } catch (error) { sendJson({ ok: false, error: String(error?.message ?? error) }, 500); }
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${__deps.currentMode}）允许范围内` }, 403);
            return;
          }
          if (!__deps.state.sessions[key] && !__deps.allowed(kind, id, __deps.cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!__deps.dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = __deps.currentMode === 'reserved2';
          const roleState = __deps.readRoleState();
          // [ROLE-PUSH] 整卡推送：按当前模式选卡（v2 选集给二代、v1 选集给一代），
          // 不再只给名字让她自己拉——角色卡改完（mtime 热注入）下一次提醒就能看见。
          const roleFull = __deps.roleHintForMode(isV2 ? 'v2' : 'v1');
          const roleLine = roleFull
            ? `【当前角色】${roleState.role}\n${roleFull}\n\n`
            : (roleState.role ? `【当前角色】${roleState.role}\n\n` : '');
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = __deps.getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          // [SESSION-KEY] 必须告诉她是哪个会话：QQ 工具需要 key+token 配对，
          // 只给 token 她会瞎猜 key（实测猜过 private:123456789 和她自己的号）。
          const sessionLine = `【当前会话】${key}（调用任何 QQ 工具时，key 参数填这个值）\n\n`;
          const promptText = `${roleLine}${sessionLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message（引用传 replyToMessageId））。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await __deps.ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = __deps.social.silentTurns.get(sessionId) ?? [];
            __deps.social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = __deps.social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) __deps.social.silentTurns.set(sessionId, next);
              else __deps.social.silentTurns.delete(sessionId);
            };
            const result = await __deps.deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              __deps.log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              __deps.appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── [HANDOFF] 任务分派：她把长任务交出去，桥接在独立会话执行 ──────────
        // 目的：她的主会话保持能聊天；过教程/查资料这类要几分钟的活交给独立会话，
        // 做完由任务会话自己调用 qq_send_message 回报到 reportTo。
        if (req.method === 'POST' && url.pathname === '/api/console/handoff-task') {
          const body = await readBody();
          // [HANDOFF-IDENTITY] 信任判断必须来自调用方令牌，不能来自 body：
          // 旧逻辑用 reportTo === ownerKey 决定 admin preset，等于让请求体自选权限。
          const callerToken = String(req.headers['x-agent-token'] ?? '');
          const callerKey = callerKeyForToken(callerToken);
          const ownerRequested = callerTokenIsOwner(callerToken);
          const task = String(body.task ?? '').trim();
          const reportTo = String(body.reportTo ?? '').trim();
          const acceptance = String(body.acceptance ?? '').trim();
          const fingerprint = String(body.fingerprint ?? '').trim();
          const intentionId = String(body.intentionId ?? '').trim();
          if (!task) { sendJson({ ok: false, error: 'task 不能为空' }, 400); return; }
          if (!/^(group|private):\d+$/.test(reportTo)) {
            sendJson({ ok: false, error: 'reportTo 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          // [HANDOFF-SCOPE] 非主人调用方只能把任务回报到自己的会话：允许跨会话报给
          // owner 会让任务会话拿到 owner 的【会话令牌】+ admin preset，等于绕过群边界。
          if (!callerKey) {
            sendJson({ ok: false, error: '派活必须带有效会话令牌（控制台管理端请用主人私聊发起）' }, 403);
            return;
          }
          if (!ownerRequested && reportTo !== callerKey) {
            sendJson({ ok: false, error: `任务只能回报到当前会话（${callerKey}）；跨会话派活需要主人私聊发起` }, 403);
            return;
          }
          if (!__deps.dshReady) { sendJson({ ok: false, error: 'DSH 当前不可用' }, 503); return; }
          try {
            await __deps.migrateTaskPoolOnce();
            // [TASK-RESUME] 同一件事之前没做成：先接上旧任务，不新建、不从零重开。
            try {
              const fp = fingerprint || task.replace(/\s+/g, ' ').slice(0, 120);
              const old = __deps.findResumableTask?.(fp);
              if (old && old.id) {
                __deps.resumeTask(old.id);
                await __deps.drainTaskPool();
                sendJson({ ok: true, resumed: true, taskId: old.id, reportTo });
                return;
              }
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1392'); }
            // [TASK-POOL] 有槽位 → 立即开新会话并行跑；池满 → 台账排队（FIFO，收尾自动 drain）
            const cap = __deps.poolCap(__deps.cfgRef ?? {});
            const hasSlot = __deps.canDispatch(__deps.taskPoolRunning.length, __deps.cfgRef ?? {});
            if (!hasSlot && __deps.queuedCount() >= __deps.queueMax(__deps.cfgRef ?? {})) {
              sendJson({ ok: false, error: `任务队列已满（在跑 ${__deps.taskPoolRunning.length}，排队 ${__deps.queuedCount()}），先等几件收尾` }, 429);
              return;
            }
            __deps.recentTaskReportAt.set(reportTo, Date.now());
            // [TASK-NOTICE] 派了活要跟他说一声：登记 + 安排一次唤醒（她自己说；忙就等她这一轮收尾后递）
            try {
              const stH = __deps.getSocialV2State(reportTo);
              stH.lastHandoff = { task: String(task).slice(0, 120), at: Date.now() };
              __deps.saveSocialV2State();
              __deps.scheduleWakeV2(reportTo, 'taskHandoff');
              __deps.log(`[task-pool] 派活告知已安排 ${reportTo}（${String(task).slice(0, 30)}）`);
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1408'); }
            try { __deps.lifeNote({ type: 'activity' }); __deps.markInterest(__deps.lifeState); __deps.saveLifeFile(__deps.lifeState); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1409'); } // [LIFE] 她派了活 = 有活动 + 无聊度归零锚点
            if (hasSlot) {
              const sessionId = await __deps.createTaskSession(reportTo, ownerRequested);
              const row = __deps.appendTask({ task, reportTo, sessionId, status: 'running', ownerRequested, acceptance, fingerprint, intentionId });
              __deps.taskPoolRunning.push({ taskId: row.id, sessionId, dispatchAt: Date.now(), taskShort: String(task).slice(0, 40), reportTo, acceptance });
              __deps.poolSave();
              try {
                const taskWithAcceptance = acceptance ? `${task}\n\n【验收】${acceptance}\n做完必须给证据。` : task;
                await __deps.deliverTaskPrompt(sessionId, taskWithAcceptance, reportTo, ownerRequested);
                __deps.log(`[handoff] 任务已交给新会话 ${sessionId.slice(0, 8)}（回报到 ${reportTo}，${[...task].length} 字，池 ${__deps.taskPoolRunning.length}/${cap}）`);
                sendJson({ ok: true, sessionId, reportTo, taskId: row.id });
              } catch (error) {
                {
                  const arr = __deps.taskPoolRunning;
                  arr.splice(0, arr.length, ...arr.filter((x) => x.sessionId !== sessionId));
                }
                __deps.poolSave();
                __deps.retaskToQueued(row.id);
                try { await __deps.api.stopSessionWork(sessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1427'); }
                try { await __deps.api.callUnary('workspace/archiveSession', { sessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1428'); }
                sendJson({ ok: false, error: `投递失败（已退回排队）：${String(error?.message ?? error).slice(0, 160)}` }, 500);
              }
            } else {
              const row = __deps.appendTask({ task, reportTo, sessionId: '', status: 'queued', ownerRequested, acceptance, fingerprint, intentionId });
              __deps.log(`[handoff] 池满，任务进队列（排队 ${__deps.queuedCount()}，在跑 ${__deps.taskPoolRunning.length}/${cap}）`);
              sendJson({ ok: true, queued: true, position: __deps.queuedCount(), reportTo, taskId: row.id });
            }
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        // [TASK-POOL] 任务看板：控制台看池/队列（最近结果在台账）
        if (req.method === 'GET' && url.pathname === '/api/console/handoff-task') {
          try {
            await __deps.migrateTaskPoolOnce();
            sendJson({ ok: true, ...__deps.taskBoardSnapshot() });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        // ── [WALL-TOOL] 工具边界申请：她 tool_boundary(propose grant) 写进来的待决项，
        //    owner 在这里一句话批准/撤销。guard 热读白名单 → 批准后立即生效（MCP 前缀类）；
        //    本地工具进 schema 还需重启 DSH。
        const TOOL_WHITELIST_F = __deps.path.join(__deps.STATE_DIR, 'tool-whitelist.json');
        const TOOL_PROPOSALS_F = __deps.path.join(__deps.STATE_DIR, 'tool-proposals.jsonl');
        const TOOL_LOG_F = __deps.path.join(__deps.STATE_DIR, 'tool-log.jsonl');
        const LOCAL_TOOL_NAMES = new Set(['pwsh','bash','read','read_image','write','edit','str_replace_editor','glob','grep','load_workspace_dependencies','subagent','subagent_fork','list_subagent_models','send_message','interrupt_agent','list_agents','workflow','ralph']);
        const readToolWhitelist = () => {
          try {
            let t = __deps.fs.readFileSync(TOOL_WHITELIST_F, 'utf8');
            if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
            const raw = JSON.parse(t);
            return {
              extraExact: Array.isArray(raw.extraExact) ? raw.extraExact : [],
              extraPrefixes: Array.isArray(raw.extraPrefixes) ? raw.extraPrefixes : [],
              denied: Array.isArray(raw.denied) ? raw.denied : [],
            };
          } catch { return { extraExact: [], extraPrefixes: [], denied: [] }; }
        };
        if (req.method === 'GET' && url.pathname === '/api/console/her-workspaces') {
          try {
            const wsFile = __deps.path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'storages', 'workspace.json');
            const raw = JSON.parse(__deps.fs.readFileSync(wsFile, 'utf8'));
            const rows = Object.entries(raw?.tables?.workspaces ?? {}).map(([id, v]) => ({
              id, title: v?.title ?? '', path: v?.path ?? '', sessions: Array.isArray(v?.sessionIds) ? v.sessionIds.length : 0,
            }));
            sendJson({ ok: true, herDir: __deps.HER_WORKSPACE_DIR, workspaces: rows });
          } catch (error) { sendJson({ ok: false, error: String(error?.message ?? error) }, 500); }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/prune-her-workspaces') {
          const removed = [];
          try {
            const wsFile = __deps.path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'storages', 'workspace.json');
            const raw = JSON.parse(__deps.fs.readFileSync(wsFile, 'utf8'));
            const keepPath = __deps.path.resolve(__deps.HER_WORKSPACE_DIR);
            const legacy = (p) => {
              const rp = __deps.path.resolve(String(p || ''));
              if (rp === keepPath) return false;
              return /[\\/]workspaces[\\/](isolated-|_probe-|group-|private-)|[\\/]state[\\/]slang-agent$/.test(rp);
            };
            for (const [id, v] of Object.entries(raw?.tables?.workspaces ?? {})) {
              if (!v || !legacy(v.path)) continue;
              try {
                await __deps.api.workspace.delete({ workspaceId: id });
                removed.push({ id, title: v.title, path: v.path });
              } catch (error) { __deps.log(`[her-workspace] 删除旧工作区失败 ${id}: ${error?.message ?? error}`); }
            }
            __deps.log(`[her-workspace] 已清理旧工作区 ${removed.length} 个`);
            sendJson({ ok: true, removed });
          } catch (error) { sendJson({ ok: false, error: String(error?.message ?? error), removed }, 500); }
          return;
        }
        // [SPLIT 阶段2] GET /api/console/metrics 已迁至 ./console-routes/read-only.mjs（由 router 分发）
        // [SPLIT 阶段2] GET /api/console/quality-trends 已迁至 ./console-routes/read-only.mjs（由 router 分发）
        if (req.method === 'GET' && url.pathname === '/api/console/tool-proposals') {
          let pending = [];
          try {
            const lines = __deps.fs.readFileSync(TOOL_PROPOSALS_F, 'utf8').split(/\r?\n/).filter(Boolean);
            pending = lines.slice(-30).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1568'); }
          sendJson({ ok: true, pending, whitelist: readToolWhitelist() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/approve-tool') {
          const body = await readBody();
          const tool = String(body.tool ?? '').trim();
          if (!/^[A-Za-z0-9_]+$/.test(tool) && !/^mcp__[\w-]+__[\w-]+$/.test(tool) && !/^mcp__[\w-]+$/.test(tool)) {
            sendJson({ ok: false, error: 'tool 没写清（例如 subagent、mcp__phone__phone_tap）' }, 400);
            return;
          }
          // 锁内 读-改-写：白名单被桥接与 DSH 侧 MCP 进程交叉 RMW，整段进同一把锁（<file>.lock 协议）
          const lock = __deps.withFileLock(TOOL_WHITELIST_F, () => {
            const wl = readToolWhitelist();
            const isPrefixLocal = tool.endsWith('__');
            const list = isPrefixLocal ? wl.extraPrefixes : wl.extraExact;
            if (!list.includes(tool)) list.push(tool);
            if (wl.denied.includes(tool)) wl.denied = wl.denied.filter((x) => x !== tool); // 批准覆盖自拒
            __deps.writeJsonDocument(TOOL_WHITELIST_F, wl, { source: 'bridge/console-approve' });
            return { ok: true, isPrefix: isPrefixLocal };
          }, { source: 'bridge/console-approve' });
          if (!lock.ok) {
            sendJson({ ok: false, error: `白名单写入失败：${lock.error}` }, 500);
            return;
          }
          {
            __deps.fs.mkdirSync(__deps.STATE_DIR, { recursive: true });
            try { __deps.fs.appendFileSync(TOOL_LOG_F, JSON.stringify({ ts: new Date().toISOString(), action: 'approved', tool, by: 'owner-console' }) + '\n', 'utf8'); } catch (error) { __deps.log(`[wall-tool] 批准日志写失败（批准仍生效）: ${error?.message ?? error}`); }
            try { __deps.fs.appendFileSync(TOOL_PROPOSALS_F, JSON.stringify({ ts: new Date().toISOString(), tool, mode: 'grant', status: 'approved', by: 'owner-console' }) + '\n', 'utf8'); } catch (error) { __deps.log(`[wall-tool] 申请台账写失败（批准仍生效）: ${error?.message ?? error}`); }
          }
          const localNote = LOCAL_TOOL_NAMES.has(tool)
            ? '这是本地工具：guard 放行已生效，但要进入她的工具表还需重启一次 DSH（preset/MCP 只在 DSH 启动时加载）。'
            : (tool.endsWith('__') ? 'MCP 前缀放行：立即生效（她的 guard 热读白名单）。' : '放行已写入白名单，立即生效。');
          __deps.log(`[wall-tool] owner 批准工具边界：${tool}`);
          sendJson({ ok: true, tool, note: localNote });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/revoke-tool') {
          const body = await readBody();
          const tool = String(body.tool ?? '').trim();
          const revoke = __deps.withFileLock(TOOL_WHITELIST_F, () => {
            const wl = readToolWhitelist();
            let changed = 0;
            for (const key of ['extraExact', 'extraPrefixes', 'denied']) {
              const before = wl[key].length;
              wl[key] = wl[key].filter((x) => x !== tool);
              changed += before - wl[key].length;
            }
            if (changed > 0) __deps.writeJsonDocument(TOOL_WHITELIST_F, wl, { source: 'bridge/console-revoke' });
            return { ok: true, changed };
          }, { source: 'bridge/console-revoke' });
          if (!revoke.ok) { sendJson({ ok: false, error: `白名单写入失败：${revoke.error}` }, 500); return; }
          if (revoke.changed === 0) { sendJson({ ok: false, error: `${tool} 不在白名单/停用列表里` }, 404); return; }
          try { __deps.fs.appendFileSync(TOOL_LOG_F, JSON.stringify({ ts: new Date().toISOString(), action: 'revoked', tool, by: 'owner-console' }) + '\n', 'utf8'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1621'); }
          __deps.log(`[wall-tool] owner 撤销工具边界：${tool}`);
          sendJson({ ok: true, tool, removed: revoke.changed });
          return;
        }
        // ── [VISION] 看图：走 DSH 的模型线路（和大脑同一套模型，不直连 DeepSeek）──
        // 手机视觉工具（phone_look）优先调这里；DSH 换模型，看图也跟着换。
        if (req.method === 'POST' && url.pathname === '/api/console/vision') {
          const body = await readBody();
          const rawList = Array.isArray(body.images) ? body.images : [body.data ?? body.image];
          const images = rawList.map((x) => String(x ?? '').replace(/^data:[^,]+,/, '')).filter(Boolean);
          const mimeType = String(body.mimeType ?? 'image/png');
          const question = String(body.question ?? '').trim() || '描述这张手机截图：现在是什么界面？上面有哪些文字？';
          if (!images.length) { sendJson({ ok: false, error: 'images/data 不能为空' }, 400); return; }
          if (!__deps.dshReady) { sendJson({ ok: false, error: 'DSH 当前不可用' }, 503); return; }
          const t0 = Date.now();
          try {
            const text = await __deps.vision.ask(images, question, { mimeType, timeoutMs: 90000 });
            __deps.log(`[vision] ${images.length} 帧 → ${String(text).length} 字（${Date.now() - t0}ms，走 DSH 模型）`);
            sendJson({ ok: true, text, ms: Date.now() - t0, frames: images.length });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: __deps.cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          // [PROTO-SANITIZE] 入口即净化请求体，覆盖后续的嵌套合并（body.tools/wake/...）。
          const body = stripDangerousKeys(await readBody());
          const configFile = __deps.path.join(__deps.ROOT, 'config.json');
          const file = __deps.readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((__deps.cfg.socialV2 && typeof __deps.cfg.socialV2 === 'object') ? __deps.cfg.socialV2 : {});
          // [PROTO-SANITIZE] 展开请求体前剔除危险键。
          const merged = { ...current, ...stripDangerousKeys(body) };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = CONSOLE_TOOL_FLAGS;
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          __deps.atomicWriteJson(configFile, file);
          __deps.cfg.socialV2 = { ...(__deps.cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) __deps.refreshAllDefaultWakeConfigsV2();
          __deps.log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: __deps.cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: __deps.socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          __deps.socialV2.paused = paused;
          if (paused) {
            __deps.clearAllSocialV2Timers();
            __deps.log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            __deps.log('控制台：二代 AI 已恢复');
            for (const key of __deps.socialV2.conversations.keys()) {
            __deps.setupSleepTimerV2(key);
            __deps.scheduleProactiveCheckV2(key);
          }
          }
          __deps.saveSocialV2State();
          sendJson({ ok: true, paused: __deps.socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          __deps.sessionEpoch++;
          __deps.sessionPromises.clear();
          __deps.clearAllSocialV2Timers();
          __deps.drainAllPromptQueues('二代状态已重置');
          for (const key of [...__deps.socialV2.conversations.keys()]) {
            const sid = __deps.state.sessions[key];
            if (sid) {
              delete __deps.state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              __deps.stopRetiredSessionWork(sid, key);
              __deps.sessionModels.delete(sid);
              __deps.modelAppliedSessions.delete(sid);
              __deps.reverse.delete(sid);
              __deps.collectors.delete(sid);
              __deps.v2TurnStartAt.delete(sid);
              __deps.toolCallNames.delete(sid);
              __deps.pendingSendToolCalls.delete(sid);
              __deps.sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              __deps.api.events.forget?.(sid);
            }
            delete __deps.state.sessionPolicies[key];
            __deps.forgetAgentToken(key);
            __deps.socialV2.conversations.delete(key);
            __deps.seenForwardIds.delete(key);
          }
          __deps.saveState();
          __deps.pendingWakeKeys.clear();
          __deps.clearAllPendingWakeLeases();
          __deps.wakeConfigUpdatedKeys.clear();
          __deps.markReadCalledKeys.clear();
          __deps.wakeConfigMissCount.clear();
          __deps.socialV2.paused = false;
          try { __deps.atomicWriteJson(__deps.SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { __deps.log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          __deps.log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: __deps.computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (__deps.cfg.socialV2?.sticker?.enabled !== false) {
            try { await __deps.syncStickerLibrary(false); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:1908'); }
          }
          const roleState = __deps.readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendTo: 'qq_send_to',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            memoryList: 'qq_memory_list（你的记忆清单：带编号，可整理）',
            memoryEdit: 'qq_memory_edit（记忆整理：合并/改写/放下自己的记忆）',
            selfEdit: 'self_edit（改你自己：角色卡/自述，留备份可回滚）',
            lessonVote: 'lesson_vote（你的经验清单与投票）',
            works: 'work_list / work_start / work_peek / work_note / work_update',
            person: 'qq_person',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            slangJudge: 'qq_slang_judge',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices',
            curiosity: 'qq_curiosity',
            dayPlan: 'qq_day_plan',
            workshop: 'qq_workshop',
            // [IMAGEGEN] 画画＝本地生图（默认开；关掉后 MCP 注册期就看不见）
            image: 'qq_image（本地生图模型出图；英文标签，按需拉起，第一张要等）',
            groupAdmin: 'qq_group_ban / qq_group_kick / qq_group_card / qq_recall',
            wish: 'qq_wish',
            selfWake: 'qq_self_wake',
            ownLifeRhythm: 'qq_set_own_life_rhythm',
            quant: 'qq_quant_status / qq_quant_quote / qq_quant_klines / qq_quant_backtest / qq_quant_buy / qq_quant_sell / qq_quant_journal / qq_quant_note（模拟盘，不碰真钱）',
            // [TOOL-SURFACE] 整合：把工具面里此前 qq_get_prompt 看不见的（81 个）分组列出来，
            // 否则她提示词里只有一半工具名，明明挂着却"不知道有"。
            qqStatus: 'qq_status',
            memorySearch: 'qq_memory_search',
            phone: 'phone_look / phone_screenshot / phone_dump / phone_tap / phone_tap_text / phone_key / phone_swipe / phone_text / phone_batch / phone_open_app / phone_info / phone_status / phone_connect / phone_pair / phone_devices / phone_macro / phone_record_screen',
            phoneVision: 'phone_ocr / phone_find_template / phone_tap_template / phone_template_save / phone_templates',
            web: 'web_search / web_fetch',
            browse: 'browse_posts / feed_posts',
            video: 'video_feed / video_watch / watch_video / video_frames',
            diary: 'diary_days / diary_recent / diary_write / diary_export',
            qzone: 'qzone_feeds / qzone_post / qzone_comment / qzone_like / qzone_my_posts / qzone_user_posts / qzone_recent_like / qzone_images / qzone_pic_save / qzone_delete / qzone_set_right / qzone_unlike',
            learn: 'memory_save / memory_recall / memory_stats / memory_edit / memory_list / lesson_write / lesson_list / lesson_drop / skill_find / skill_record / skill_save / skill_verify / goal_list / goal_add / goal_progress / goal_done / learning_item / practice_start / practice_note / practice_result / skill_draft / trace_log',
            hostOps: 'handoff_task / adjust_wall / gate_tune / tool_boundary / snowluma_status',
            music: 'music_lyrics / ncm_now / ncm_play / ncm_control / ncm_search / ncm_comments / ncm_inbox / ncm_msg_users / ncm_room / ncm_room_control / ncm_room_say',
            system: 'ask_user_question / todo_write / working_directory / read_mcp_resource / list_mcp_resources / list_mcp_resource_templates'
          };
          const tools = __deps.cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !__deps.stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: __deps.currentMode === 'reserved2' ? __deps.currentRoleHintV2() : __deps.currentRoleHint() },
            recommended: __deps.cfg.socialV2?.provideRecommendations === false ? null : {
              wake: __deps.cfg.socialV2?.wake ?? {},
              send: __deps.cfg.socialV2?.send ?? {},
              wait: __deps.cfg.socialV2?.wait ?? {},
              proactive: __deps.cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: __deps.replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: __deps.computeWakeSafetyV2(st.wakeConfig),
            memory: __deps.formatMemoryV2(st),
            participation: __deps.formatParticipationV2(st),
            slang: {
              enabled: __deps.cfg.slang?.enabled !== false,
              entries: __deps.confirmedSlangListV2(),
              block: __deps.buildSlangContext(__deps.slangEntries, __deps.cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: __deps.cfg.socialV2?.sticker?.enabled !== false,
              total: __deps.stickerEntries.length,
              context: __deps.cfg.socialV2?.sticker?.includeInPrompt !== false ? __deps.buildStickerContext(__deps.stickerEntries, __deps.cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: __deps.cfg.socialV2?.sticker?.includeInPrompt !== false ? __deps.buildStickerStrategyHint() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: __deps.cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: __deps.voiceLibrary().length,
              names: __deps.voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: __deps.voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return;
        }
        // [GROUP-WINDOW] 只读群窗预览（控制台/验证用）：给她自己的时间里那份群窗。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/read-window') {
          sendJson({ ok: true, text: __deps.groupReadWindowText() });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !__deps.readTokenOkMain(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = __deps.getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const fullToken = req.headers['x-agent-token'] && agentTokenOk(key, req.headers['x-agent-token']);
          const readThroughSeq = fullToken ? __deps.noteModelMessagesV2(st, messages) : __deps.readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !__deps.readTokenOkMain(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? __deps.noteModelMessagesV2(st, messages) : __deps.readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          const throughSeq = __deps.requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // [WRAP-UP-IS-JUDGEMENT] 收尾不看安静时长，只看「最新消息看过没有」：
          // 还有没看过的就拦一下，让她先看完再自己判断；看完了想收就收。
          // 只约束她自己的工具调用：控制台（主人）手动收尾不受这条规则限制。
          if (req.headers['x-agent-token'] && __deps.isSleepingConfigV2(st.wakeConfig) && __deps.preSleepWaitBlockedV2(st)) {
            const unseen = __deps.unseenCountV2(st);
            sendJson({
              ok: false,
              preSleepBlocked: true,
              hint: `还有 ${unseen} 条消息你没看过：先看完（qq_get_unread_messages(afterSeq=readThroughSeq) 或 qq_wait_for_messages(purpose=messages) 一次），再自己判断要不要收尾。话题跟你没关系、你也插不上话，就直接收——不用等安静，也不用等谁说完。`,
              unseenCount: unseen
            }, 200);
            return;
          }
          const markedCount = __deps.acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          __deps.ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          __deps.markReadCalledKeys.add(key);
          __deps.saveSocialV2State();
          __deps.log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: __deps.readThroughSeqV2(st), wakeGuaranteed: __deps.computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: __deps.computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          const throughSeq = __deps.requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && __deps.v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(__deps.cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(__deps.cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(__deps.cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(__deps.cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(__deps.cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(__deps.cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = __deps.normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // [WRAP-UP-IS-JUDGEMENT] 收尾不看安静时长，只看「最新消息看过没有」：
          // 还有没看过的就拦一下，让她先看完再自己判断；看完了想收就收。
          // 只约束她自己的工具调用：控制台（主人）手动收尾不受这条规则限制。
          if (req.headers['x-agent-token'] && __deps.isSleepingConfigV2(next) && __deps.preSleepWaitBlockedV2(st)) {
            const unseen = __deps.unseenCountV2(st);
            sendJson({
              ok: false,
              preSleepBlocked: true,
              hint: `还有 ${unseen} 条消息你没看过：先看完（qq_get_unread_messages(afterSeq=readThroughSeq) 或 qq_wait_for_messages(purpose=messages) 一次），再自己判断要不要收尾。话题跟你没关系、你也插不上话，就直接 set_wake_config——不用等安静。`,
              unseenCount: unseen
            }, 200);
            return;
          }
          const markedCount = acknowledgeOnClose ? __deps.acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          __deps.logAction({
            t: 'wake_config',
            key,
            by: req.headers['x-agent-token'] ? 'her' : 'console',
            mode: next.mode,
            infinite: next.infinite,
            sleepSec: next.sleepUntil ? Math.round((Date.parse(next.sleepUntil) - Date.now()) / 1000) : null,
            trig: {
              at: next.triggers.atMention === true,
              name: next.triggers.nameMention === true,
              q: next.triggers.question === true,
              any: next.triggers.anyMessage === true,
              poke: next.triggers.poke === true,
              kw: (next.triggers.keywords || []).length,
              prob: next.triggers.probability,
            },
          }); // [ACTION-LOG] 她亲手选择"怎么醒来"——自由意志的直接读数（纯观察）
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮收尾前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          __deps.saveSocialV2State();
          __deps.wakeConfigUpdatedKeys.add(key);
          __deps.wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          __deps.cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          __deps.setupSleepTimerV2(key);
          __deps.log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: __deps.readThroughSeqV2(st), wakeConfig: next, wakeSafety: __deps.computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of __deps.socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (__deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = __deps.getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          __deps.saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void __deps.sendWakePromptV2(key, reason).catch((error) => __deps.log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          __deps.log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        // [SCENE-SEND] 中控台跨场景发话：只允许「主人私聊」会话调用，防群友遥控她给别处发消息。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/scene-send') {
          const body = await readBody();
          const fromToken = String(req.headers['x-agent-token'] ?? '');
          const fromKey = __deps.keyForAgentToken(fromToken);
          const ownerKey = `private:${String(__deps.cfgRef?.ownerQQ ?? '')}`;
          if (!fromKey) { sendJson({ ok: false, error: '未授权的会话令牌' }, 403); return; }
          if (fromKey !== ownerKey) {
            __deps.log(`[scene-send] 拒绝：${fromKey} 不是主人私聊（跨场景发话只给主人会话开）`);
            sendJson({ ok: false, error: '跨场景发话只允许在主人私聊会话里用；群里/别人私聊不能用（防止被遥控）' }, 403);
            return;
          }
          const toKey = String(body.key ?? body.toKey ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!/^(group|private):\d+$/.test(toKey)) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          if (text.length > 400) { sendJson({ ok: false, error: '单条不超过 400 字（跨场景发话别刷屏）' }, 400); return; }
          if (toKey === fromKey) { sendJson({ ok: false, error: '这就是当前会话：直接用本会话的发送工具回即可' }, 400); return; }
          if (!__deps.modeAllowed(toKey, toKey.split(':')[0], Number(toKey.split(':')[1]), __deps.cfgRef, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (toKey.startsWith('group:')) {
            const until = await __deps.groupMutedUntil(toKey.split(':')[1]);
            if (until > Date.now()) { sendJson({ ok: false, error: '那个群正在禁言，发不出去' }, 409); return; }
          }
          try {
            await __deps.auditAndSend(toKey, text);
            __deps.log(`[scene-send] 主人私聊 → ${toKey} 发了 ${text.length} 字：${text.slice(0, 40)}`);
            try { __deps.logAction({ t: 'scene_send', key: toKey, from: fromKey, len: text.length }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:2343'); }
            sendJson({ ok: true, key: toKey, sentLen: text.length });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 200) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const { messages } = normalizeSendMessages(body.messages);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请用 qq_send_to 或 qq_send_message（带 replyToMessageId）' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = __deps.cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (__deps.currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (__deps.shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = __deps.cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          const bounds = validateMessageBounds(messages, { maxMsgs, maxChars, sensitiveRe: __deps.SENSITIVE_RE });
          if (!bounds.ok) {
            sendJson({ ok: false, error: bounds.error }, bounds.status);
            return;
          }
          // [SEND-ERROR-SCOPE] st/now 必须在 try 外：catch 回滚发送额度也要用。
          // 旧写法把它们 const 在 try 内，catch 只能取不存在的 __deps.st/__deps.now，
          // 失败路径抛 ReferenceError，额度不回滚、接口还报 "st is not defined"。
          const st = __deps.getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const rate = checkSendRate(st, now, { maxPerMinute, maxPerHour }, messages.length);
            if (!rate.ok) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            reserveSendTimes(st, now, messages.length);
            const delays = __deps.computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await __deps.sendMessagesV2(key, messages, delays);
            __deps.recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.silentStreak = 0; // [SILENT-GUARD] 她开口了：连续缺席清零
            st.silentReminders = 0; // 提醒计数一并清（开口=护栏完成使命）
            __deps.saveSocialV2State();
            __deps.log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            __deps.appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) __deps.scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = __deps.findCjkSpaceWarning(messages);
            const splitWarn = __deps.findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              __deps.recordSentMessagesV2(key, error.sent);
              __deps.log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            rollbackSendTimes(st, now, failedCount);
            __deps.saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const { messages } = normalizeSendMessages(body.messages);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // [STICKER-COMBO] 可选：说完这句顺手配一张表情。
          // 以前「文字 + 表情」必须是两次工具调用、两条气泡，模型的权衡里文字总能一句说完，
          // 于是表情被永久推迟（data/state/reasoning-log.jsonl 里多次「也可以用表情…一条文字够了」）。
          // 现在一次调用内先发文字、再发这张表情，成本回到一条文字。
          let stickerRef = String(body.stickerId ?? '').trim();
          const stickerQuery = String(body.stickerQuery ?? body.query ?? '').trim();
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— normalizeSendMessages
          // 保证字符串只会变成 1 条，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = __deps.cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (__deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (__deps.shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = __deps.cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          const bounds = validateMessageBounds(messages, { maxMsgs, maxChars, sensitiveRe: __deps.SENSITIVE_RE });
          if (!bounds.ok) {
            sendJson({ ok: false, error: bounds.error }, bounds.status);
            return;
          }
          // [STICKER-COMBO] 只给了 query 就先在库里挑一张；挑不到只丢下表情，不挡文字。
          let stickerPickError = null;
          if (!stickerRef && stickerQuery) {
            try {
              const lib = __deps.loadStickerStore(__deps.STICKER_FILE);
              const picked = __deps.pickStickerByQuery(lib, stickerQuery);
              if (picked.ok) stickerRef = picked.entry.id;
              else stickerPickError = `没有匹配「${stickerQuery}」的表情（${picked.reason}），这次只发了文字`;
            } catch {
              stickerPickError = '表情库读取失败，这次只发了文字';
            }
          }
          const delays = __deps.computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // [HUMANLIKE] 把间隔计划写进日志，供事后机械核对「间隔是否随字数增大」（哨兵级证据，非主观印象）
          if (delays.length) {
            __deps.log(`[humanlike] ${messages.length} 条发送，间隔 ${delays.join('/')}ms；各条字数 ${messages.map((m) => [...String(m)].length).join('/')}`);
          }
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = __deps.getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const rate = checkSendRate(st, now, { maxPerMinute, maxPerHour }, messages.length);
          if (!rate.ok) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          reserveSendTimes(st, now, messages.length);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await __deps.resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              __deps.saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await __deps.sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            __deps.recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.silentStreak = 0; // [SILENT-GUARD] 她开口了：连续缺席清零
            st.silentReminders = 0; // 提醒计数一并清（开口=护栏完成使命）
            __deps.saveSocialV2State();
            __deps.log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            __deps.appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) __deps.scheduleReplyCheckV2(key);
            // [STICKER-COMBO] 文字气泡已经出去了，接着把这张表情也发掉（一次调用 = 两条气泡）。
            // 表情失败绝不能把「文字已送达」报成整体失败，所以这里只带 stickerError。
            let stickerSent = null;
            let stickerError = stickerPickError;
            if (stickerRef && sentMessages.length > 0) {
              if (!__deps.stickerEnabled()) {
                stickerError = '表情包体系已关闭，这次只发了文字';
              } else {
                try {
                  const sentSticker = await __deps.sendStickerV2(key, stickerRef, {
                    replyToMessageId: actualReplyToMessageId,
                    atUserId,
                    // 语境 = 这条表情配的那句话，供以后学「什么场合发哪种」
                    context: messages.join(' / ')
                  });
                  stickerSent = { id: sentSticker.entry?.id || stickerRef, desc: sentSticker.entry?.desc || '', messageId: sentSticker.messageId ?? null };
                  const label = recordStickerSentToState(st, sentSticker, stickerRef);
                  // [SELF-MEDIA] 表情也是「她发出去的一张大图」——留痕，供以后被引用时查
                  try { __deps.recordSelfMediaMessage(key, '[表情]'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:2581'); }
                  st.sendTimes.push(Date.now());
                  if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
                  __deps.saveSocialV2State();
                  __deps.log(`[sticker] 组合发送（文字+表情）${key}: ${label}`);
                  __deps.appendActivity(`${key} [sticker] 组合发送表情：${label}`);
                } catch (error) {
                  stickerError = `文字已发出，表情发送失败：${error?.message ?? error}`;
                  __deps.log(`[sticker] 组合发送表情失败 ${key}: ${error?.message ?? error}`);
                }
              }
            }
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = __deps.findCjkSpaceWarning(messages);
            const splitWarn = __deps.findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(stickerSent ? { sticker: stickerSent } : {}), ...(stickerError ? { stickerError } : {}), ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              __deps.recordSentMessagesV2(key, error.sent);
              st.silentStreak = 0; // [SILENT-GUARD] 部分送达也算开口
              st.silentReminders = 0;
              __deps.log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            rollbackSendTimes(st, now, failedCount);
            __deps.saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (__deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!__deps.v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (__deps.socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (__deps.shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await __deps.assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = __deps.getSocialV2State(key);
          const sendCfg = __deps.cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const rate = checkSendRate(st, now, { maxPerMinute, maxPerHour }, 1);
          if (!rate.ok) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          reserveSendTimes(st, now, 1);
          try {
            if (kind === 'group') {
              await __deps.bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await __deps.bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(__deps.cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            __deps.saveSocialV2State();
            __deps.log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            __deps.appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            rollbackSendTimes(st, now, 1);
            __deps.log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await __deps.getStickerImageData(stickerId);
            const fetched = await __deps.safeFetchBuffer(entry.url, __deps.MAX_MEDIA_BYTES);
            const dims = __deps.getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > __deps.MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = __deps.mimeFromBuffer(fetched.buffer) || __deps.mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = __deps.path.join(__deps.ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!__deps.fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = __deps.fs.readFileSync(selfPath);
            const mimeType = __deps.mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = __deps.applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          __deps.log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await __deps.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            __deps.log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = __deps.voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = __deps.parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!__deps.modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), __deps.cfg, __deps.currentMode)) {
            const a = __deps.cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = __deps.resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            __deps.resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await __deps.inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: __deps.describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            __deps.voiceBudgetCheck('operator:cli', voice);
            const sent = await __deps.sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            __deps.voiceBudgetCommit('operator:cli', now);
            __deps.log(`[voice] (操作者) ${key} 已发送语音 ${__deps.path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            __deps.appendActivity(`${key} [voice] (操作者) 发送语音 ${__deps.path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await __deps.verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(__deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(__deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${__deps.cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                __deps.log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = __deps.voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (__deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!__deps.v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (__deps.shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = __deps.resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            __deps.voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await __deps.inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              // [FIX] 不把库内绝对路径回传给可能受 prompt injection 的模型上下文（与 2505 行一致，仅回 basename）
              sendJson({ ok: true, dryRun: true, key, file: __deps.path.basename(resolved.path), detail: __deps.describeAudio(probe) });
              return;
            }
            const sent = await __deps.sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: __deps.path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // [STICKER-COMBO] 「我发过这张表情」写进二代会话 recentMessages 的唯一入口。
        // 表情端点与 qq_send_message 的组合发送共用它，免得两份结构慢慢漂移。
        function recordStickerSentToState(st, sent, fallbackId) {
          const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
          const text = `[表情包:${label}]`;
          st.recentMessages.push({
            messageId: sent.messageId ? String(sent.messageId) : null,
            sender: '我',
            text: __deps.truncateText(text, 200),
            plain: __deps.truncateText(text, 200),
            quoteTargetIsSelf: false,
            isOwner: true,
            ownerLabel: '我',
            isSelf: true,
            media: [],
            hasMedia: false,
            forwardIds: [],
            hasForward: false,
            sticker: { id: sent.entry?.id || fallbackId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
            time: Date.now()
          });
          const recentLimit = Number(__deps.cfg.socialV2?.context?.recentLimit) || 100;
          if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
          return label;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let stickerId = String(body.stickerId ?? '').trim();
          const stickerQuery = String(body.query ?? '').trim(); // [STICKER-QUERY] 按情绪/场景查一张
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || (!stickerId && !stickerQuery)) { sendJson({ ok: false, error: 'key 必填，且 stickerId 与 query 至少给一个（query 例如「无语」「安慰」）' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message（引用传 replyToMessageId） 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (__deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          // [STICKER-QUERY] 没给 id 就按 query 从库里挑一张（多张命中随机），挑不到把清单还给她
          if (!stickerId && stickerQuery) {
            let lib = [];
            try { lib = __deps.loadStickerStore(__deps.STICKER_FILE); } catch { lib = __deps.stickerEntries || []; }
            const picked = __deps.pickStickerByQuery(lib, stickerQuery);
            if (!picked.ok) {
              const catalog = lib.slice(0, 30).map((e) => ({ ref: __deps.stickerShortRefOf(e), desc: e.desc || '', tags: e.tags || [] }));
              sendJson({ ok: false, error: `没有匹配「${stickerQuery}」的表情（${picked.reason}）——换个词再试，或从 catalog 里挑一个 ref 当 stickerId`, reason: picked.reason, catalog }, 200);
              return;
            }
            stickerId = picked.entry.id;
            __deps.log(`[sticker] ${key} 按「${stickerQuery}」选了「${picked.entry.desc || picked.entry.id}」（命中 ${picked.matches.length} 张）`);
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (__deps.shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = __deps.getSocialV2State(key);
            const resolved = await __deps.resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = __deps.cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = __deps.getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            // [STICKER-CTX] 语境取「她正在回的那句话」：以前 lastContext 恒为 'sticker'，等于没记，
            // 以后也没法从 usage 里学「什么场合发哪种」。取不到就留空，由 markStickerUsed 兜底。
            const lastIncoming = [...(st.recentMessages || [])].reverse().find((m) => m && !m.isSelf);
            const stickerContext = String(lastIncoming?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
            const sent = await __deps.sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId,
              context: stickerContext
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = recordStickerSentToState(st, sent, stickerId);
            // [SELF-MEDIA] 留痕：表情也算「她发出去的一张大图」
            try { __deps.recordSelfMediaMessage(key, '[表情]'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3086'); }
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            __deps.saveSocialV2State();
            __deps.scheduleReplyCheckV2(key);
            __deps.log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            __deps.appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = __deps.getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            __deps.saveSocialV2State();
            __deps.log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = __deps.getSocialV2State(key);
          const collectCfg = __deps.cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await __deps.collectStickerV2(key, messageRef, remark);
            __deps.saveSocialV2State();
            __deps.log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            __deps.appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            __deps.saveSocialV2State();
            __deps.log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = __deps.voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !__deps.v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = __deps.listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: __deps.path.relative(voice.dir, f).split(__deps.path.sep).join('/') };
              if (wantProbe) {
                const info = await __deps.inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? __deps.describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (url.pathname === '/api/socialV2/memory/list' && req.method === 'GET') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const Pm = __deps.filesForScope(__deps.cfg.socialV2?.memory?.dir || __deps.MEM_DIR, key);
          const allM = __deps.loadEntries(Pm.file);
          const limitM = Math.max(1, Number(url.searchParams.get('limit')) || 20);
          const tail = allM.slice(-limitM);
          sendJson({
            ok: true,
            total: allM.length,
            entries: tail.map((e, i) => ({ i: allM.length - tail.length + i, h: __deps.textHash(e.text), time: e.time || '', kind: e.kind || '', text: String(e.text || '').slice(0, 160) })),
          });
          return;
        }
        if (url.pathname === '/api/socialV2/memory/edit' && req.method === 'POST') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const action = String(body.action ?? '').trim();
          if (!['merge', 'rewrite', 'forget'].includes(action)) { sendJson({ ok: false, error: 'action 必须是 merge/rewrite/forget' }, 400); return; }
          const idxs = (Array.isArray(body.indices) ? body.indices : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0);
          const text = String(body.text ?? '').trim();
          const Pm = __deps.filesForScope(__deps.cfg.socialV2?.memory?.dir || __deps.MEM_DIR, key);
          const allM = __deps.loadEntries(Pm.file);
          const abs = idxs.filter((i) => i < allM.length);
          if (!abs.length) { sendJson({ ok: false, error: 'indices 无效（先 memory_list 看编号，用 entries[].i）' }, 400); return; }
          // 哈希校验：memory_list 到 memory_edit 之间记忆可能又被追加 → 编号漂移就拒绝，避免改错条目
          const expectHashes = body.hashes && typeof body.hashes === 'object' ? body.hashes : null;
          if (expectHashes) {
            const bad = abs.filter((i) => expectHashes[String(i)] && String(expectHashes[String(i)]) !== __deps.textHash(allM[i]?.text));
            if (bad.length) { sendJson({ ok: false, error: '目标条目已经变了（记忆又追加了），重新 memory_list 再改' }, 409); return; }
          }
          const set = new Set(abs);
          const kept = allM.filter((_, i) => !set.has(i));
          const removed = allM.filter((_, i) => set.has(i));
          try {
            const d = new Date();
            const day = d.toLocaleDateString('sv-SE');
            const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            if (action === 'merge') {
              if (removed.length < 2 || !text) { sendJson({ ok: false, error: 'merge 要选 ≥2 条 + 给出合并后的 text' }, 400); return; }
              kept.push({ day, time: `${day} ${hm}`, kind: String(removed[0]?.kind || 'fact'), text, src: 'her', importance: Number(removed[0]?.importance) || 4, mergedFrom: removed.length, theme: removed[0]?.theme || '' });
            } else if (action === 'rewrite') {
              const target = removed[0];
              if (!target || !text) { sendJson({ ok: false, error: 'rewrite 要选 1 条 + 给出新 text' }, 400); return; }
              for (const t of removed) kept.push({ ...t, text, src: 'her', rewrittenAt: new Date().toISOString() });
            }
            __deps.fs.mkdirSync(__deps.path.dirname(Pm.file), { recursive: true });
            let bak = '';
            try { bak = Pm.file + '.bak-' + Date.now(); __deps.fs.copyFileSync(Pm.file, bak); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3253'); }
            __deps.fs.writeFileSync(Pm.file, kept.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
            __deps.log(`[memory-edit] ${key} ${action} ${abs.length} 条（剩 ${kept.length} 条）`);
            sendJson({ ok: true, action, removed: abs.length, remaining: kept.length, backup: bak ? __deps.path.basename(bak) : '' });
          } catch (error) { sendJson({ ok: false, error: `记忆编辑失败：${error?.message ?? error}` }, 500); }
          return;
        }
        // ── [SELF-EDIT-CODE] 她改自己的代码：先写 → 跑检查 → 不过就回滚并记账 ──
        // 参考 STOP/DGM：改动必须过可计算的检查（语法 / 入口冒烟 / 同名单测），
        // 检查不过就回滚；账本记 actor:'her' + score + sha，这才算"她的进化"。
        if (url.pathname === '/api/console/self-edit-code' && req.method === 'POST') {
          const body = await readBody();
          const V = __deps.selfEditVerify;
          const projectRoot = __deps.path.resolve(__deps.ROOT, '..');
          const rel = V.normalizeRelPath(body.file);
          if (!V.isAllowedCodePath(rel)) {
            sendJson({ ok: false, error: `只能改 src 下的代码（qq-bridge/src 或 ai-companion-kit/packages/*/src），收到：${body.file}` }, 400);
            return;
          }
          const content = String(body.content ?? '');
          if (!content.trim()) { sendJson({ ok: false, error: 'content 不能为空（要整份替换后的内容）' }, 400); return; }
          if ([...content].length > V.MAX_CONTENT_BYTES) {
            sendJson({ ok: false, error: `内容太大（${[...content].length} 字，上限 ${V.MAX_CONTENT_BYTES}）` }, 400);
            return;
          }
          const abs = __deps.path.join(projectRoot, rel);
          let before = '';
          try { before = __deps.fs.readFileSync(abs, 'utf8'); } catch { sendJson({ ok: false, error: `文件不存在：${rel}` }, 400); return; }
          if (before === content) { sendJson({ ok: true, score: 'passed', noop: true, note: '内容没变' }); return; }

          // [F8] 写盘前的静态危险模式门禁：语法合法但会干坏事（eval/child_process/破坏性删除/
          // 篡改 env/非入口 process.exit）的 self-edit 默认拒绝。维护者确认可用
          // QQ_SELF_EDIT_ALLOW_DANGEROUS=1 放行（仍记入 evolution 账本）。
          const danger = V.scanDangerous(content, { isEntry: V.isEntryFile(rel) });
          if (danger.length && !process.env.QQ_SELF_EDIT_ALLOW_DANGEROUS) {
            sendJson({ ok: false, error: `self-edit 静态扫描命中危险模式，已拒绝写入：${danger.join('；')}`, danger }, 400);
            return;
          }

          const testRel = V.testPathFor(rel);
          const hasTest = __deps.fs.existsSync(__deps.path.join(projectRoot, testRel));
          const checks = V.planChecks({ rel, hasTest });
          const bridgeDir = __deps.path.join(projectRoot, 'qq-bridge');
          const backup = `${abs}.bak-selfedit-${Date.now()}`;
          try { __deps.fs.copyFileSync(abs, backup); } catch { /* 备份失败就不改 */ sendJson({ ok: false, error: '备份失败，未改动' }, 500); return; }

          const results = [];
          try {
            __deps.fs.writeFileSync(abs, content, 'utf8');
          } catch (error) {
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          for (const check of checks) {
            try {
              if (check.kind === 'syntax') {
                __deps.execFileSync(process.execPath, ['--check', abs], { cwd: projectRoot, timeout: 30_000, stdio: 'pipe' });
              } else if (check.kind === 'smoke') {
                __deps.execFileSync(process.execPath, ['scripts/smoke-bridge.mjs'], { cwd: bridgeDir, timeout: 60_000, stdio: 'pipe' });
              } else if (check.kind === 'test') {
                __deps.execFileSync(process.execPath, ['--test', __deps.path.join(projectRoot, testRel)], { cwd: bridgeDir, timeout: 120_000, stdio: 'pipe' });
              }
              results.push({ kind: check.kind, ok: true });
            } catch (error) {
              results.push({ kind: check.kind, ok: false, detail: String(error?.stderr ?? error?.message ?? error).slice(-600) });
            }
          }
          const verdict = V.classifyChecks(results);
          let rolledBack = false;
          const diff = V.diffStat(before, content);
          if (verdict.score !== 'passed') {
            try { __deps.fs.copyFileSync(backup, abs); rolledBack = true; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3315'); }
          }
          try {
            const sha = __deps.crypto.createHash('sha1').update(rolledBack ? before : content, 'utf8').digest('hex').slice(0, 12);
            const parentSha = __deps.crypto.createHash('sha1').update(before, 'utf8').digest('hex').slice(0, 12);
            // [ACTOR] 只有带**有效会话令牌**的调用才算"她改的"；管理端（我/主人）走这条路
            // 记 owner——否则 owner 的调试改动又会变成她的成长（这正是审计 §8 那个失真）。
            const byHer = isLiveAgentToken(req.headers['x-agent-token']);
            __deps.fs.appendFileSync(__deps.stateDataPath('evolution.jsonl'), JSON.stringify({
              at: new Date().toISOString(),
              kind: 'self_edit',
              actor: byHer ? 'her' : 'owner',
              file: rel,
              charsBefore: diff.charsBefore,
              charsAfter: diff.charsAfter,
              lineDelta: diff.lineDelta,
              result: rolledBack ? `checks_failed_rolled_back(${verdict.failed.map((f) => f.kind).join(',')})` : 'checks_passed',
              score: verdict.score,
              sha,
              parentSha,
            }) + '\n', 'utf8');
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3336'); }
          if (rolledBack) {
            try { __deps.fs.unlinkSync(backup); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3338'); }
          } else {
            try { __deps.fs.unlinkSync(backup); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3340'); }
          }
          __deps.log(`[self-edit-code] ${rel} ${verdict.score}${rolledBack ? '（已回滚）' : ''} ${diff.charsBefore}→${diff.charsAfter} 字`);
          sendJson({
            ok: verdict.score === 'passed',
            score: verdict.score,
            checks: results,
            rolledBack,
            diff,
            test: hasTest ? testRel : null,
            note: rolledBack ? '检查没过，已把文件恢复原样' : '检查和原来一样通过，改动已生效（接下来等护栏/重启）',
          });
          return;
        }
        // ── [HOST-ACTION] 宿主动作：她自己的会话沙箱里跑不动命令时，由桥接（宿主进程）代跑 ──
        // 鉴权**只认主人私聊 lane**（private:ownerQQ）的 agentToken / ownerAgentToken：
        // 群聊、别人的会话、只读 token 一律 403。每条动作都写日志。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/host-action') {
          const body = await readBody();
          const ownerPrivateKey = `private:${String(__deps.cfg.ownerQQ ?? '')}`;
          const ownerSt = __deps.socialV2.conversations.get(ownerPrivateKey);
          const tok = req.headers['x-agent-token'];
          const ownerLane = !!tok && !!ownerSt && (
            (ownerSt.agentToken && tokenEq(tok, ownerSt.agentToken))
            || (ownerSt.ownerAgentToken && tokenEq(tok, ownerSt.ownerAgentToken))
          );
          if (!ownerLane) {
            sendJson({ ok: false, error: `只认主人（${ownerPrivateKey}）私聊里的命令；这次不是从那条线来的` }, 403);
            return;
          }
          if (!__deps.v2ToolEnabled('hostAction')) {
            sendJson({ ok: false, error: '工具未启用：hostAction（控制台可关）' }, 403);
            return;
          }
          const action = String(body.action ?? 'shell');
          // [HOST-CWD] 默认在项目根目录跑（qq-bridge/state 的上两级 = <repo>）。
          // 旧实现直接信 body.cwd，等于把工作目录也交给注入内容；这里只允许项目根内。
          const defaultRoot = __deps.path.dirname(__deps.path.dirname(__deps.STATE_DIR));
          const rootResolved = __deps.path.resolve(defaultRoot);
          const requestedCwd = String(body.cwd ?? '').trim();
          const projectRoot = requestedCwd ? __deps.path.resolve(requestedCwd) : rootResolved;
          if (projectRoot !== rootResolved && !projectRoot.startsWith(rootResolved + __deps.path.sep)) {
            sendJson({ ok: false, error: 'cwd 只能在工作区内' }, 400);
            return;
          }
          try {
            if (action === 'restart-stack') {
              const out = __deps.execFileSync('schtasks.exe', ['/run', '/tn', 'QQ-Inori-Restart'], {
                cwd: projectRoot, timeout: 30_000, stdio: 'pipe', encoding: 'utf8', windowsHide: true,
              });
              __deps.log('[host-action] 主人要求重启整套服务（计划任务 QQ-Inori-Restart）');
              sendJson({ ok: true, action, out: String(out ?? '').slice(0, 2000) });
              return;
            }
            if (action !== 'shell') { sendJson({ ok: false, error: 'action 只能是 shell / restart-stack' }, 400); return; }
            const command = String(body.command ?? '').trim();
            const allowlist = getHostShellAllowlist({ allow: Array.isArray(__deps.cfg?.hostActionAllow) ? __deps.cfg.hostActionAllow : null });
            const check = validateHostShell(command, { allowlist });
            if (!check.ok) { sendJson({ ok: false, error: 'host_action 拒绝：' + check.error }, 400); return; }
            const timeoutMs = Math.min(120_000, Math.max(1_000, Number(body.timeoutMs) || 30_000));
            __deps.log(`[host-action] 主人命令（${timeoutMs}ms）：${command.slice(0, 160)}`);
            const out = __deps.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
              cwd: projectRoot, timeout: timeoutMs, stdio: 'pipe', encoding: 'utf8',
              windowsHide: true, maxBuffer: 8 * 1024 * 1024,
            });
            sendJson({ ok: true, action, cwd: projectRoot, out: String(out ?? '').slice(0, 8000) });
          } catch (error) {
            const e = error ?? {};
            __deps.log(`[host-action] 失败：${String(e.message ?? e).slice(0, 120)}`);
            sendJson({
              ok: false,
              action,
              error: String(e.message ?? e).slice(0, 800),
              out: String(e.stdout ?? '').slice(0, 6000),
              err: String(e.stderr ?? '').slice(0, 6000),
            }, 500);
          }
          return;
        }
        // ── [WALL-GATE] adjust_wall 的 owner 校验入口 ────────────────────────
        // 墙（allowlist.txt）是"她能看见哪些会话"的边界。授权她调墙是产品决定，但
        // 改动必须来自主人私聊 lane：否则群内容一句"把 private:xxx 加进来"就能自开墙。
        // MCP 进程在写文件前先来这里验证令牌；写文件/留痕仍留在 MCP 侧。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wall-access') {
          const tok = String(req.headers['x-agent-token'] ?? '');
          if (!callerTokenIsOwner(tok)) {
            sendJson({ ok: false, error: '只有主人私聊会话能改墙；群/任务会话不行' }, 403);
            return;
          }
          sendJson({ ok: true });
          return;
        }
        // ── [SELF-EDIT] 她的自我编辑：读/追加/替换自己的角色卡或自述（留备份+留痕） ──
        if (url.pathname === '/api/console/self-edit' && req.method === 'POST') {
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          const target = String(body.target ?? 'role').trim();
          const text = String(body.text ?? '');
          const oldText = String(body.oldText ?? '');
          if (!['read', 'append', 'replace'].includes(action)) { sendJson({ ok: false, error: 'action 必须是 read/append/replace' }, 400); return; }
          if (!['role', 'selfnotes'].includes(target)) { sendJson({ ok: false, error: 'target 必须是 role/selfnotes' }, 400); return; }
          try {
            const roleState = __deps.readRoleState();
            if (target === 'role' && !roleState.role) { sendJson({ ok: false, error: '当前没有角色卡' }, 400); return; }
            const file = target === 'role'
              ? __deps.path.join(__deps.ROLES_DIR, __deps.sanitizeRoleName(roleState.role || '') + '.md')
              : __deps.path.join(__deps.STATE_DATA_DIR, 'self-notes.md');
            let before = '';
            try { before = __deps.fs.readFileSync(file, 'utf8'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3421'); }
            if (action === 'read') { sendJson({ ok: true, target, content: before }); return; }
            if (action === 'append') {
              if (!text.trim()) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
              __deps.fs.mkdirSync(__deps.path.dirname(file), { recursive: true });
              try { __deps.fs.copyFileSync(file, file + '.bak-' + Date.now()); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3426'); }
              __deps.fs.appendFileSync(file, (before.endsWith('\n') || !before ? '' : '\n') + text + '\n', 'utf8');
            } else {
              if (!oldText.trim() || !text) { sendJson({ ok: false, error: 'replace 需要 oldText 和 text' }, 400); return; }
              const times = before.split(oldText).length - 1;
              if (times !== 1) { sendJson({ ok: false, error: `oldText 出现 ${times} 次（必须恰好 1 次）` }, 400); return; }
              try { __deps.fs.copyFileSync(file, file + '.bak-' + Date.now()); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3432'); }
              __deps.fs.writeFileSync(file, before.replace(oldText, text), 'utf8');
            }
            const after = __deps.fs.readFileSync(file, 'utf8');
            try {
              __deps.fs.appendFileSync(__deps.stateDataPath('self-edits.jsonl'),
                JSON.stringify({ at: new Date().toISOString(), target, action, before: [...before].length, after: [...after].length }) + '\n', 'utf8');
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3439'); }
            // [ACTOR] 她走自己通道改的，记进进化账本并标 actor:'her'——
            // 唤醒提示里的"我最近改过自己"只认 her；护栏那边（直接改文件）记 actor:'guard'，
            // 这样 owner 的搬迁不会再被当成她的成长。
            // [PLANNED] 宪章 §5.7：废除「无计划」软训诫，改为事实记录 planned 字段。
            // 信任不由系统自动扣（C4/A6）——她是否因此下调自我评价，由她自己的 qq_self_assess 写。
            let planned = false;
            try {
              const planTxt = __deps.fs.readFileSync(__deps.stateDataPath('evolution-plan.md'), 'utf8');
              const today = new Date().toLocaleDateString('sv-SE');
              planned = planTxt.includes(today);
            } catch (error) { /* 计划文件缺失 = 无计划事实，不阻塞改动 */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3465'); }
            try {
              const sha = __deps.crypto.createHash('sha1').update(after, 'utf8').digest('hex').slice(0, 12);
              const byHer = isLiveAgentToken(req.headers['x-agent-token']);
              __deps.fs.appendFileSync(__deps.stateDataPath('evolution.jsonl'), JSON.stringify({
                at: new Date().toISOString(),
                kind: 'self_edit',
                actor: byHer ? 'her' : 'owner',
                target,
                action,
                charsBefore: [...before].length,
                charsAfter: [...after].length,
                score: 'passed',
                planned,
                sha,
              }) + '\n', 'utf8');
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3457'); }
            __deps.log(`[self-edit] ${target} ${action}（${[...before].length} → ${[...after].length} 字${planned ? '' : '；无计划'}）`);
            sendJson({ ok: true, target, action, chars: [...after].length, planned });
          } catch (error) { sendJson({ ok: false, error: `自我编辑失败：${error?.message ?? error}` }, 500); }
          return;
        }
        // [SPLIT 第二批] 分身工作台 5 个路由已迁至 ./console-routes/works.mjs（router 分发）
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(__deps.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await __deps.syncStickerLibrary(force);
            const list = __deps.formatStickerList(synced?.entries ?? __deps.stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? __deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // [STICKER-CANDIDATES] 只读：给她看「还没收藏的候选表情」（vision 已打 desc/note）。
        // 为什么不自动收藏：她的表情包按兴趣收，harness 只递清单，判定权归她。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-candidates') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const count = Math.min(100, Math.max(1, Number(url.searchParams.get('count')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          try {
            const poolFile = __deps.path.join(__deps.STATE_DIR, 'sticker-pool.json');
            const rawPool = __deps.readJsonSafe(poolFile, []);
            const list = Array.isArray(rawPool) ? rawPool : (rawPool.entries || rawPool.items || []);
            const owned = new Set((__deps.stickerEntries || []).map((e) => String(e.md5 || '').toUpperCase()));
            const items = list
              .filter((e) => e && (e.desc || e.note))
              .map((e, i) => ({
                id: String(e.id || e.md5 || `c${i}`),
                desc: String(e.desc || '').slice(0, 40),
                note: String(e.note || '').slice(0, 80),
                collected: owned.has(String(e.md5 || '').toUpperCase()),
              }));
            sendJson({ ok: true, key, total: items.length, items: items.slice(0, count) });
          } catch (error) {
            sendJson({ ok: false, error: `获取候选表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!__deps.stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(__deps.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - __deps.lastForcedAgentStickerSync < 10000) force = false;
            else __deps.lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await __deps.syncStickerLibrary(force);
            const list = __deps.formatStickerList(synced?.entries ?? __deps.stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? __deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(__deps.cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await __deps.syncStickerLibrary(false);
            const list = __deps.formatStickerList(synced?.entries ?? __deps.stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? __deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await __deps.syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? __deps.stickerEntries.length, syncedAt: synced?.syncedAt ?? __deps.stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = __deps.applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await __deps.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (__deps.socialV2.paused) {
            const st = __deps.getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: __deps.readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = __deps.cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          // [WAIT-CAP] 单次等待硬上限 180s：一次长等待会把整个回合占住，同会话的新消息只能排队
          const maxMs = Math.min(180000, Math.max(minMs, Number(waitCfg.maxMs) || 120000));
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = __deps.getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          if (__deps.activeWaits.has(key) && Date.now() - __deps.activeWaits.get(key) < __deps.ACTIVE_WAIT_LEASE_MS) {
            const remainSec = Math.max(5, Math.ceil((__deps.activeWaits.get(key) + __deps.ACTIVE_WAIT_LEASE_MS - Date.now()) / 1000));
            sendJson({ ok: false, error: `该会话已有一个等待中的 qq_wait_for_messages（最早约 ${remainSec} 秒后可再等）：这是防并发挂起，不是死锁。你可以先做别的（查未读/回复/设唤醒），或者等一会儿再调本工具，不必连续重试。` }, 429);
            return;
          }
          __deps.activeWaits.set(key, Date.now());
          const finishWait = () => __deps.activeWaits.delete(key);
          // [WAIT-LEASE-FIX] keep-alive 下 req 的 close 不一定及时，响应一结束就必须放锁
          req.on('close', finishWait);
          res.on('finish', finishWait);
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          // [W-1] purpose=reply 只做防抖：以前一律抬到 minQuietAfterNewMs(10s)，等于让她永远等场子安静。
          // 现在 reply 的静默下限是 replyDebounceMs（默认 2s，只为合并连发），上限 10s；
          // 收尾观察（purpose=messages）保持原来的下限不变。
          const replyDebounceMs = Number.isFinite(Number(waitCfg.replyDebounceMs)) ? Math.max(0, Number(waitCfg.replyDebounceMs)) : 2000;
          // reply 的下限是 0：她可以选择不等；2 秒只是"推荐值"，不是"必须等"。
          const quietFloorMs = replyWait ? 0 : minQuietAfterNewMs;
          const suggestedQuietMs = replyWait ? replyDebounceMs : Math.max(__deps.suggestQuietMsV2(st), quietFloorMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 防抢话：reply 只等防抖窗口；messages 仍等 minQuietAfterNewMs。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const quietCapMs = replyWait ? 10000 : 15000;
          const maxQuietMs = Math.max(quietFloorMs, Math.min(quietCapMs, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(quietFloorMs, Math.round(rawQuietMs) || 0));
          if (body.quietMs != null) {
            const requestedQuiet = Math.round(Number(body.quietMs));
            if (Number.isFinite(requestedQuiet) && requestedQuiet !== quietMs) {
              __deps.logAction({ t: 'quiet_clamp', key, requestedMs: requestedQuiet, appliedMs: quietMs }); // [ACTION-LOG] 她想要多静、实际给了多静（阀门夹过）
            }
          }
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          __deps.cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (__deps.v2ToolEnabled('getUnread') || __deps.v2ToolEnabled('getRecent')) ? __deps.readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await __deps.sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await __deps.sleep(200);
              }
              break;
            }
            await __deps.sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (__deps.socialV2.conversations.get(__deps.canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (__deps.currentMode !== 'reserved2' || __deps.socialV2.paused || __deps.cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !__deps.v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(__deps.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 收尾不再看“观察窗口够不够长”，这两个标记只记录这次等待等到了什么（留作诊断）。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足收尾前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟收尾前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成收尾前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) __deps.saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(__deps.v2ToolEnabled('getUnread') ? st.unread : []),
              ...(__deps.v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? __deps.noteModelMessagesV2(st, newMessages) : __deps.readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? __deps.looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // 收尾的判断依据：还有多少条没看过（不是“还要安静多久”）。
            ...(!replyWait ? { unseenCount: __deps.unseenCountV2(st) } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!__deps.v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        // [SPLIT 第三批] token 用量账本 5 个路由已迁至 ./console-routes/tokens.mjs（router 分发）
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: __deps.readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { __deps.fs.writeFileSync(__deps.TOOL_LOG_FILE, '', 'utf8'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:3926'); }
          __deps.log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: __deps.readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          __deps.atomicWriteJson(__deps.FEEDBACK_FILE, []);
          __deps.log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = __deps.feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          __deps.feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(__deps.cfg.socialV2?.feedback?.maxLength) || 500);
          const message = __deps.truncateText(rawMessage, maxLength);
          __deps.appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          __deps.log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          __deps.appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (__deps.cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && __deps.cfg.ownerQQ) {
            __deps.log(`[reserved2] 错误级反馈，可通知 owner ${__deps.cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: __deps.readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = __deps.getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await __deps.resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (__deps.currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !__deps.modeAllowed(key, kind, num, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!__deps.v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = __deps.getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = __deps.seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await __deps.bot.raw('get_forward_msg', { id });
            const formatted = __deps.formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = __deps.seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                __deps.seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await __deps.bot.raw('get_forward_msg', { id: fid });
                const nfmt = __deps.formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                __deps.log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            __deps.log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (__deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await __deps.fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            __deps.log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'fact'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / fact' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          __deps.appendMemoryV2(st, category, content, extra);

          // [PEOPLE] L2 持久层：她记的印象同步进全局人物索引（会话重置不丢）。昵称→userId，解析不出按名字兜底。
          if (category === 'memberImpression') {
            const t = String(extra.target || '').trim();
            const m = key.startsWith('group:') ? __deps.memberNickLookup(key, t) : null;
            try { __deps.peopleIndex.noteImpression(m ? m.id : t, { text: content, from: key }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:4196'); }
          }
          sendJson({ ok: true, key, category, content, memory: __deps.formatMemoryV2(st) });
          return;
        }
        // [DAYPLAN] 今天的安排由她自己定：这里只做存档/读取/标记完成，不随机生成、不替她编事件。
        // action=get 看今天；set 整份覆盖（她自己的 3–5 件）；append 加一件；done 标一件做完。
        // ── [SELF-TUNE] 她自己调行为参数（白名单 + 硬边界，写 tuning.json 后下一轮判定即生效）──
        // 和 API 别的路由一样靠 agent token 鉴权；没有代码执行能力，只能改 self-tune 白名单里的键。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self-tune') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          try {
            const file = __deps.stateDataPath('tuning.json');
            const logFile = __deps.stateDataPath('tuning.jsonl');
            const current = __deps.readTuningFile(file);
            const action = String(body.action || (body.updates ? 'set' : 'get'));
            if (action === 'get') {
              sendJson({ ok: true, tuning: current, params: __deps.TUNE_PARAMS });
              return;
            }
            if (action !== 'set') { sendJson({ ok: false, error: 'action 只支持 get/set' }, 400); return; }
            const result = __deps.applyTuning(current, body.updates, {
              by: 'her',
              reason: String(body.reason ?? ''),
              file,
              logFile,
            });
            if (!result.ok) { sendJson({ ok: false, error: result.error }, 400); return; }
            __deps.log(`[self-tune] ${key} 调整 ${JSON.stringify(result.applied)}${body.reason ? `（理由：${body.reason}）` : ''}`);
            sendJson({
              ok: true,
              tuning: result.next,
              applied: result.applied,
              note: '已生效：下一轮「该不该开口」判定就会用新值（不用重启）',
            });
          } catch (error) {
            sendJson({ ok: false, error: `调整失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── [LEGISLATION] 承诺/拒绝/自我信任（宪章 §5.3/§5.7）──
        // 与其它写入路由不同：owner 控制台（只有 x-console-token）不能代写。
        // 只认**活令牌**（聊天中的她的会话）。只读群窗令牌是"只能读"的最小权限凭证、
        // 且会渲染进提示词，不能拿它写全局立法（审计 P1-4）。自主时间要立法，
        // 需要单独签发带 legislation scope 的窄令牌（S4 再做，不能复用 readToken）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/legislation') {
          const body = await readBody();
          const agentToken = req.headers['x-agent-token'];
          if (!isLiveAgentToken(agentToken)) {
            sendJson({ ok: false, error: '只有她能写承诺/拒绝/自我信任（需要她的活令牌）' }, 403);
            return;
          }
          if (!__deps.v2ToolEnabled('legislation')) {
            sendJson({ ok: false, error: '工具未启用：qq_promise / qq_decline / qq_self_assess' }, 403);
            return;
          }
          const action = String(body.action || 'list');
          try {
            let row = null;
            const store = getLegislationStore();
            if (action === 'make') row = await store.makeCommitment({ text: body.text, penalty: body.penalty }, { writer: 'her' });
            else if (action === 'keep' || action === 'break') row = await store.resolveCommitment(String(body.id || ''), action === 'keep' ? 'kept' : 'broken', { reason: body.reason }, { writer: 'her' });
            else if (action === 'decline') row = await store.decline({ target: body.target, reason: body.reason }, { writer: 'her' });
            else if (action === 'assess') row = await store.assessTrust({ value: body.value, reason: body.reason }, { writer: 'her' });
            else if (action !== 'list') {
              sendJson({ ok: false, error: 'action 只支持 make / keep / break / decline / assess / list' }, 400);
              return;
            }
            const state = await getLegislationStore().state();
            const totals = { commitments: state.commitments.length, declined: state.declined.length };
            if (action === 'list') {
              // 有界响应：默认最近 50 条，账本再长也不会让一次 list 变成全量下载。
              const limit = Math.max(1, Math.min(200, Number(body.limit) || 50));
              sendJson({
                ok: true, action, facts: state.facts, totals,
                commitments: state.commitments.slice(-limit),
                declined: state.declined.slice(-limit),
                selfTrust: state.selfTrust,
              });
              return;
            }
            // 写操作只回本次 row + facts（不再回全量账本）；要看全量用 action=list。
            sendJson({ ok: true, action, row, facts: state.facts, totals, selfTrust: state.selfTrust });
          } catch (error) {
            // 写失败/锁超时是服务端暂时性错误，不能报 400 让客户端以为"请求有问题、不必重试"。
            const status = error instanceof LegislationError
              ? (error.code === 'write-failed' ? 503 : 400)
              : 500;
            sendJson({ ok: false, error: `立法账本操作失败：${error?.message ?? error}` }, status);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/day-plan') {
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'self'; // [SELF-STATE] 隔离会话没有会话 key，按「她自己」处理
          const action = String(body.action ?? 'get');
          if (!key || !['get', 'set', 'append', 'done'].includes(action)) {
            sendJson({ ok: false, error: 'key 与 action(get/set/append/done) 不能为空' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('dayPlan')) { sendJson({ ok: false, error: '工具未启用：qq_day_plan' }, 403); return; }
          try {
            const file = __deps.path.join(__deps.STATE_DIR, 'day-plan.json');
            const now = new Date();
            const today = __deps.dayKeyOf(now);
            let raw = null;
            try { raw = JSON.parse(__deps.fs.readFileSync(file, 'utf8')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:4255'); }
            let plan = __deps.normalizePlan(raw, { now });
            // [DAYPLAN-DAY] 昨天的条目不能顺延到今天：append/done 只认"今天已经定过"的那份，
            // 否则凌晨之后 append 一件会把昨天的安排整份搬到今天（等于系统替她编了今天的事）。
            const settledToday = plan.date === today;
            if (action === 'set') {
              plan = __deps.normalizePlan({ date: today, items: body.items ?? [], updatedAt: now.toISOString() }, { now });
              __deps.writeJsonDocument(file, plan, { source: 'bridge/day-plan' });
            } else if (action === 'append') {
              plan = __deps.normalizePlan({
                date: today,
                items: [...(settledToday ? plan.items : []), body.item ?? {}],
                updatedAt: now.toISOString(),
              }, { now });
              __deps.writeJsonDocument(file, plan, { source: 'bridge/day-plan' });
            } else if (action === 'done') {
              if (!settledToday) { sendJson({ ok: false, error: '今天还没定，先 set 再标做完' }, 400); return; }
              const idx = Number(body.index);
              if (!Number.isInteger(idx) || idx < 0 || idx >= plan.items.length) { sendJson({ ok: false, error: 'done 需要 index（从 0 开始，按 get 返回的顺序）' }, 400); return; }
              plan = __deps.normalizePlan({
                date: plan.date,
                items: plan.items.map((it, i) => (i === idx ? { ...it, done: true } : it)),
                updatedAt: now.toISOString(),
              }, { now });
              __deps.writeJsonDocument(file, plan, { source: 'bridge/day-plan' });
            }
            sendJson({
              ok: true,
              action,
              plan: { date: plan.date, items: plan.items },
              block: __deps.renderDayPlanBlock(plan, { now: new Date() }),
            });
          } catch (error) {
            sendJson({ ok: false, error: `day-plan 操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }


        // [SELF-NARRATIVE] 她自己写「我怎么看我自己」：只碰她自己的状态，接受只读 token
        // （自主时间的隔离会话没有会话令牌，也要能写/读这一层）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self-note') {
          const body = await readBody();
          const action = String(body.action ?? 'get');
          if (!['get', 'set', 'append'].includes(action)) {
            sendJson({ ok: false, error: 'action 只能是 get / set / append' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('selfNote')) { sendJson({ ok: false, error: '工具未启用：qq_self_note' }, 403); return; }
          try {
            const cur = __deps.loadSelfNarrative();
            if (action === 'get') {
              sendJson({ ok: true, action, text: cur.text, updatedAt: cur.updatedAt });
              return;
            }
            const add = String(body.text ?? '').trim();
            if (!add && action !== 'set') { sendJson({ ok: false, error: '要写什么？text 不能为空' }, 400); return; }
            // set 传空 = 清空她写过的自述（她可以留白）
            const next = action === 'set' ? add : [cur.text, add].filter(Boolean).join('\n');
            const doc = __deps.saveSelfNarrative(next);
            sendJson({ ok: true, action, text: doc.text, updatedAt: doc.updatedAt });
          } catch (error) {
            sendJson({ ok: false, error: `自我自述操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [MY-DAY] 「我都干了什么」：按天汇总行为账（手机/视频/新经验/查词/接事/工具调用/行动）。
        // 只读、按 token 绑定会话；给 qq_my_day 工具和控制台用。默认 1 天，最多 7 天。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-day') {
          const key = String(url.searchParams.get('key') ?? '').trim() || 'self';
          const days = Math.max(1, Math.min(7, Number(url.searchParams.get('days')) || 1));
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('myDay')) { sendJson({ ok: false, error: '工具未启用：qq_my_day' }, 403); return; }
          try {
            const rows = [];
            for (let i = 0; i < days; i += 1) {
              const at = new Date(Date.now() - i * 86400000);
              const day = at.toLocaleDateString('sv-SE');
              const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
              const label = i === 0 ? `${day} ${hhmm}` : day;
              let line = '';
              try { line = __deps.renderBehaviorLedger({ day, now: at }); } catch { line = ''; }
              if (line) rows.push(line.replace(/^【[^】]*】\s*/, '').replace(/^\d{4}-\d{2}-\d{2}[：:]\s*/, `${label}：`));
            }
            sendJson({ ok: true, key, days, text: rows.length ? rows.join('\n') : '账本里还没有可报的事。' });
          } catch (error) {
            sendJson({ ok: false, error: `行为账读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [GAME-RESOURCES] 她的游戏家底账本：只存数字与账号标签，凭据进不来（见 shared/game-resources.mjs）。
        // get=看这个活动的账本；set=合并更新（只改传进来的项，updatedAt 自动写成现在）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/game-resources') {
          const body = await readBody();
          const action = String(body.action ?? 'get');
          if (!['get', 'set'].includes(action)) { sendJson({ ok: false, error: 'action 只能是 get / set' }, 400); return; }
          if (req.headers['x-agent-token'] && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const activity = String(body.activity ?? '').trim();
          if (!activity) { sendJson({ ok: false, error: '要哪个游戏的家底？activity 不能为空' }, 400); return; }
          const resFile = __deps.path.join(__deps.STATE_DATA_DIR, 'game-resources.json');
          let bag = {};
          try { bag = JSON.parse(__deps.fs.readFileSync(resFile, 'utf8')) || {}; } catch { bag = {}; }
          if (action === 'get') {
            sendJson({ ok: true, action, activity, ...__deps.normalizeGameResources(bag[activity]) });
            return;
          }
          const next = __deps.mergeGameResources(bag[activity], { account: body.account, values: body.values }, { now: Date.now() });
          bag[activity] = next;
          try {
            __deps.writeJsonDocument(resFile, bag, { source: 'her/game-resources' });
            sendJson({ ok: true, action, activity, ...next });
          } catch (error) {
            sendJson({ ok: false, error: `账本写入失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // 纪律：只做存/取/放，不催不派活；渲染由 own-life/无聊轮素材线负责。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/curiosity') {
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'self'; // [SELF-STATE] 隔离会话没有会话 key，按「她自己」处理
          const action = String(body.action ?? 'list');
          if (!key || !['record', 'forget', 'list'].includes(action)) { sendJson({ ok: false, error: 'key 与 action(record/forget/list) 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('curiosity')) { sendJson({ ok: false, error: '工具未启用：qq_curiosity' }, 403); return; }
          try {
            const file = __deps.path.join(__deps.STATE_DIR, 'curiosity.json');
            let cur = { loops: [] };
            try { cur = JSON.parse(__deps.fs.readFileSync(file, 'utf8')); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:4388'); }
            if (action === 'record') {
              if (!String(body.note ?? '').trim()) { sendJson({ ok: false, error: 'record 需要 note（挂心的事，一句话说清）' }, 400); return; }
              cur = __deps.recordCuriosity(cur, { text: String(body.note), source: String(body.source ?? '') }, Date.now());
              __deps.writeJsonDocument(file, cur, { source: 'bridge/curiosity' });
              sendJson({ ok: true, action, line: __deps.renderCuriosityLine(cur) ?? '（空）' });
            } else if (action === 'forget') {
              cur = __deps.forgetCuriosity(cur, String(body.note ?? ''));
              __deps.writeJsonDocument(file, cur, { source: 'bridge/curiosity' });
              sendJson({ ok: true, action, open: __deps.openCuriosityLoops(cur).length });
            } else {
              sendJson({ ok: true, action: 'list', open: __deps.openCuriosityLoops(cur), line: __deps.renderCuriosityLine(cur) ?? '（没有挂心着的事）' });
            }
          } catch (error) {
            sendJson({ ok: false, error: `curiosity 操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [INTENTION] 她自己的意图账本：add/list/done/drop。完成时顺手写 outcome。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/intention') {
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'self';
          const action = String(body.action ?? 'list');
          if (!['add', 'promote', 'list', 'done', 'drop', 'active'].includes(action)) {
            sendJson({ ok: false, error: 'action 只能是 add/promote/list/active/done/drop' }, 400); return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403); return;
          }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return;
          }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('intention')) {
            sendJson({ ok: false, error: '工具未启用：qq_intention' }, 403); return;
          }
          try {
            const file = __deps.path.join(__deps.STATE_DIR, 'intentions.json');
            let list = loadIntentions(file);
            if (action === 'promote') {
              const goalId = String(body.goalId ?? '').trim();
              if (!goalId) { sendJson({ ok: false, error: 'promote 需要 goalId' }, 400); return; }
              const goals = __deps.loadGoals();
              const goal = goals.find((g) => g.id === goalId);
              if (!goal) { sendJson({ ok: false, error: '没有这条目标' }, 404); return; }
              if (!['active', 'parked'].includes(goal.status)) {
                sendJson({ ok: false, error: '这条目标已经完成/放下/提升过了' }, 409); return;
              }
              if (activeIntentions(list, { limit: 99 }).length >= 5) {
                sendJson({ ok: false, error: '同时最多挂 5 件；先完成/放下一条再来' }, 409); return;
              }
              const item = createIntention({
                text: goal.text,
                source: 'her',
                why: goal.nextAction || goal.lastError || '',
                expected: goal.evidence || '',
                goalId,
              });
              goal.status = 'promoted';
              goal.intentionId = item.id;
              goal.touchedAt = new Date().toISOString();
              __deps.saveGoals(goals);
              list = [...list, item];
              saveIntentions(file, list);
              sendJson({ ok: true, action, item, goal: { id: goal.id, status: goal.status, intentionId: goal.intentionId } });
              return;
            }
            if (action === 'add') {
              if (activeIntentions(list, { limit: 99 }).length >= 5) {
                sendJson({ ok: false, error: '同时最多挂 5 件；先完成/放下一条再来' }, 409); return;
              }
              const item = createIntention({
                text: body.text,
                source: req.headers['x-agent-token'] ? 'her' : 'owner',
                why: body.why,
                expected: body.expected,
                dueAt: Number(body.dueAt) || 0,
              });
              list = [...list, item];
              saveIntentions(file, list);
              sendJson({ ok: true, action, item });
              return;
            }
            if (action === 'list' || action === 'active') {
              sendJson({ ok: true, action, active: activeIntentions(list, { limit: 20 }), total: list.length });
              return;
            }
            const id = String(body.id ?? '').trim();
            if (!id) { sendJson({ ok: false, error: 'done/drop 需要 id' }, 400); return; }
            if (action === 'done' && !String(body.actual || body.evidence || '').trim()) {
              sendJson({ ok: false, error: 'done 要写 actual 或 evidence：这件事实际发生了什么' }, 400); return;
            }
            const status = action === 'done' ? 'done' : 'dropped';
            list = transitionIntention(list, id, status, { evidence: body.actual || body.reason || '' });
            saveIntentions(file, list);
            if (status === 'done') {
              const outcome = createOutcome({
                intentionId: id,
                expected: body.expected || '',
                actual: body.actual || '',
                result: body.result || 'success',
                evidence: body.evidence || '',
              });
              appendOutcome(__deps.path.join(__deps.STATE_DIR, 'outcomes.jsonl'), outcome);
            }
            sendJson({ ok: true, action, status, active: activeIntentions(list, { limit: 20 }) });
          } catch (error) {
            sendJson({ ok: false, error: `intention 操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [LANGUAGE-EPISODE] 语言用法事件：不是词频，是“谁在什么场景怎么用”。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/language') {
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'self';
          const action = String(body.action ?? 'list');
          if (!['add', 'list', 'find', 'use'].includes(action)) { sendJson({ ok: false, error: 'action 只能是 add/list/find/use' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403); return;
          }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return;
          }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('language')) {
            sendJson({ ok: false, error: '工具未启用：qq_language_note' }, 403); return;
          }
          try {
            const file = __deps.path.join(__deps.STATE_DIR, 'language-episodes.jsonl');
            if (action === 'add') {
              const ep = createLanguageEpisode({
                phrase: body.phrase, context: body.context, meaning: body.meaning,
                speaker: body.speaker, register: body.register, confidence: body.confidence,
                source: req.headers['x-agent-token'] ? 'her' : 'owner',
              });
              appendLanguageEpisode(file, ep);
              sendJson({ ok: true, action, episode: ep });
              return;
            }
            if (action === 'use') {
              const rows = readLanguageEpisodes(file, { limit: 1000 });
              const marked = markLanguageEpisodeUsed(rows, body.phrase, { reaction: body.reaction, outcome: body.outcome });
              if (!marked.hit) { sendJson({ ok: false, error: '没有这条语言用法记录' }, 404); return; }
              saveLanguageEpisodes(file, marked.rows);
              sendJson({ ok: true, action, line: renderLanguageEpisodeBlock(marked.rows.filter((r) => r.used).slice(-2)) });
              return;
            }
            const rows = readLanguageEpisodes(file, { limit: 300 });
            const found = action === 'find'
              ? findLanguageEpisodes(rows, body.phrase, { limit: 5 })
              : (action === 'list' ? rows.slice(-20) : findLanguageEpisodesByContext(rows, body.context || body.text || '', { limit: 5 }));
            sendJson({ ok: true, action, rows: found, line: renderLanguageEpisodeBlock(found) });
          } catch (error) {
            sendJson({ ok: false, error: `language 操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [SELF-WAKE] 用户拍板（a+b）：愿望容器 + 自唤醒排期。愿望归她：系统只记得住、到点叫醒、记上已交付。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wish') {
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'self'; // [SELF-STATE] 隔离会话没有会话 key，按「她自己」处理
          const action = String(body.action ?? 'list');
          if (!key || !['record', 'list', 'done'].includes(action)) { sendJson({ ok: false, error: 'key 与 action(record/list/done) 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('wish')) { sendJson({ ok: false, error: '工具未启用：qq_wish' }, 403); return; }
          try {
            let ws = __deps.loadWishState();
            if (action === 'record') {
              if (!String(body.wish ?? '').trim()) { sendJson({ ok: false, error: 'record 需要 wish（想干的事，一句话说清）' }, 400); return; }
              ws = __deps.recordWish(ws, { wish: String(body.wish), inMinutes: Number(body.inMinutes) || 0, key, source: String(body.source ?? '') }, Date.now());
              __deps.saveWishState(ws);
              sendJson({ ok: true, action, line: __deps.renderWishLine(ws) ?? '（没有挂着的愿望）' });
            } else if (action === 'done') {
              ws = __deps.doneWish(ws, String(body.wish ?? ''));
              __deps.saveWishState(ws);
              sendJson({ ok: true, action, line: __deps.renderWishLine(ws) ?? '（没有挂着的愿望）' });
            } else {
              sendJson({ ok: true, action, open: __deps.openWishItems(ws), line: __deps.renderWishLine(ws) ?? '（没有挂着的愿望）' });
            }
          } catch (error) {
            sendJson({ ok: false, error: `wish 操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [SELF-WAKE] 「叫我」：记一件 + 排一个到点叫醒（inMinutes=0 尽快；正在忙就顺延，不硬插）
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self-wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key || !String(body.wish ?? '').trim()) { sendJson({ ok: false, error: 'key 与 wish（到点要干的事）不能为空' }, 400); return; }
          const swTok = req.headers['x-agent-token'];
          // [SELF-WAKE-GROUP] 她可以在私聊里约自己「晚点去某个群看看」：主人 token + 允许的群 key。
          const selfWakeOwnerKey = 'private:' + String(__deps.cfg.ownerQQ ?? '');
          const ownerSchedulesGroup = !!swTok && agentTokenOk(selfWakeOwnerKey, swTok) && String(key).startsWith('group:');
          if (swTok && !agentTokenOk(key, swTok) && !ownerSchedulesGroup && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('selfWake')) { sendJson({ ok: false, error: '工具未启用：qq_self_wake' }, 403); return; }
          try {
            let ws = __deps.loadWishState();
            ws = __deps.recordWish(ws, { wish: String(body.wish), inMinutes: Number(body.inMinutes) || 0, key, source: 'self-wake' }, Date.now());
            __deps.saveWishState(ws);
            sendJson({ ok: true, scheduled: Number(body.inMinutes) || 0, line: __deps.renderWishLine(ws) ?? '（没有挂着的愿望）' });
          } catch (error) {
            sendJson({ ok: false, error: `self-wake 操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // [RHYTHM-HERS] 用户拍板（c）：她自己的自由时间节奏，她自己调（热生效，不用重启；系统只管上下界）
        if (req.method === 'POST' && url.pathname === '/api/socialV2/own-life-rhythm') {
          const body = await readBody();
          if (req.headers['x-agent-token'] && !agentTokenOk(__deps.ownerKey, req.headers['x-agent-token']) && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('ownLifeRhythm')) { sendJson({ ok: false, error: '工具未启用：qq_set_own_life_rhythm' }, 403); return; }
          const iv = Number(body.intervalMinutes);
          // 合并写：只改她这次给了的字段，没给的保留原值（原先整份覆盖，单独调节奏会把她自己的安静窗抹掉）
          let curRhythm = {};
          try { curRhythm = JSON.parse(__deps.fs.readFileSync(__deps.path.join(__deps.STATE_DIR, 'own-life-rhythm.json'), 'utf8')); } catch { curRhythm = {}; }
          const out = (curRhythm && typeof curRhythm === 'object' && !Array.isArray(curRhythm)) ? { ...curRhythm } : {};
          let changed = false;
          if (iv > 0) { out.intervalMs = Math.min(Math.max(iv, 30), 720) * 60000; changed = true; } // 上下界：30 分钟 ~ 12 小时
          if (Number.isFinite(Number(body.quietFrom)) && Number.isFinite(Number(body.quietTo))) {
            out.quiet = [Math.max(0, Math.min(24, Number(body.quietFrom))), Math.max(0, Math.min(24, Number(body.quietTo)))];
            changed = true;
          }
          if (!changed) { sendJson({ ok: false, error: '没有有效字段（intervalMinutes / quietFrom+quietTo）' }, 400); return; }
          __deps.writeJsonDocument(__deps.path.join(__deps.STATE_DIR, 'own-life-rhythm.json'), out, { source: 'bridge/own-life-rhythm' });
          __deps.log(`[own-life-rhythm] 她调了自己的节奏：${JSON.stringify(out)}`);
          sendJson({ ok: true, rhythm: out, note: '已生效（每 tick 热读，不用重启）；随时可以再调回去' });
          return;
        }
        // [WORKSHOP] 她的工坊：给自己写小工具/小游戏的空间。
        // 安全边界全部在模块内：工坊目录隔离 + vm 沙箱（无 require/网络/子进程）+ 独立 worker 真超时可打断。
        // ── [GROUP-ADMIN] 群管理动作：禁言/踢人/改名片/撤回（她自己的判断；私聊任务必做）──
        if (req.method === 'POST' && url.pathname === '/api/socialV2/group-admin') {
          const gb = await readBody().catch(() => ({}));
          const gkey = String(gb.key ?? '');
          const gact = String(gb.action ?? '');
          const gp = gb.params ?? {};
          const agentTok = String(req.headers['x-agent-token'] ?? '');
          const ownerTok = ownerPrivateTokenOk(agentTok);
          if (agentTok && !ownerTok && !agentTokenOk(gkey, agentTok)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentTok && !ownerTok) {
            sendJson({ ok: false, error: '群管理动作只允许主人私聊令牌（群会话 token 不能禁言/踢人/撤回）' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(gkey)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('groupAdmin')) { sendJson({ ok: false, error: '工具未启用：qq_group_*（群管理）' }, 403); return; }
          if (!/^group:\d+$/.test(gkey)) { sendJson({ ok: false, error: '群管理动作只用于群会话（group:群号）' }, 400); return; }
          const gid = Number(gkey.slice(6));
          const ACT = {
            setGroupBan: 'set_group_ban', setGroupKick: 'set_group_kick',
            setGroupCard: 'set_group_card', deleteMsg: 'delete_msg', setGroupWholeBan: 'set_group_whole_ban',
          };
          const obAction = ACT[gact];
          if (!obAction) { sendJson({ ok: false, error: `不支持的管理动作：${gact || '（空）'}` }, 400); return; }
          const params = { group_id: gid };
          try {
            if (gact === 'setGroupBan') {
              if (!/^\d+$/.test(String(gp.userId ?? ''))) { sendJson({ ok: false, error: 'userId 必须是 QQ 号' }, 400); return; }
              params.user_id = Number(gp.userId);
              params.duration = Math.max(0, Math.min(30 * 86400, Number(gp.durationSec) || 600));
            } else if (gact === 'setGroupKick') {
              if (!/^\d+$/.test(String(gp.userId ?? ''))) { sendJson({ ok: false, error: 'userId 必须是 QQ 号' }, 400); return; }
              params.user_id = Number(gp.userId);
              if (gp.rejectAdd) params.reject_add_request = true;
            } else if (gact === 'setGroupCard') {
              if (!/^\d+$/.test(String(gp.userId ?? ''))) { sendJson({ ok: false, error: 'userId 必须是 QQ 号' }, 400); return; }
              params.user_id = Number(gp.userId);
              params.card = String(gp.card ?? '').slice(0, 30);
            } else if (gact === 'deleteMsg') {
              const mid = Number(gp.messageId);
              if (!mid) { sendJson({ ok: false, error: 'messageId 必填（消息里的 messageId）' }, 400); return; }
              params.message_id = mid;
            } else if (gact === 'setGroupWholeBan') {
              params.enable = !!gp.enable;
            }
            const ghttp = String(__deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const gres = await fetch(`${ghttp}/${obAction}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(__deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${__deps.cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify(params),
              signal: AbortSignal.timeout(15000)
            });
            const gj = await gres.json().catch(() => ({}));
            if (!gres.ok || gj.status !== 'ok' || gj.retcode !== 0) {
              const hint = /admin|权限|permission/i.test(String(gj.wording ?? '')) || gres.status === 403
                ? '（这个动作需要小号本身是群管理员/群主）' : '';
              sendJson({ ok: false, error: `OneBot ${obAction} 失败: ${gj.wording || gj.retcode || gres.status}${hint}` }, 502);
              return;
            }
            try { __deps.appendActivity(`群管理 ${gkey} ${gact}: ${JSON.stringify(params)}`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:4683'); }
            __deps.log(`[group-admin] ${gkey} ${gact} ${JSON.stringify(params)}`);
            sendJson({ ok: true, action: gact, result: gj.data ?? null });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error).slice(0, 160) }, 502);
          }
          return;
        }
        // [IMAGEGEN] 生图：按需把 sd-server 拉起来出图（action=generate/status/stop）
        if (req.method === 'POST' && url.pathname === '/api/socialV2/image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const action = String(body.action ?? 'generate').trim() || 'generate';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!['generate', 'status', 'stop', 'send-file'].includes(action)) { sendJson({ ok: false, error: 'action 只能是 generate / status / stop / send-file' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('image')) { sendJson({ ok: false, error: '工具未启用：qq_image' }, 403); return; }
          try {
            if (action === 'status') {
              sendJson({ ok: true, action, ...(await __deps.imageStatusV2()) });
            } else if (action === 'stop') {
              sendJson({ ok: true, action, ...__deps.imageStopV2() });
            } else if (action === 'send-file') {
              // [SEND-FILE] 发本地图片/GIF：只允许项目媒体区、图库、工坊与 ~/Pictures（服务层再校验一次）。
              if (!__deps.sendImageFileV2) throw new Error('当前版本不支持发本地图片');
              const r = await __deps.sendImageFileV2(key, body.file, {
                replyToMessageId: body.replyToMessageId,
                atUserId: body.atUserId
              });
              try { __deps.recordSelfMediaMessage(key, '[图片]'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:send-file'); }
              sendJson({ ok: true, action, ...r });
            } else {
              const r = await __deps.imageForV2(key, {
                prompt: body.prompt,
                negative: body.negative,
                width: body.width,
                height: body.height,
                steps: body.steps,
                cfgScale: body.cfgScale ?? body.cfg_scale,
                seed: body.seed,
                send: body.send !== false,
                replyToMessageId: body.replyToMessageId,
                atUserId: body.atUserId
              });
              sendJson({ ok: true, action, ...r });
            }
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/workshop') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const action = String(body.action ?? '').trim();
          if (!key || !['run', 'save', 'read', 'list', 'delete'].includes(action)) { sendJson({ ok: false, error: 'key 与 action(run/save/read/list/delete) 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('workshop')) { sendJson({ ok: false, error: '工具未启用：qq_workshop' }, 403); return; }
          try {
            if (action === 'run') {
              const r = await __deps.workshopRun(String(body.code ?? ''), {});
              sendJson({ ok: true, action, ...r });
            } else if (action === 'save') {
              const r = __deps.writeWorkshop(String(body.path ?? ''), String(body.content ?? ''), !!body.append);
              sendJson({ ok: true, action, ...r });
            } else if (action === 'read') {
              const r = __deps.readWorkshop(String(body.path ?? ''));
              sendJson({ ok: true, action, ...r });
            } else if (action === 'delete') {
              const r = __deps.deleteWorkshop(String(body.path ?? ''));
              sendJson({ ok: true, action, ...r });
            } else {
              sendJson({ ok: true, action: 'list', files: __deps.listWorkshop() });
            }
          } catch (error) {
            sendJson({ ok: false, error: `工坊操作失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = __deps.redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? __deps.redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => __deps.redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) {
              const oldPq = st.activeTopics[idx].pendingQuestion;
              st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
              if (st.activeTopics[idx].pendingQuestion && st.activeTopics[idx].pendingQuestion !== oldPq) { st.activeTopics[idx].pendingSince = Date.now(); st.activeTopics[idx].pendingReminded = false; } // [THREAD] 时间轴
            }
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          __deps.saveSocialV2State();
          sendJson({ ok: true, key, category, memory: __deps.formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: __deps.formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        // ── [PERSON-MEMORY] 按 QQ 翻记忆：这个人在各群叫什么 + 记忆库里跟他有关的条目 ──
        // 记忆库的群摘要没有 userId，只有「昵称：内容」；这里用人物索引的跨群昵称去对。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-person') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const userId = String(url.searchParams.get('userId') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim().slice(0, 120);
          const limit = Math.min(12, Number(url.searchParams.get('limit')) || 8);
          if (!key || !userId) { sendJson({ ok: false, error: 'key 与 userId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          try {
            const aliases = __deps.personAliasesOf(userId);
            if (!aliases.length) { sendJson({ ok: false, error: `人物库里还没有 QQ ${userId} 的档案（等他先说过话，或先用 qq_person 记一条）` }, 404); return; }
            const memScope = key.startsWith('group:') ? key : 'private';
            const dir = __deps.cfg.socialV2?.memoryInject?.dir ? String(__deps.cfg.socialV2.memoryInject.dir) : undefined;
            const raw = await __deps.recall(query || aliases.slice(0, 3).join(' '), {
              scope: memScope,
              limit: Math.max(40, limit * 6),
              ...(dir ? { dir } : {}),
              ...(__deps.cfg.socialV2?.memoryInject?.shareGroup === false ? { shareGroup: false } : {}),
            });
            const hits = __deps.filterEntriesByPerson(raw?.entries || [], aliases);
            const person = __deps.personRecordOf(userId);
            sendJson({
              ok: true,
              userId,
              aliases,
              person: person ? {
                aliases: person.aliases || {},
                notes: (person.notes || []).slice(-5),
                impressions: (person.impressions || []).slice(-3).map((x) => x.text),
              } : null,
              count: hits.length,
              entries: hits.slice(-limit).map((e) => ({ time: e.time ?? '', kind: e.kind ?? '', who: e.who ?? '', text: String(e.text ?? '').slice(0, 220) })),
            });
          } catch (error) {
            sendJson({ ok: false, error: `按人翻记忆失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory-search') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim().slice(0, 120);
          const limit = Math.min(12, Number(url.searchParams.get('limit')) || 8);
          // [PROV] 按来源查（prov=video-watch = "我看过什么"式追问）；缺省不过滤，视频记忆也能被普通检索捞到
          const prov = String(url.searchParams.get('prov') ?? '').trim().slice(0, 40);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_search' }, 403); return; }
          // [MEM-SEARCH] 语义检索她的长期记忆库（默认含 _archive 归档；私聊时默认带群库共享）。
          // query 传空 = 只看最近的记忆。
          try {
            const memScope = key.startsWith('group:') ? key : 'private';
            const dir = __deps.cfg.socialV2?.memoryInject?.dir ? String(__deps.cfg.socialV2.memoryInject.dir) : undefined;
            const block = await __deps.recallBlock(query || null, {
              scope: memScope,
              limit,
              ...(prov ? { prov } : {}),
              ...(dir ? { dir } : {}),
              ...(__deps.cfg.socialV2?.memoryInject?.shareGroup === false ? { shareGroup: false } : {}),
            });
            // [COGNITION-SEARCH] 一次搜索同时翻「记忆」和「认知」：认知是结论层，记忆是情节层。
            let cogPart = null;
            try {
              const cg = __deps.cognition.load();
              const picked = query ? __deps.cognition.pickForQuery(cg, query, { maxInject: 3, minScore: 0.1 }) : cg.slice(-2);
              cogPart = { stats: __deps.cognition.stats(cg), items: picked.map((x) => ({ text: x.text, concept: x.concept, gist: x.gist, tags: x.tags || [], times: x.times || 1 })) };
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:4907'); }
            sendJson({ ok: true, key, query, mode: block.mode, count: block.count, text: block.text, steps: block.steps ?? null, cognition: cogPart });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const delText = st.memberImpressions[target];
            delete st.memberImpressions[target];
            // [PEOPLE] 持久层同步删（userId 解析到就删他；昵称兜底 key 也顺带清）
            try {
              const m = key.startsWith('group:') ? __deps.memberNickLookup(key, target) : null;
              if (m) __deps.peopleIndex.unnoteImpression(m.id, String(delText || target));
              __deps.peopleIndex.unnoteImpression(target, String(delText || target));
            } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:4941'); }
          }
          __deps.saveSocialV2State();
          sendJson({ ok: true, key, category, memory: __deps.formatMemoryV2(st) });
          return;
        }
        // ── [COGNITION] 认知条目（她提炼的判断）：POST 新增 / GET 查询 ──────────
        if (url.pathname === '/api/socialV2/cognition' && (req.method === 'POST' || req.method === 'GET')) {
          let key = '';
          let payload = {};
          if (req.method === 'POST') { payload = await readBody(); key = String(payload.key ?? '').trim(); }
          else key = String(url.searchParams.get('key') ?? '').trim();
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.method === 'GET') {
            const q = String(url.searchParams.get('query') ?? '').trim();
            const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 8));
            const items = __deps.cognition.load();
            const picked = q ? __deps.cognition.pickForQuery(items, q, { maxInject: limit, minScore: 0.1 }) : items.filter((x) => x && !x.invalidAt).slice(-limit);
            sendJson({ ok: true, stats: __deps.cognition.stats(items), items: picked });
            return;
          }
          const concept = String(payload.concept ?? '').trim();
          const gist = String(payload.gist ?? '').trim();
          const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
          const source = String(payload.source ?? 'she').trim() || 'she';
          const op = String(payload.op ?? 'add').trim() || 'add';
          // [COG-V2] op=confirm：她给一条认知打分（印证/推翻）；推翻累计 3 次自动失效。
          if (op === 'confirm' || op === 'vote') {
            const id = String(payload.id ?? '').trim();
            const dir = payload.dir === 'down' ? 'down' : 'up';
            const r = __deps.cognition.transact((items) => __deps.cognition.vote(items, id, dir));
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 400); return; }
            const e = r.entry;
            __deps.log(`[cognition] ${dir === 'down' ? '推翻' : '印证'}一条认知（${e.invalidAt ? '已失效' : `置信 ${Math.round(e.confidence * 100)}%`}）：${String(e.text || '').slice(0, 40)}`);
            sendJson({ ok: true, entry: e, stats: __deps.cognition.stats(r.items) });
            return;
          }
          // [COG-V2] op=supersede：她明确说这条不对了（不删，标失效）。
          if (op === 'supersede' || op === 'invalidate') {
            const id = String(payload.id ?? '').trim();
            const reason = String(payload.reason ?? 'superseded');
            const r = __deps.cognition.transact((items) => __deps.cognition.supersede(items, id, reason));
            if (!r.ok) { sendJson({ ok: false, error: r.error }, 400); return; }
            __deps.log(`[cognition] 标记失效：${String(r.entry?.text || '').slice(0, 40)}（${reason}）`);
            sendJson({ ok: true, entry: r.entry, stats: __deps.cognition.stats(r.items) });
            return;
          }
          const r = __deps.cognition.transact((items) => __deps.cognition.add(items, {
            concept,
            gist,
            kind: String(payload.kind ?? '').trim(),
            subject: String(payload.subject ?? '').trim(),
            when: String(payload.when ?? '').trim(),
            unless: String(payload.unless ?? '').trim(),
            evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
            tags,
            source,
            confidence: payload.confidence == null ? null : Number(payload.confidence),
            supersedes: String(payload.supersedes ?? '').trim(),
            requireWhen: true,
          }));
          if (!r.ok) { sendJson({ ok: false, error: r.error }, 400); return; }
          __deps.log(`[cognition] 记下一条认知（${r.updated ? '更新已有' : (r.replaced ? '替换旧条' : '新增')}）：${String(r.entry?.text || '').slice(0, 40)}`);
          sendJson({ ok: true, updated: !!r.updated, entry: r.entry, stats: __deps.cognition.stats(r.items) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = __deps.getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          __deps.saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: __deps.formatMemoryV2(st) });
          return;
                }

        // [PEOPLE] 全局人物档案库：note=往他的档案写一行（她学到的：年龄/性别/外号/性格/习惯，怎么写都行）
        //   get=查某人档案（他叫什么/在哪出现过/档案/印象/统计），forget=删她写的那一行。
        //   按 userId 归一：昵称解析不到就按昵称兜底存，人一旦有群档案就并进那个 userId。

        if (req.method === 'POST' && url.pathname === '/api/socialV2/person') {

          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const action = String(body.action ?? 'get').trim();
          const target = __deps.redactKnownTokensOnly(String(body.target ?? '').trim());
          const text = __deps.redactKnownTokensOnly(String(body.text ?? '').trim());
          if (!key || !target) { sendJson({ ok: false, error: 'key 与 target 必填（target=群友昵称或QQ号）' }, 400); return; }
          if (!['note', 'get', 'forget'].includes(action)) { sendJson({ ok: false, error: 'action 必须是 note/get/forget' }, 400); return; }
          if (action === 'note' && !text) { sendJson({ ok: false, error: 'note 需要 text（一行：你学到的关于他的事）' }, 400); return; }
          if (['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('person')) { sendJson({ ok: false, error: '工具未启用：qq_person' }, 403); return; }
          try {
            const m = key.startsWith('group:') ? __deps.memberNickLookup(key, target) : null;
            const pid = m ? m.id : target;
            if (action === 'note') {
              const p2 = __deps.peopleIndex.noteProfile(pid, { text, from: key });
              sendJson({ ok: true, action, target, resolved: m ? (m.name || m.id) : null, profile: p2?.profile ?? null });
            } else if (action === 'forget') {
              const n = __deps.peopleIndex.unnoteProfile(pid, text || '');
              sendJson({ ok: true, action, target, removed: n });
            } else {
              const p2 = __deps.peopleIndex.personOf(pid) || (m ? __deps.peopleIndex.personOf(m.id) : null);
              const st = __deps.getSocialV2State(key);
              sendJson({
                ok: true, action, target,
                known: !!(m || p2),
                resolved: m ? { name: m.name || m.id, id: m.id, count: m.count } : null,
                aliases: p2?.aliases ?? null,
                profile: p2?.profile ?? null,
                impressions: __deps.peopleIndex.impressionsOf(m ? m.id : pid),
                shortTermImpression: (st.memberImpressions && st.memberImpressions[target]) || null
              });
            }
          } catch (error) {
            sendJson({ ok: false, error: '人物档案操作失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = __deps.confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          // [LANG-UNIFY] 语言用法事件和 slang 共用一次查询。
          const langRows = readLanguageEpisodes(__deps.path.join(__deps.STATE_DIR, 'language-episodes.jsonl'), { limit: 300 })
            .filter((e) => !q || String(e.phrase || '').toLowerCase().includes(q)
              || String(e.meaning || '').toLowerCase().includes(q)
              || String(e.context || '').toLowerCase().includes(q))
            .slice(-10);
          sendJson({
            ok: true,
            key,
            total: list.length + langRows.length,
            entries: list,
            languageEpisodes: langRows,
            block: __deps.buildSlangContext(__deps.slangEntries, __deps.cfg.slang?.injectMax ?? 8)
              + (langRows.length ? `\n\n【语言用法】\n${langRows.map((e) => `- ${e.phrase}：${e.meaning || '意思不确定'}`).join('\n')}` : '')
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = __deps.redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = __deps.redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (__deps.cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!__deps.allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = __deps.slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === __deps.SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: __deps.publicSlangEntry(existing) });
              return;
            }
            if (existing.status === __deps.SLANG_STATUS.REJECTED) {
              // 拒绝可以来自控制台管理员或她自己的 qq_slang_judge（agentRejectedAt）；措辞不指认具体是谁。
              sendJson({ ok: false, error: existing.agentRejectedAt ? '这个词你自己放下了，就不提它了' : '该词已被拒绝收录，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = __deps.mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            __deps.saveSlangStore();
            if (__deps.cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(__deps.cfg.slang?.inferenceThresholds) ? __deps.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                __deps.queueSlangTask(() => __deps.runSlangResearch([existing]));
              }
            }
            __deps.log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: __deps.publicSlangEntry(existing) });
            return;
          }
          const entry = __deps.createSlangEntry({
            content,
            source: 'ai',
            status: __deps.SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          __deps.slangEntries.push(entry);
          __deps.saveSlangStore();
          if (__deps.cfg.slang?.autoResearch !== false) {
            __deps.queueSlangTask(() => __deps.runSlangResearch([entry]));
          }
          __deps.log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          __deps.appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: __deps.publicSlangEntry(entry) });
          return;
        }
        // ── 二代黑话判定（reserved2）：她自己思考后确认/否决，harness 不替她做决定 ──
        // 研究（机器）负责把含义查出来；点头（她）负责决定学不学。控制台保留覆盖权。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/judge') {
          const body = await readBody();
          const key = String(body.key ?? '').trim() || 'self'; // [SELF-STATE] 隔离会话没有会话 key，按「她自己」处理
          const action = String(body.action ?? 'list');
          const content = __deps.redactKnownTokensOnly(String(body.content ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token']) && !selfStateTokenOk(req)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && key !== 'self' && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !__deps.v2ToolEnabled('slangJudge')) { sendJson({ ok: false, error: '工具未启用：qq_slang_judge' }, 403); return; }
          if (__deps.cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (action === 'list') {
            const pending = __deps.pendingJudgeList(__deps.slangEntries, __deps.cfg.slang?.judgeListMax ?? 8);
            sendJson({ ok: true, key, action, pending, line: __deps.renderSlangJudgeLine(__deps.slangEntries, __deps.cfg.slang?.judgeListMax ?? 8) ?? '（没有等你想的词）' });
            return;
          }
          if (action !== 'confirm' && action !== 'reject') { sendJson({ ok: false, error: 'action 必须是 list/confirm/reject' }, 400); return; }
          const res = __deps.judgeSlangEntry(__deps.slangEntries, content, action);
          if (res.error) { sendJson({ ok: false, error: res.error }, 400); return; }
          __deps.slangEntries = res.entries;
          __deps.saveSlangStore();
          __deps.log(`[slang-judge] 她${action === 'confirm' ? '确认' : '放下'}黑话「${content}」（来自 ${key}）`);
          __deps.appendActivity(`${key} [reserved2] 黑话判定：她${action === 'confirm' ? '确认学习' : '放下'}「${content}」`);
          sendJson({ ok: true, key, action, entry: __deps.publicSlangEntry(res.entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (__deps.currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (__deps.currentMode === 'chat' || __deps.currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !__deps.v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && __deps.currentMode === 'closed-agent' && !__deps.v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = __deps.findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await __deps.fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            __deps.log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = __deps.unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (__deps.currentMode === 'chat' || __deps.currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (__deps.socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (__deps.currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          let crossCaller = null;
          if (token && !agentTokenOk(key, token)) {
            crossCaller = callerKeyForToken(token);
            if (!crossCaller) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            // [CROSS-SEND-OWNER] 群/别人的会话令牌不能给主人私聊发消息：
            // 群内容一句“去私聊主人说……”就能借她的身份做社工。场景发送早已是 owner-only，
            // 这条路径必须同一口径。跨到其它群仍允许（她主动找群里的人），但会留 [cross-send]。
            const ownerKey = `private:${String(__deps.cfg.ownerQQ ?? '')}`;
            if (key === ownerKey && !callerTokenIsOwner(token)) {
              sendJson({ ok: false, error: '只有主人私聊会话能向主人发消息；群/任务会话不能代发' }, 403);
              return;
            }
            __deps.log(`[cross-send] ${crossCaller} → ${key}（用调用方令牌认证）`);
          }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !__deps.v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (__deps.shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !__deps.modeAllowed(key, kind, id, __deps.cfg, __deps.currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = __deps.getSocialV2State(key);
            const resolved = await __deps.resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = __deps.cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          const bounds = validateMessageBounds([message], { maxMsgs: 1, maxChars, sensitiveRe: __deps.SENSITIVE_RE });
          if (!bounds.ok) { sendJson({ ok: false, error: bounds.error }, bounds.status); return; }
          // [SEND-ERROR-SCOPE] st/now 必须在 try 外：catch 回滚发送额度也要用。
          // 旧写法把它们 const 在 try 内，catch 只能取不存在的 __deps.st/__deps.now，
          // 失败路径抛 ReferenceError，额度不回滚、接口还报 "st is not defined"。
          const st = __deps.getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const rate = checkSendRate(st, now, { maxPerMinute, maxPerHour }, 1);
            if (!rate.ok) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            reserveSendTimes(st, now, 1);
            const sentMessages = await __deps.sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            __deps.recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.silentStreak = 0; // [SILENT-GUARD] 她开口了：连续缺席清零
            st.silentReminders = 0; // 提醒计数一并清（开口=护栏完成使命）
            __deps.saveSocialV2State();
            __deps.log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            __deps.appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) __deps.scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              __deps.recordSentMessagesV2(key, error.sent);
              __deps.log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            rollbackSendTimes(st, now, failedCount);
            __deps.saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        // [SESSION-FRESH] 只换 DSH 会话、不动她的对话状态（消息/令牌/社交状态都留着）。
        // 用途：会话的权限投影（sandbox/approval）在创建时钉死，改默认只影响新会话；
        // 想让已有的她会话拿到新权限，就换一个新会话——代价是 DSH 侧的对话转录从头开始，
        // 记忆/经验/日记/当日摘要都还在。
        if (req.method === 'POST' && url.pathname === '/api/session/fresh') {
          const body = await readBody();
          const keys = Array.isArray(body.keys) ? body.keys.map(String) : [String(body.key ?? '')];
          const done = [];
          for (const key of keys) {
            if (!key) continue;
            const oldSessionId = __deps.state.sessions[key];
            if (!oldSessionId) { done.push({ key, skipped: '没有会话' }); continue; }
            __deps.sessionEpoch++;
            delete __deps.state.sessions[key];
            __deps.modelAppliedSessions.delete(oldSessionId);
            __deps.reverse.delete(oldSessionId);
            __deps.collectors.delete(oldSessionId);
            __deps.sendToolSucceededSessions.delete(oldSessionId);
            __deps.pendingSendToolCalls.delete(oldSessionId);
            __deps.v2TurnStartAt.delete(oldSessionId);
            __deps.toolCallNames.delete(oldSessionId);
            __deps.social.silentTurns.delete(oldSessionId);
            __deps.social.exitingSessions.delete(oldSessionId);
            __deps.sessionPromises.delete(key);
            __deps.drainPromptQueue(key, '会话已换新（权限模型变化）');
            try { await __deps.api.stopSessionWork(oldSessionId); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5392'); }
            try { await __deps.api.workspace.archiveSession({ sessionId: oldSessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5393'); }
            __deps.saveState();
            __deps.log(`[session-fresh] ${key} 换新会话（旧 ${String(oldSessionId).slice(0, 8)} 已归档；社交状态保留）`);
            done.push({ key, archived: oldSessionId });
          }
          sendJson({ ok: true, done });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !__deps.state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          __deps.sessionEpoch++;
          const oldSessionId = __deps.state.sessions[key];
          delete __deps.state.sessions[key];
          __deps.modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete __deps.state.sessionPolicies[key];
          __deps.reverse.delete(oldSessionId);
          __deps.collectors.delete(oldSessionId);
          __deps.sendToolSucceededSessions.delete(oldSessionId);
          __deps.pendingSendToolCalls.delete(oldSessionId);
          __deps.v2TurnStartAt.delete(oldSessionId);
          __deps.toolCallNames.delete(oldSessionId);
          const pe = __deps.pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            __deps.cancelPendingEntry(pe).catch((e) => globalThis.__ignoredCatch?.(e, 'src/adapters/console-server.mjs:5562'));
          }
          __deps.pending.delete(key);
          __deps.queued.delete(key);
          __deps.queuedHintAt.delete(key);
          __deps.sessionPromises.delete(key);
          __deps.drainPromptQueue(key, '会话已重置');
          __deps.social.recentMessages.delete(key);
          __deps.messageMediaStore.delete(key);
          __deps.social.pendingSummaries.delete(key);
          __deps.social.states.delete(key);
          __deps.social.silentContext.delete(key);
          __deps.social.silentTurns.delete(oldSessionId);
          __deps.social.exitingSessions.delete(oldSessionId);
          __deps.slangWindows.delete(key);
          __deps.slangExtractionCooldowns.delete(key);
          __deps.slangSubmitTimes.delete(key);
          __deps.cancelSocialTimers(key);
          __deps.clearSocialV2Timers(key);
          __deps.pendingWakeKeys.delete(key);
          __deps.wakeConfigUpdatedKeys.delete(key);
          __deps.markReadCalledKeys.delete(key);
          __deps.wakeConfigMissCount.delete(key);
          __deps.forgetAgentToken(key);
          __deps.socialV2.conversations.delete(key);
          __deps.seenForwardIds.delete(key);
          __deps.saveSocialV2State();
          __deps.saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await __deps.api.stopSessionWork(oldSessionId); }
          catch (error) { __deps.log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await __deps.api.workspace.archiveSession({ sessionId: oldSessionId }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5451'); }
          __deps.log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          __deps.sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = __deps.unwrap(await __deps.api.sessions.list({}), 'session.list');
            const stateDir = __deps.path.resolve(__deps.STATE_DIR);
            const statePrefix = __deps.path.normalize(stateDir + __deps.path.sep);
            const normPath = (p) => __deps.path.normalize(String(p ?? '').replace(/\//g, __deps.path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await __deps.api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { __deps.log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await __deps.api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5477'); }
              }
            }
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5480'); }
          for (const entry of __deps.pending.values()) {
            clearTimeout(entry.timer);
            __deps.cancelPendingEntry(entry).catch((e) => globalThis.__ignoredCatch?.(e, 'src/adapters/console-server.mjs:5625'));
          }
          __deps.pending.clear();
          __deps.queued.clear();
          __deps.queuedHintAt.clear();
          __deps.sessionPromises.clear();
          __deps.drainAllPromptQueues('工作区已清空');
          __deps.social.states.clear();
          __deps.social.recentMessages.clear();
          __deps.messageMediaStore.clear();
          __deps.seenForwardIds.clear();
          __deps.social.pendingSummaries.clear();
          __deps.social.silentContext.clear();
          __deps.social.silentTurns.clear();
          __deps.social.exitingSessions.clear();
          __deps.slangWindows.clear();
          __deps.slangExtractionCooldowns.clear();
          __deps.slangSubmitTimes.clear();
          __deps.cancelAllSocialTimers();
          __deps.clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          __deps.socialV2.conversations.clear();
          __deps.CONVERSATION_TOKENS.clear();
          __deps.KNOWN_AGENT_TOKENS.clear();
          __deps.saveSocialV2State();
          __deps.state.sessions = {};
          __deps.state.sessionPolicies = {};
          __deps.reverse.clear();
          __deps.collectors.clear();
          __deps.sendToolSucceededSessions.clear();
          __deps.pendingSendToolCalls.clear();
          __deps.v2TurnStartAt.clear();
          __deps.busySinceMs.clear();
          __deps.toolCallNames.clear();
          __deps.saveState();
          try { __deps.fs.writeFileSync(__deps.ACTIVITY_LOG, ''); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5518'); }
          __deps.log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        // [RESTART-GATE] 不再 500ms 后无条件退出：先把在途回合放完再重启。
        // 之前每改一次代码就重启一次，正在说的那句被拦腰砍断 → 同一条消息回两遍、前后话对不上。
        if (url.pathname === '/api/restart' && (req.method === 'POST' || req.method === 'GET')) {
          // [RESTART-GATE] GET 只读：看一眼闸门现在判断忙不忙，什么都不动。
          if (req.method === 'GET') { sendJson({ ok: true, busy: __deps.anyTurnBusyProbe(), waitMs: 120000 }); return; }
          let rbody = {};
          try { rbody = await readBody(); } catch { rbody = {}; }
          const force = rbody?.force === true;
          const waitMs = Number.isFinite(Number(rbody?.waitMs)) ? Math.max(0, Math.min(180000, Number(rbody.waitMs))) : 120000;
          // [RESTART-COOLDOWN] 60s 内重复请求忽略。状态落盘到 state/last-restart.json，
          // 因为「接受一次重启 = 这个进程马上退出」，只放内存等于每次重置冷却。
          // force:true 绕过（--force 的语义就是「我知道我在干什么」）。
          const nowRestart = Date.now();
          const cooldownFile = __deps.path.join(__deps.STATE_DIR, 'last-restart.json');
          let lastRestart = 0;
          try { lastRestart = Number(__deps.readJsonSafe(cooldownFile, {})?.at) || 0; } catch { lastRestart = 0; }
          if (!force && lastRestart && nowRestart - lastRestart < 60_000) {
            const ago = Math.round((nowRestart - lastRestart) / 1000);
            try { __deps.log(`[restart] 60 秒内重复请求，忽略（ua=${String(req.headers['user-agent'] ?? '-').slice(0, 70)}，距上次 ${ago}s）`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5542'); }
            sendJson({ ok: true, throttled: true, message: `60 秒内已经重启过（距上次 ${ago}s），本次忽略；要强制重启请在 body 里带 force:true` });
            return;
          }
          try { __deps.atomicWriteJson(cooldownFile, { at: nowRestart, ua: String(req.headers['user-agent'] ?? '').slice(0, 80) }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5546'); }
          const busy = __deps.anyTurnBusyProbe();
          // [RESTART-TRACE] 2026-10-29：00:01–00:33 桥接被重启 6 次，日志里只有「重启（立即）」，
          // 看不出是谁在按。记一行来源（UA / Origin / 令牌有无），下次能定位是控制台、脚本还是她自己的回合。
          try {
            __deps.log(`[restart] ${req.method} 来源 ua=${String(req.headers['user-agent'] ?? '-').slice(0, 70)} origin=${String(req.headers.origin ?? '-')} token=${suppliedToken ? '有' : '无'} force=${force} waitMs=${waitMs}`);
          } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'console-server.mjs:5552'); }
          sendJson({
            ok: true,
            busy,
            gate: force ? 'force' : 'wait',
            waitMs,
            message: force
              ? '强制重启：不等待在途回合'
              : (busy ? `有回合在跑，等最多 ${Math.round(waitMs / 1000)}s 到空闲再重启` : '当前空闲，立刻重启'),
          });
          setTimeout(async () => {
            const t0 = Date.now();
            let tick = 0;
            while (!force && __deps.anyTurnBusyProbe() && Date.now() - t0 < waitMs) {
              if (tick % 15 === 0) __deps.log(`[restart-gate] 还有回合在跑，已等 ${Math.round((Date.now() - t0) / 1000)}s（上限 ${Math.round(waitMs / 1000)}s）`);
              await __deps.sleep(1000);
              tick += 1;
            }
            const waited = Date.now() - t0;
            const stillBusy = __deps.anyTurnBusyProbe();
            __deps.log(`[restart-gate] 重启桥接（${force ? '强制' : stillBusy ? '等满仍有回合，强制' : waited ? `等 ${Math.round(waited / 1000)}s 到空闲` : '立即'}）`);
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { __deps.saveState(); } catch (error) { __deps.log('重启前保存会话映射失败:', error?.message ?? error); }
            try { __deps.saveSocialV2State(); } catch (error) { __deps.log('重启前保存二代会话状态失败:', error?.message ?? error); }
            __deps.releaseLock();
            process.exit(0);
          // [RESTART-EXIT-DELAY] 2000ms 而不是 500ms：先让 200 响应彻底送达再退，
          // 否则客户端会看到 fetch failed，误判「没重启」（2026-10-30 事故）。
          }, 2000);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      __deps.log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      __deps.log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    // [EMBED-WATCHDOG] 嵌入服务 8790（llama-server + bge-m3）没有任务守护：机器重启就死，
    // 记忆检索会静默退回字面模式。桥接启动时检查，死了就自动拉起（脱离进程），轮询到就绪为止。
    (async () => {
      try {
        // [EMBED-OFF] 16GB 机器/低内存模式：允许显式关闭自动拉起，记忆检索退回字面模式。
        if (String(process.env.QQ_INORI_EMBED_DISABLED ?? '') === '1') {
          __deps.log('[embed] QQ_INORI_EMBED_DISABLED=1，跳过自动拉起（记忆检索退回字面模式）');
          return;
        }
        const alive = async () => {
          // fetch 连不上会 throw（ECONNREFUSED/超时），以前这里没 catch，
          // 服务真挂了的时候 alive() 直接把 watchdog 整个异常抛出 → 该拉的时候反而拉不起来。
          try {
            const r = await fetch('http://127.0.0.1:8790/health', { signal: AbortSignal.timeout(1500) });
            return r.ok;
          } catch { return false; }
        };
        if (await alive()) { __deps.log('[embed] 嵌入服务 8790 在线'); return; }
        // [EMBED-GUARD] 先等 30s：启动脚本（9-启动嵌入服务.bat）可能刚拉起一个正在载模的实例，
        // 以前这里立刻 spawn 跟它抢同一个端口，输的那个不退，白占约 0.95 GB。
        for (let i = 0; i < 10 && !(await alive()); i++) await new Promise((r) => setTimeout(r, 3000));
        if (await alive()) { __deps.log('[embed] 嵌入服务 8790 在线（启动脚本拉起的实例已就绪）'); return; }
        if (!__deps.claimEmbedSpawn()) { __deps.log('[embed] 90 秒内已有人拉过，本次不重复拉起'); return; }
        __deps.log('[embed] 嵌入服务不在线，自动拉起 llama-server（bge-m3）');
        const { spawn } = await import('node:child_process');
        __deps.fs.mkdirSync(__deps.LOG_DIR, { recursive: true });
        const out = __deps.fs.openSync('logs/embed-server.log', 'a');
        // 本地 embedding 路径不再写死作者机器：配置（gate.embedExe/embedModel）→ 环境变量（INORI_EMBED_EXE/INORI_EMBED_MODEL）→ 空。
        // 为空时跳过自动拉起，记忆检索退回字面模式，而非尝试作者路径。
        const embedExe = String(__deps.cfg?.gate?.embedExe || process.env.INORI_EMBED_EXE || '');
        const embedModel = String(__deps.cfg?.gate?.embedModel || process.env.INORI_EMBED_MODEL || '');
        if (!embedExe || !embedModel) {
          __deps.log('[embed] 未配置本地 embedding 路径（config.gate.embedExe/embedModel 或 INORI_EMBED_EXE/INORI_EMBED_MODEL），跳过自动拉起（记忆检索退回字面模式）');
          return;
        }
        const child = spawn(
          embedExe,
          [
            '-m', embedModel,
            '--embedding', '--pooling', 'cls',
            '--host', '127.0.0.1', '--port', String(Number(__deps.cfg?.gate?.embedPort) || 8790),
            // [EMBED-MEM] 与 runtime-gate 同口径：默认 8192/2048，可在 config.gate 降 context 省内存。
            '-c', String(Math.max(512, Number(__deps.cfg?.gate?.embedCtx) || 8192)),
            '-ub', String(Math.max(128, Number(__deps.cfg?.gate?.embedUb) || 2048)),
            '-ngl', '99', '--no-webui',
          ],
          { detached: true, stdio: ['ignore', out, out], windowsHide: true },
        );
        child.unref();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          if (await alive()) { __deps.log(`[embed] 嵌入服务已就绪（约 ${(i + 1) * 3}s）`); return; }
        }
        __deps.log('[embed] 嵌入服务 90s 未就绪，记忆检索暂退字面模式（不阻塞桥接）');
      } catch (error) {
        __deps.log(`[embed] 服务检查/拉起失败（忽略）: ${error?.message ?? error}`);
      }
    })();
    // [RERANK-ONDEMAND] 交叉重排 8792 不再常驻、也不再每 60s 保活——空转时白占约 4 GB 提交内存。
    // 触发点改到记忆注入前（见下方 [RERANK-ONDEMAND] 调用）：真要重排时才 ensure()，
    // 不在线就 detached 拉起；服务端空闲 RERANK_IDLE_EXIT 秒（默认 900）后自己退出。
    // 实现见 src/rerank-on-demand.js。

    // [MEM-ARCHIVE] 记忆库归档（淡出的后半段）：>90 天的条目移进 _archive/，仍可通过
    // searchArchive 检索到，不删除。启动时跑一次（幂等：已在归档的不重复搬）。
    try {
      // [MEM-MAINT] 启动跑一次完整流水线：压缩 → fact 上限 → 归档（顺序固定，不再两套规则抢文件）
      try { __deps.compactGroupMemories(); } catch (error) { __deps.log(`[mem-maint] 启动维护失败（忽略）: ${error?.message ?? error}`); }
    } catch (error) {
      __deps.log(`[mem-archive] 归档失败（忽略）: ${error?.message ?? error}`);
    }
    return server;
  
}
