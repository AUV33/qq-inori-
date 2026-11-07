// console-routes/admin 单测：DSH 降级队列查看/重投路由 + 管理员令牌门槛
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRoutes } from '../src/adapters/console-routes/admin.mjs';

function makeCtx({ owner = false, token = '', deps = {} } = {}) {
  return {
    req: { headers: { 'x-console-token': token } },
    url: { searchParams: { get: () => token } },
    sendJson: (body, code) => ({ body, code }),
    deps: { stateDataPath: () => '', dshReplay: () => ({ ok: true }), ...deps },
    auth: { ownerPrivateTokenOk: (t) => owner && t === token },
  };
}

test('adminRoutes 暴露 dsh-queue / dsh-replay 两个路由', () => {
  const sigs = adminRoutes.map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(sigs, ['GET /api/admin/dsh-queue', 'POST /api/admin/dsh-replay'].sort());
  for (const r of adminRoutes) assert.equal(typeof r.handle, 'function');
});

test('dsh-queue 需要管理员令牌，否则 403', async () => {
  const res = await adminRoutes[0].handle(makeCtx({ owner: false, token: 'abc' }));
  assert.equal(res.code, 403);
  assert.equal(res.body.ok, false);
});

test('dsh-queue 管理员可读队列', async () => {
  const res = await adminRoutes[0].handle(makeCtx({ owner: true, token: 'abc' }));
  assert.equal(res.code, undefined);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.recent));
  assert.ok(typeof res.body.total === 'number');
});

test('dsh-replay 需要管理员令牌，否则 403', async () => {
  const res = await adminRoutes[1].handle(makeCtx({ owner: false, token: 'abc' }));
  assert.equal(res.code, 403);
});

test('dsh-replay 管理员触发重投', async () => {
  let called = false;
  const ctx = makeCtx({
    owner: true, token: 'abc',
    deps: { dshReplay: () => { called = true; return { ok: true, total: 5, replayed: 3, skipped: 2 }; } },
  });
  const res = await adminRoutes[1].handle(ctx);
  assert.equal(called, true);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.replayed, 3);
});

test('dshReplay 未注入时返回可读错误', async () => {
  const ctx = makeCtx({ owner: true, token: 'abc', deps: { dshReplay: null } });
  const res = await adminRoutes[1].handle(ctx);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result.ok, false);
  assert.ok(res.body.result.error);
});
