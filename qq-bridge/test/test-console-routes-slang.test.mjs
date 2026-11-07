// test-console-routes-slang.test.mjs · console-routes/slang.mjs 的契约 + 行为测试（满足矩阵「测到」信号）。
// 直接 import 路由数组，验证：1) 契约 {method,path,handle(ctx)} 合法；2) __deps→deps 转换后 handler 行为一致。
import assert from 'node:assert/strict';
import test from 'node:test';
import { slangRoutes } from '../src/adapters/console-routes/slang.mjs';

test('slangRoutes 是合法的路由数组（契约 {method,path,handle}）', () => {
  assert.ok(Array.isArray(slangRoutes));
  assert.equal(slangRoutes.length, 9);
  const keys = new Set();
  for (const r of slangRoutes) {
    assert.equal(typeof r.method, 'string');
    assert.equal(typeof r.path, 'string');
    assert.equal(typeof r.handle, 'function');
    keys.add(`${r.method} ${r.path}`);
  }
  for (const key of [
    'GET /api/slang', 'POST /api/slang', 'POST /api/slang/clear',
    'POST /api/slang/batch-delete', 'POST /api/slang/batch-confirm', 'POST /api/slang/batch-reject',
    'POST /api/slang/extract', 'POST /api/slang/research', 'POST /api/slang/config',
  ]) {
    assert.ok(keys.has(key), `缺少路由 ${key}`);
  }
});

test('GET /api/slang 用 ctx.deps 渲染列表（与旧 ladder 分支等价）', async () => {
  const sent = [];
  const ctx = {
    url: new URL('http://127.0.0.1:3100/api/slang?status=confirmed'),
    sendJson: (payload) => { sent.push(payload); },
    deps: {
      slangEntries: [
        { id: '1', content: 'x', status: 'confirmed' },
        { id: '2', content: 'y', status: 'candidate' },
      ],
      cfg: { slang: { enabled: true } },
    },
  };
  const route = slangRoutes.find((r) => r.method === 'GET' && r.path === '/api/slang');
  await route.handle(ctx);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].entries, [{ id: '1', content: 'x', status: 'confirmed' }]);
  assert.deepEqual(sent[0].config, { enabled: true });
});

test('POST /api/slang/clear 用 ctx.deps 清空指定 status（与旧 ladder 分支等价）', async () => {
  const sent = [];
  const entries = [
    { id: '1', content: 'a', status: 'confirmed' },
    { id: '2', content: 'b', status: 'candidate' },
  ];
  const ctx = {
    url: new URL('http://127.0.0.1:3100/api/slang/clear'),
    sendJson: (payload) => { sent.push(payload); },
    readBody: async () => ({ status: 'candidate' }),
    deps: {
      get slangEntries() { return entries; },
      set slangEntries(v) { entries.length = 0; entries.push(...v); },
      saveSlangStore() {},
      log() {},
      SLANG_STATUS: { CANDIDATE: 'candidate', CONFIRMED: 'confirmed', REJECTED: 'rejected' },
    },
  };
  const route = slangRoutes.find((r) => r.method === 'POST' && r.path === '/api/slang/clear');
  await route.handle(ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].removedCount, 1);
  assert.deepEqual(entries, [{ id: '1', content: 'a', status: 'confirmed' }]);
});
