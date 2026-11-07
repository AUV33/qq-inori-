// [SPLIT 阶段1/2/3] console-server.mjs 拆分后的行为锁。
//
// 覆盖四个新模块，并锁住一条曾经真实发生过的**安全回归**：
// router 分发点若放在鉴权之前，迁移出的路由会变成免鉴权（无令牌 200）。
// 因此这里的 HTTP 测试对每个已迁出路由都断言「无令牌必须 401」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createConsoleAuth } from '../src/adapters/console-auth.mjs';
import { SECURITY_HEADERS, cspForHtml, headersForHtml, createSendJson, readBody } from '../src/adapters/console-http-utils.mjs';
import { createConsoleRouter } from '../src/adapters/console-router.mjs';
import { readOnlyRoutes } from '../src/adapters/console-routes/read-only.mjs';
import { roleRoutes } from '../src/adapters/console-routes/roles.mjs';
import { workRoutes } from '../src/adapters/console-routes/works.mjs';
import { tokenRoutes } from '../src/adapters/console-routes/tokens.mjs';
import { startConsoleServerCore } from '../src/adapters/console-server.mjs';

// ── 阶段1：鉴权函数组 ─────────────────────────────────────────────────────
function makeAuthDeps(conversations = new Map()) {
  return {
    crypto,
    canonicalV2Key: (k) => k,
    cfg: { ownerQQ: '10001' },
    socialV2: { conversations },
  };
}

test('createConsoleAuth: tokenEq 用定长比较且拒绝空/非字符串/长度不等', () => {
  const { tokenEq } = createConsoleAuth(makeAuthDeps());
  assert.equal(tokenEq('same-value-1234', 'same-value-1234'), true);
  assert.equal(tokenEq('a', 'b'), false);
  assert.equal(tokenEq('', ''), false, '空令牌必须失败关闭');
  assert.equal(tokenEq(null, 'x'), false);
  assert.equal(tokenEq(123, 123), false);
  assert.equal(tokenEq('short', 'much-longer-value'), false);
});

test('createConsoleAuth: agentTokenOk / isLiveAgentToken / isReadToken / selfStateTokenOk', () => {
  const HER = 'her-live-token-0123456789abcd';
  const READ = 'her-read-token-0123456789abcd';
  const conversations = new Map([
    ['private:10001', { agentToken: HER, readToken: READ }],
    ['group:777', { agentToken: 'grp-token-0123456789abcd' }],
  ]);
  const a = createConsoleAuth(makeAuthDeps(conversations));

  assert.equal(a.agentTokenOk('private:10001', HER), true);
  assert.equal(a.agentTokenOk('private:10001', READ), false, '只读 token 不能当 agentToken 用');
  assert.equal(a.agentTokenOk('group:999', HER), false, '不存在的会话拒绝');
  assert.equal(a.isLiveAgentToken(HER), true);
  assert.equal(a.isLiveAgentToken(READ), false);
  assert.equal(a.isReadToken(READ), true);
  assert.equal(a.isReadToken('bogus'), false);
  assert.equal(a.selfStateTokenOk({ headers: { 'x-agent-token': READ } }), true);
  assert.equal(a.selfStateTokenOk({ headers: {} }), false);
});

test('createConsoleAuth: callerKeyForToken 认调用方；owner 判定只认 owner lane', () => {
  const OWNER_AGENT = 'owner-agent-0123456789abcd';
  const GRP = 'grp-token-0123456789abcd';
  const conversations = new Map([
    ['private:10001', { ownerAgentToken: OWNER_AGENT }],
    ['group:777', { agentToken: GRP }],
  ]);
  const a = createConsoleAuth(makeAuthDeps(conversations));
  assert.equal(a.callerKeyForToken(GRP), 'group:777');
  assert.equal(a.callerKeyForToken(OWNER_AGENT), 'private:10001');
  assert.equal(a.callerKeyForToken('nope'), null);
  assert.equal(a.callerTokenIsOwner(OWNER_AGENT), true);
  assert.equal(a.callerTokenIsOwner(GRP), false, '群会话 token 不是主人');
  assert.equal(a.ownerPrivateTokenOk(OWNER_AGENT), true);
  assert.equal(a.ownerPrivateTokenOk(GRP), false, '群管理动作不认群 token');
});

