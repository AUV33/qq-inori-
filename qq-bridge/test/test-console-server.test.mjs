// console-server 金标（安全边界层）：失败关闭的令牌、Host 校验、CSRF、404/415、favicon 噪音。
//
// 这是 5600 行的大模块，不试图在单测里跑业务路由（那需要 300+ 个 __deps）；这里锁住
// 进入任何业务分支**之前**的那几道闸门 —— 它们出错的影响最大（无鉴权管理面 / DNS rebinding）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConsoleServerCore } from '../src/adapters/console-server.mjs';

const TOKEN = 'test-token-0123456789abcdef';

function makeDeps(overrides = {}) {
  const base = {
    cfg: { consolePort: 0, consoleToken: TOKEN, ownerQQ: '10001', socialV2: {} },
    crypto,
    http,
    fs: { mkdirSync() {}, openSync() { return 3; } },
    path: { join: (...p) => p.join('/') },
    LOG_DIR: '/tmp/logs',
    ROOT: process.cwd(),
    log: () => {},
    loadOrCreateConsoleToken: () => TOKEN,
    wasConsoleTokenCreatedOnLoad: () => false,
    canonicalV2Key: (k) => k,
    socialV2: { paused: false, conversations: new Map() },
    isSessionAllowedInCurrentMode: () => true,
    readRoleState: () => ({}),
    claimEmbedSpawn: () => false,
    compactGroupMemories: () => {},
  };
  return new Proxy({ ...base, ...overrides }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // 构造期/未命中路由不应碰到的依赖：返回一个会明确报错的桩，比静默 undefined 好定位。
      return () => { throw new Error(`测试未提供依赖：${String(prop)}`); };
    },
  });
}

async function start(overrides = {}) {
  const server = startConsoleServerCore(makeDeps(overrides));
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, port: server.address().port };
}

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload != null) {
      finalHeaders['content-type'] = finalHeaders['content-type'] || 'application/json';
      finalHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: finalHeaders }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

test('空控制台令牌：拒绝启动（失败关闭，绝不能无鉴权开门）', () => {
  assert.throws(() => startConsoleServerCore(makeDeps({
    cfg: { consolePort: 0, consoleToken: '', socialV2: {} },
    loadOrCreateConsoleToken: () => '',
  })), /令牌为空/);
});

test('未带令牌：除 favicon 外一律 401；favicon 直接 204 不产生噪音', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const { server, port } = await start();
  t.after(() => server.close());

  const anon = await request(port, { path: '/api/status' });
  assert.equal(anon.status, 401);
  assert.match(anon.body, /未授权/);

  const favicon = await request(port, { path: '/favicon.ico' });
  assert.equal(favicon.status, 204);

  const wrong = await request(port, { path: '/api/status', headers: { 'x-console-token': 'nope' } });
  assert.equal(wrong.status, 401);
});

test('Host 头只接受回环地址（DNS rebinding 防线）', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const { server, port } = await start();
  t.after(() => server.close());

  const evil = await request(port, { path: '/api/status', headers: { host: 'evil.example:1234', 'x-console-token': TOKEN } });
  assert.equal(evil.status, 403);
  assert.match(evil.body, /Host 头不被允许/);

  const localhost = await request(port, { path: '/api/nope', headers: { host: `localhost:${port}`, 'x-console-token': TOKEN } });
  assert.equal(localhost.status, 404, '合法 Host + 合法令牌 → 落到 404 兜底');
});

test('立法端点：owner/系统/只读群窗令牌都不能写；只有她的活令牌能写并落账', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-legislation-'));
  const previousTrend = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'learning-trend.jsonl');
  const HER = 'her-live-token-0123456789abcdef';
  const READ = 'her-read-token-0123456789abcdef';
  const { server, port } = await start({
    currentMode: 'reserved2',
    stateDataPath: (sub) => path.join(root, ...(sub ? [String(sub)] : [])),
    v2ToolEnabled: () => true,
    socialV2: { paused: false, conversations: new Map([['private:10001', { agentToken: HER, readToken: READ }]]) },
  });
  t.after(() => {
    server.close();
    if (previousTrend === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previousTrend;
  });

  const url = '/api/socialV2/legislation';
  const consoleOnly = await request(port, { method: 'POST', path: url, headers: { 'x-console-token': TOKEN }, body: { action: 'list' } });
  assert.equal(consoleOnly.status, 403, 'owner 控制台不能代写');
  assert.match(consoleOnly.body, /只有她能写/);

  const bogus = await request(port, { method: 'POST', path: url, headers: { 'x-console-token': TOKEN, 'x-agent-token': 'bogus' }, body: { action: 'make', text: 'x' } });
  assert.equal(bogus.status, 403, '伪令牌不能写');

  const readOnly = await request(port, { method: 'POST', path: url, headers: { 'x-console-token': TOKEN, 'x-agent-token': READ }, body: { action: 'make', text: '只读窗不能立法' } });
  assert.equal(readOnly.status, 403, '只读群窗令牌不能写全局立法（P1-4）');

  const made = await request(port, {
    method: 'POST', path: url,
    headers: { 'x-console-token': TOKEN, 'x-agent-token': HER },
    body: { action: 'make', text: '每天睡前回读一次账本', penalty: '把 decoFloor 调回 0.3' },
  });
  assert.equal(made.status, 200, made.body);
  const madeBody = JSON.parse(made.body);
  assert.equal(madeBody.ok, true);
  assert.match(madeBody.row.id, /^cm_/);
  assert.equal(madeBody.facts.total, 1);
  assert.equal(madeBody.row.kind, 'made');

  const assessed = await request(port, {
    method: 'POST', path: url,
    headers: { 'x-console-token': TOKEN, 'x-agent-token': HER },
    body: { action: 'assess', value: 0.6, reason: '我答应自己的事做到了' },
  });
  assert.equal(assessed.status, 200);
  assert.equal(JSON.parse(assessed.body).selfTrust.value, 0.6);

  const listed = await request(port, { method: 'POST', path: url, headers: { 'x-console-token': TOKEN, 'x-agent-token': HER }, body: { action: 'list' } });
  assert.equal(listed.status, 200);
  const listBody = JSON.parse(listed.body);
  assert.equal(listBody.commitments.length, 1);
  assert.equal(listBody.declined.length, 0);
  assert.equal(listBody.facts.total, 1);
});

test('带令牌：未知路径 404；非 JSON 写请求 415；空 agent token 403', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({}) }));
  const { server, port } = await start();
  t.after(() => server.close());

  const notFound = await request(port, { path: '/api/definitely-not-a-route', headers: { 'x-console-token': TOKEN } });
  assert.equal(notFound.status, 404);

  const badType = await request(port, {
    method: 'POST', path: '/api/socialV2/config',
    headers: { 'x-console-token': TOKEN, 'content-type': 'text/plain' },
  });
  assert.equal(badType.status, 415);

  const emptyAgent = await request(port, {
    path: '/api/status', headers: { 'x-console-token': TOKEN, 'x-agent-token': '' },
  });
  assert.equal(emptyAgent.status, 403);
  assert.match(emptyAgent.body, /agent token 不能为空/);
});