// ── 阶段1：HTTP 工具 ──────────────────────────────────────────────────────
test('SECURITY_HEADERS / createSendJson: 安全头齐全、状态码与 JSON 正确', () => {
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /default-src 'self'/);
  assert.equal(SECURITY_HEADERS['Cache-Control'], 'no-store');
  assert.equal(Object.isFrozen(SECURITY_HEADERS), true);

  let written = null;
  let ended = null;
  const res = { writeHead: (s, h) => { written = { s, h }; }, end: (b) => { ended = b; } };
  createSendJson(res)({ ok: true }, 201);
  assert.equal(written.s, 201);
  assert.equal(written.h['X-Frame-Options'], 'DENY');
  assert.equal(written.h['content-type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(ended).ok, true);
  createSendJson(res)({ a: 1 });
  assert.equal(written.s, 200, '默认状态码 200');
});

test('readBody: 合法 JSON 对象 / 空体 {} / 非 JSON 400 / content-length 超限 413', async () => {
  function mockReq({ headers = {}, chunks = [], declared } = {}) {
    const req = new EventEmitter();
    req.headers = { ...headers };
    if (declared !== undefined) req.headers['content-length'] = String(declared);
    req.pause = () => {};
    queueMicrotask(() => {
      for (const c of chunks) req.emit('data', Buffer.from(c));
      req.emit('end');
    });
    return req;
  }

  assert.deepEqual(await readBody(mockReq({ chunks: ['{"a":1}'] })), { a: 1 });
  assert.deepEqual(await readBody(mockReq({ chunks: ['   '] })), {});
  await assert.rejects(readBody(mockReq({ chunks: ['not-json'] })), (e) => e.statusCode === 400);
  await assert.rejects(readBody(mockReq({ chunks: ['[1,2]'] })), (e) => e.statusCode === 400, '数组不是对象');
  await assert.rejects(readBody(mockReq({ declared: 2_000_000 })), (e) => e.statusCode === 413);
});

// ── [L3] CSP：内联脚本按内容 hash 白名单，script-src 不再放开 unsafe-inline ──
test('CSP: 基础 CSP 与 HTML 响应头策略正确', () => {
  const base = SECURITY_HEADERS['Content-Security-Policy'];
  assert.doesNotMatch(base, /script-src[^;]*unsafe-inline/, 'script-src 不得含 unsafe-inline');
  assert.match(base, /style-src[^;]*unsafe-inline/, 'style-src 仍需 inline 样式');
  assert.doesNotMatch(cspForHtml('<p>no script</p>'), /sha256-/);
  assert.equal(cspForHtml('<script></script>'), base, '空脚本不产生白名单');
  assert.equal((cspForHtml('<script>const a=1</script><script>const a=1</script>').match(/sha256-/g) ?? []).length, 1, '相同脚本去重');
});

test('CSP: 只放行页面里真实存在的内联脚本，注入的新脚本没有 hash', () => {
  const body = 'const a = 1;';
  const inline = `<!doctype html><script>${body}</script><script src="/app.js"></script>`;
  const expected = `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;
  const csp = cspForHtml(inline);
  assert.ok(csp.includes(expected), '内联脚本必须按确切内容放行');
  assert.equal((csp.match(/sha256-/g) ?? []).length, 1, '外链脚本不产生 hash');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  const injected = `'sha256-${crypto.createHash('sha256').update('evil()', 'utf8').digest('base64')}'`;
  assert.ok(!csp.includes(injected), '页面里不存在的内联脚本不得被放行');

  const headers = headersForHtml(inline);
  assert.equal(headers['Content-Security-Policy'], csp);
  assert.equal(headers['X-Frame-Options'], SECURITY_HEADERS['X-Frame-Options']);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('CSP: 真实 console.html 的每段内联脚本都被 hash 白名单覆盖', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).filter((s) => s && s.trim());
  assert.ok(scripts.length >= 2, '控制台确有内联脚本，hash 方案必须覆盖它们');
  const csp = cspForHtml(html);
  for (const s of scripts) {
    const hash = `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
    assert.ok(csp.includes(hash), '每段内联脚本都必须有对应 hash（动态计算不得漏）');
  }
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

// ── 阶段3：路由器 ─────────────────────────────────────────────────────────
test('createConsoleRouter: method+path 精确匹配、大小写归一、重复注册 fail fast', () => {
  const getA = () => 'get';
  const postA = () => 'post';
  const r = createConsoleRouter([
    [{ method: 'GET', path: '/x', handle: getA }, { method: 'post', path: '/x', handle: postA }],
  ]);
  assert.equal(r.size, 2);
  assert.equal(r.match('GET', '/x'), getA);
  assert.equal(r.match('POST', '/x'), postA);
  assert.equal(r.match('get', '/x'), getA, 'method 大小写归一');
  assert.equal(r.match('GET', '/x/'), null, '精确匹配，不模糊');
  assert.equal(r.match('DELETE', '/x'), null);
  assert.deepEqual(new Set(r.keys()), new Set(['GET /x', 'POST /x']));

  assert.throws(() => createConsoleRouter([
    [{ method: 'GET', path: '/dup', handle: getA }, { method: 'GET', path: '/dup', handle: postA }],
  ]), /重复注册/, '静默覆盖会造成幽灵 bug，必须拒绝');
  assert.throws(() => createConsoleRouter([[{ method: 'GET', path: '/bad' }]]), /必须有/);
});

// ── 阶段2：路由模块导出契约 ────────────────────────────────────────────────
test('readOnlyRoutes: 四条只读路由契约完整，且可被 router 装配', () => {
  const paths = readOnlyRoutes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(paths, [
    'GET /api/state/overview',
    'GET /api/presets',
    'GET /api/console/metrics',
    'GET /api/console/quality-trends',
  ]);
  for (const r of readOnlyRoutes) assert.equal(typeof r.handle, 'function');
  const router = createConsoleRouter([readOnlyRoutes]);
  assert.equal(router.size, 4);
  for (const p of readOnlyRoutes) assert.equal(typeof router.match(p.method, p.path), 'function');
});

// ── 第二批：路由组导出契约 ─────────────────────────────────────────────────
test('roleRoutes / workRoutes / tokenRoutes: 导出契约完整，且可被 router 装配为 23 个路由', () => {
  assert.equal(roleRoutes.length, 9);
  assert.equal(workRoutes.length, 5);
  assert.equal(tokenRoutes.length, 5);
  for (const r of [...roleRoutes, ...workRoutes, ...tokenRoutes]) {
    assert.equal(typeof r.method, 'string');
    assert.equal(typeof r.path, 'string');
    assert.equal(typeof r.handle, 'function');
  }
  const router = createConsoleRouter([readOnlyRoutes, roleRoutes, workRoutes, tokenRoutes]);
  assert.equal(router.size, 23);
  for (const r of [...roleRoutes, ...workRoutes, ...tokenRoutes]) assert.equal(typeof router.match(r.method, r.path), 'function');
  // 重复路径 / 方法必须被 router 拒绝（安全：防止 router 静默覆盖）
  assert.throws(() => createConsoleRouter([readOnlyRoutes, readOnlyRoutes]), /重复注册/);
});

// ── 端到端：真实 HTTP，锁住鉴权不被 router 绕过 ────────────────────────────
const TOKEN = 'test-token-0123456789abcdef';
const ROLE = 'r1';
const AGENT_TOKEN = 'agent-live-token-0123456789';
let baseDeps = null;

function makeDeps() {
  const base = {
    cfg: { consolePort: 0, consoleToken: TOKEN, ownerQQ: '10001', socialV2: {} },
    crypto, http,
    fs: { readFileSync: () => '', readdirSync: () => [], mkdirSync() {}, openSync: () => 3,
          existsSync: () => true, renameSync() {}, rmSync() {} },
    path: { join: (...p) => p.join('/') },
    LOG_DIR: '/tmp/logs', ROOT: process.cwd(), STATE_DIR: '/tmp/state', MEM_DIR: '/tmp/mem',
    log: () => {}, loadOrCreateConsoleToken: () => TOKEN, wasConsoleTokenCreatedOnLoad: () => false,
    canonicalV2Key: (k) => k, socialV2: { paused: false, conversations: new Map([['private:10001', { agentToken: AGENT_TOKEN }]]) },
    isSessionAllowedInCurrentMode: () => true, readRoleState: () => ({}),
    claimEmbedSpawn: () => false, compactGroupMemories: () => {},
    // /api/status（legacy ladder）需要的只读桩，用来证明 legacy 路由仍完整服务
    currentMode: 'reserved2', dshReady: true, closedAgentPreset: '',
    oneBotHealth: () => ({ ok: true }), readActivityTail: () => [],
    unwrap: (v) => v,
    api: { agentPresets: { list: async () => ({ presets: [{ id: 'p1', trust: 'system' }] }) } },
    computeMetrics: () => ({ latencyMs: 7 }),
    buildTrends: () => ({ memory: [] }), TREND_SOURCES: ['memory'],
    stateDataPath: (s) => `/tmp/state/${s ?? ''}`,
    // 人格（角色）路由桩
    ROLE_NAME_MAX: 32, ROLE_CONTENT_MAX_BYTES: 65536, roleInjectMaxChars: 2000,
    roleSummaries: () => [{ name: ROLE }],
    sanitizeRoleName: (v) => String(v), validateRoleName: (v) => String(v), validateRoleContent: (v) => String(v ?? ''),
    roleFilePath: (n) => `/tmp/roles/${n}.md`,
    readRoleContent: () => 'hello',
    readConfigObject: () => ({}), applyRoleInjectLimit: (v) => Number(v) || 1200,
    atomicWriteJson() {}, writeRoleContent() {}, writeRoleState() {},
    roleWarnings: () => [], roleCharStats: () => ({}), roleSectionReport: () => ({}),
    // 分身工作台路由桩
    activeWorks: () => [], runningWorks: () => [], queuedWorks: () => [],
    findWork: () => ({ id: 'w1', title: 't', status: 'running' }),
    startWork: async () => ({ id: 'w1', title: 't', status: 'running', taskId: 'task1' }),
    updateWorkById: (id, fn) => ({ id, title: 't', status: 'running', updatedAt: Date.now() }),
    setWorkStatus: (cur, status) => ({ ...cur, status }), addProgress: (cur) => cur,
    WORK_STATUS: { RUNNING: 'running' }, worksStore: {},
    // token 用量账本路由桩
    priceTable: { symbol: '¥' },
    tokenLedger: {
      summary: () => ({ summary: { total: 1 } }), stats: () => ({ calls: 0 }),
      series: () => ({ series: [] }), conversation: (key) => (key ? { key, turns: [] } : null),
      recent: () => [{ id: 1 }], reset: () => {},
    },
  };
  baseDeps = base;
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => { throw new Error(`未提供依赖：${String(p)}`); }) });
}

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const h = { ...headers };
    if (payload != null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on('error', reject); req.end(payload ?? undefined);
  });
}

// 全部已迁出路由（router 命中）：第一批只读 4 + roles 9 + works 5 = 18 条
const MIGRATED = [
  { method: 'GET', path: '/api/state/overview' },
  { method: 'GET', path: '/api/presets' },
  { method: 'GET', path: '/api/console/metrics' },
  { method: 'GET', path: '/api/console/quality-trends' },
  { method: 'POST', path: '/api/role' },
  { method: 'POST', path: '/api/role-mode' },
  { method: 'GET', path: '/api/roles' },
  { method: 'GET', path: '/api/roles/content' },
  { method: 'POST', path: '/api/roles/limit' },
  { method: 'POST', path: '/api/roles/create' },
  { method: 'POST', path: '/api/roles/update' },
  { method: 'POST', path: '/api/roles/rename' },
  { method: 'POST', path: '/api/roles/delete' },
  { method: 'GET', path: '/api/works/list' },
  { method: 'POST', path: '/api/works/start' },
  { method: 'GET', path: '/api/works/peek' },
  { method: 'POST', path: '/api/works/update' },
  { method: 'POST', path: '/api/works/note' },
  // 第三批：token 用量账本 5 个
  { method: 'GET', path: '/api/tokens/summary' },
  { method: 'GET', path: '/api/tokens/series' },
  { method: 'GET', path: '/api/tokens/turns' },
  { method: 'GET', path: '/api/tokens/recent' },
  { method: 'POST', path: '/api/tokens/reset' },
];

test('端到端：router 分发在鉴权之后，23 个已迁出路由与 legacy ladder 行为都正确', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const server = startConsoleServerCore(makeDeps());
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => server.close());
  const port = server.address().port;
  const authed = { 'x-console-token': TOKEN };

  // 安全回归：分发点若误落在鉴权之前，这些会变成 200（免鉴权管理面）
  for (const { method, path } of MIGRATED) {
    const r = await request(port, { method, path, body: method === 'POST' ? {} : null });
    assert.equal(r.status, 401, `无令牌访问 ${method} ${path} 必须 401（router 不得绕过鉴权）`);
  }
  // 其它全局关卡仍然生效
  const r415 = await request(port, { method: 'POST', path: '/api/role', headers: { ...authed, 'content-type': 'text/plain' } });
  assert.equal(r415.status, 415);
  const r404 = await request(port, { path: '/api/definitely-not-a-route', headers: authed });
  assert.equal(r404.status, 404, '未命中 router → fallthrough 到 legacy ladder 的 404 兜底');

  // 已迁出路由由 router 命中并给出正确结果（不落到 404；turns 无 key 时的内部 404 属正常命中，用 ?key=k 验证）
  for (const { method, path } of MIGRATED) {
    const p = path === '/api/tokens/turns' ? '/api/tokens/turns?key=k' : path;
    const r = await request(port, { method, path: p, headers: authed, body: method === 'POST' ? {} : null });
    assert.notEqual(r.status, 404, `${method} ${p} 必须命中 router，而不是落到 404`);
  }
  // 关键响应内容（证明分支体逐字迁移、行为零变化）
  const rPresets = await request(port, { path: '/api/presets', headers: authed });
  assert.equal(rPresets.status, 200, rPresets.body);
  assert.equal(JSON.parse(rPresets.body).presets[0].id, 'p1');
  const rMetrics = await request(port, { path: '/api/console/metrics?hours=48', headers: authed });
  assert.equal(rMetrics.status, 200, rMetrics.body);
  assert.equal(JSON.parse(rMetrics.body).latencyMs, 7);
  const rTrends = await request(port, { path: '/api/console/quality-trends', headers: authed });
  assert.equal(rTrends.status, 200, rTrends.body);
  assert.equal(JSON.parse(rTrends.body).ok, true);
  const rOverview = await request(port, { path: '/api/state/overview', headers: authed });
  assert.notEqual(rOverview.status, 404);

  const rRoles = await request(port, { path: '/api/roles', headers: authed });
  assert.equal(rRoles.status, 200, rRoles.body);
  assert.equal(JSON.parse(rRoles.body).roles[0], ROLE);

  // 活绑定回归：/api/roles/limit 必须把 maxInjectChars 写回 deps（不能解构成局部变量）
  const rLimit = await request(port, { method: 'POST', path: '/api/roles/limit', headers: authed, body: { maxInjectChars: 800 } });
  assert.equal(rLimit.status, 200, rLimit.body);
  assert.equal(JSON.parse(rLimit.body).maxInjectChars, 800);
  assert.equal(baseDeps.roleInjectMaxChars, 800, 'roleInjectMaxChars 必须写回 deps 活绑定');

  const rWorksList = await request(port, { path: '/api/works/list?key=k', headers: authed });
  assert.equal(rWorksList.status, 200, rWorksList.body);
  assert.equal(JSON.parse(rWorksList.body).ok, true);
  const rPeek = await request(port, { path: '/api/works/peek?key=k&id=w1', headers: authed });
  assert.equal(rPeek.status, 200, rPeek.body);
  assert.equal(JSON.parse(rPeek.body).work?.id, 'w1');

  // 第三批 token 用量账本：关键响应 + 内部 404 + 未知子路径 404
  const rTokensSummary = await request(port, { path: '/api/tokens/summary', headers: authed });
  assert.equal(rTokensSummary.status, 200, rTokensSummary.body);
  assert.equal(JSON.parse(rTokensSummary.body).ledger.calls, 0);
  const rTokensRecent = await request(port, { path: '/api/tokens/recent', headers: authed });
  assert.equal(rTokensRecent.status, 200, rTokensRecent.body);
  assert.equal(JSON.parse(rTokensRecent.body).symbol, '¥');
  const rTokensTurnsOk = await request(port, { path: '/api/tokens/turns?key=k', headers: authed });
  assert.equal(rTokensTurnsOk.status, 200, rTokensTurnsOk.body);
  assert.equal(JSON.parse(rTokensTurnsOk.body).key, 'k');
  const rTokensTurns404 = await request(port, { path: '/api/tokens/turns?key=', headers: authed });
  assert.equal(rTokensTurns404.status, 404, 'turns 未知会话必须内部 404');
  const rTokensReset = await request(port, { method: 'POST', path: '/api/tokens/reset', headers: authed, body: {} });
  assert.equal(rTokensReset.status, 200, rTokensReset.body);
  const rTokensUnknown = await request(port, { path: '/api/tokens/does-not-exist', headers: authed });
  assert.equal(rTokensUnknown.status, 404, '未知 tokens 子路径必须 404（router 未命中 → legacy 兜底）');

  // 智能体令牌不得越权访问控制台管理路由（全局白名单关卡保留）
  const rAgent = await request(port, { path: '/api/roles', headers: { 'x-console-token': TOKEN, 'x-agent-token': AGENT_TOKEN, 'x-agent-call': '1' } });
  assert.equal(rAgent.status, 403, 'agent token 不能访问非白名单的控制台路由');

  // legacy ladder 仍正常服务
  const rRoot = await request(port, { path: '/', headers: authed });
  assert.equal(rRoot.status, 200);
  const rStatus = await request(port, { path: '/api/status', headers: authed });
  assert.equal(rStatus.status, 200);
});

// ── 黑话参数路由（仍留在 legacy ladder 的 slangMatch 段）状态机护栏回归锁 ──
// 锁住审计发现的几处「以为完善实则没到位」：
//  · PATCH 直接置 CONFIRMED 必须已填含义，否则空含义黑话会被注入 AI 上下文
//  · confirm 只认候选（已拒绝不可翻回已确认）
//  · reject 对已拒绝的词幂等返回
test('黑话参数路由护栏：PATCH 置已确认需含义 / confirm 只认候选 / reject 幂等', async (t) => {
  const deps = makeDeps();
  const ST = { CANDIDATE: 'candidate', CONFIRMED: 'confirmed', REJECTED: 'rejected', STALE: 'stale' };
  deps.SLANG_STATUS = ST;
  deps.saveSlangStore = () => {};
  deps.slangEntries = [
    { id: 'a', content: '梗A', meaning: '含义A', status: ST.CANDIDATE, count: 3, updatedAt: '' },
    { id: 'b', content: '梗B', meaning: '', status: ST.REJECTED, count: 2, updatedAt: '' },
    { id: 'c', content: '梗C', meaning: '', status: ST.CANDIDATE, count: 1, updatedAt: '' },
  ];
  const server = startConsoleServerCore(deps);
  if (!server.listening) await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });
  t.after(() => server.close());
  const port = server.address().port;
  const authed = { 'x-console-token': TOKEN };

  // 1) PATCH 直接置 CONFIRMED 但含义为空 → 400（不得把空含义黑话注入 AI 上下文）
  const rPatchEmpty = await request(port, { method: 'PATCH', path: '/api/slang/c', headers: authed, body: { status: ST.CONFIRMED } });
  assert.equal(rPatchEmpty.status, 400, rPatchEmpty.body);
  // PATCH 带含义置 CONFIRMED → 200
  const rPatchOk = await request(port, { method: 'PATCH', path: '/api/slang/c', headers: authed, body: { status: ST.CONFIRMED, meaning: '新含义' } });
  assert.equal(rPatchOk.status, 200, rPatchOk.body);
  assert.equal(JSON.parse(rPatchOk.body).entry.status, ST.CONFIRMED);

  // 2) confirm 一个已拒绝的词 → 400（终态护栏：不可把已拒绝翻回已确认）
  const rConfRej = await request(port, { method: 'POST', path: '/api/slang/b/confirm', headers: authed, body: {} });
  assert.equal(rConfRej.status, 400, rConfRej.body);
  // confirm 一个候选且有含义 → 200 并置 CONFIRMED
  const rConf = await request(port, { method: 'POST', path: '/api/slang/a/confirm', headers: authed, body: {} });
  assert.equal(rConf.status, 200, rConf.body);
  assert.equal(JSON.parse(rConf.body).entry.status, ST.CONFIRMED);

  // 3) reject 一个已拒绝的词 → 200 幂等（skipped），不报错
  const rRej = await request(port, { method: 'POST', path: '/api/slang/b/reject', headers: authed, body: {} });
  assert.equal(rRej.status, 200, rRej.body);
  assert.equal(JSON.parse(rRej.body).skipped, true);
});

// ── [L3 / SELF-EDIT] 端到端：安全头与自改门禁在真实 HTTP 链路上确实生效 ──────
test('端到端：GET / 下发的 CSP 与真实 console.html 内联脚本逐段一致，页面无会被新 CSP 拦掉的写法', async (t) => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const deps = makeDeps();
  deps.fs = { ...deps.fs, readFileSync: () => html }; // 让根路径返回真实页面而非空串桩
  const server = startConsoleServerCore(deps);
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => server.close());
  const r = await request(server.address().port, { headers: { 'x-console-token': TOKEN } });
  assert.equal(r.status, 200, r.body);

  const csp = r.headers['content-security-policy'] ?? '';
  assert.match(csp, /^default-src 'self'/, '服务端必须真的下发 CSP');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'script-src 不得放开 unsafe-inline');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).filter((s) => s.trim());
  assert.ok(scripts.length >= 2);
  for (const s of scripts) {
    const hash = `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
    assert.ok(csp.includes(hash), '服务端白名单必须覆盖页面每一段内联脚本');
  }

  // 新 CSP 没有 unsafe-inline / unsafe-eval：内联事件属性、javascript: URL、
  // 外部脚本源都会在浏览器里被拦（表现为按钮失灵/白屏）。剔除 <script> 块后审计标记。
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assert.doesNotMatch(markup, /\son(?:click|error|load|change|input|submit|mouseover|focus|blur)\s*=/i, '不得依赖内联事件处理器');
  assert.doesNotMatch(markup, /javascript\s*:/i, '不得有 javascript: URL');
  assert.doesNotMatch(markup, /<(?:script|link|img|iframe)[^>]*\s(?:src|href)\s*=\s*["'](?:https?:)?\/\//i, '不得引用外部资源');
  assert.doesNotMatch(scripts.join('\n'), /\beval\s*\(|\bnew\s+Function\s*\(/, '没有 unsafe-eval，内联脚本不得依赖动态求值');
});

test('端到端：POST /api/console/self-edit-code 含危险代码时在写盘前被静态门禁拒绝', async (t) => {
  const V = await import('../src/domain/persona/self-edit-verify.mjs');
  const deps = makeDeps();
  deps.selfEditVerify = V;
  deps.path = { ...deps.path, resolve: (...p) => p.join('/') };
  let written = 0;
  deps.fs = { ...deps.fs, copyFileSync: () => { written += 1; }, writeFileSync: () => { written += 1; } };
  const server = startConsoleServerCore(deps);
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => server.close());
  const r = await request(server.address().port, {
    method: 'POST', path: '/api/console/self-edit-code',
    headers: { 'x-console-token': TOKEN },
    body: { file: 'qq-bridge/src/domain/persona/foo.js', content: "require('child' + '_process')" },
  });
  assert.equal(r.status, 400, r.body);
  assert.match(r.body, /静态扫描命中危险模式/);
  assert.equal(written, 0, '危险内容不得落盘，连备份都不该建');
});
