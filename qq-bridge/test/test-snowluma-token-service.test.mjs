// snowluma-token-service 金标：token/端点变了才重连、写回 config、10 秒自愈节流。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSnowLumaToken } from '../src/adapters/snowluma-token-service.mjs';

function makeCtx(overrides = {}) {
  const out = { logs: [], persisted: [], tokenPersisted: 0, discovered: 0, closed: 0, connected: 0 };
  const bot = { accessToken: 'old-token', url: 'ws://127.0.0.1:3001', close: () => { out.closed += 1; }, connect: () => { out.connected += 1; } };
  const ctx = {
    cfg: { snowluma: { accessToken: 'old-token', wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' } },
    bot,
    path,
    ROOT: 'D:/fake',
    log: (m) => out.logs.push(String(m)),
    persistSnowLumaEndpoint: (file, v) => { out.persisted.push({ file, v }); return { updated: true, changed: { accessToken: true, wsUrl: true } }; },
    persistToken: () => { out.tokenPersisted += 1; return { updated: true, from: 'old', to: 'new' }; },
    discoverSnowLumaConnection: async () => { out.discovered += 1; return { ok: true, token: 'http-new', wsToken: 'ws-new', wsUrl: 'ws://127.0.0.1:3002', baseUrl: 'http://127.0.0.1:3000', source: 'gateway', self: { user_id: 10001 } }; },
    ...overrides.ctxExtra,
  };
  return { svc: createSnowLumaToken(ctx), out, bot, ctx };
}

test('applyHealedTokens：token/端口都更新、写回 config、并让 SDK 立刻重连', async () => {
  const h = makeCtx();
  const changed = await h.svc.applyHealedTokens({
    token: 'http-new', wsToken: 'ws-new', wsUrl: 'ws://127.0.0.1:3002', baseUrl: 'http://127.0.0.1:3000', source: 'gateway',
  });
  assert.equal(changed, true);
  assert.equal(h.bot.accessToken, 'ws-new');
  assert.equal(h.bot.url, 'ws://127.0.0.1:3002', '端口也要跟着换（只换 token 会一直 1006）');
  assert.equal(h.ctx.cfg.snowluma.accessToken, 'http-new');
  assert.equal(h.ctx.cfg.snowluma.wsUrl, 'ws://127.0.0.1:3002');
  assert.equal(h.out.persisted.length, 1);
  assert.equal(h.out.persisted[0].v.wsUrl, 'ws://127.0.0.1:3002');
  assert.equal(h.out.closed, 1, '要主动断开重连');
  assert.equal(h.out.connected, 1);
});

test('applyHealedTokens：端点没变就不重连，config 已是最新也不写', async () => {
  const h = makeCtx({
    ctxExtra: { persistSnowLumaEndpoint: () => ({ updated: false, changed: {} }) },
  });
  const changed = await h.svc.applyHealedTokens({
    token: 'old-token', wsToken: 'old-token', wsUrl: 'ws://127.0.0.1:3001', baseUrl: 'http://127.0.0.1:3000', source: 'gateway',
  });
  assert.equal(changed, false);
  assert.equal(h.out.closed, 0);
  assert.equal(h.out.connected, 0);
  assert.ok(h.out.logs.some((l) => l.includes('已是最新')));
});

test('applyHealedTokens：写回 config 失败只记日志，不影响重连', async () => {
  const h = makeCtx({ ctxExtra: { persistSnowLumaEndpoint: () => { throw new Error('磁盘满'); } } });
  const changed = await h.svc.applyHealedTokens({
    token: 't2', wsToken: 't2', wsUrl: 'ws://x:3003', baseUrl: 'http://x:3000', source: 'gateway',
  });
  assert.equal(changed, true);
  assert.ok(h.out.logs.some((l) => l.includes('写回 config.json 失败')));
  assert.equal(h.out.connected, 1, '写盘失败也得把连接修好');
});

test('healTokenIfStale：发现成功就应用并记账号；失败只记原因', async () => {
  const h = makeCtx();
  await h.svc.healTokenIfStale('close 1006');
  assert.equal(h.out.discovered, 1);
  assert.equal(h.bot.url, 'ws://127.0.0.1:3002');
  assert.ok(h.out.logs.some((l) => l.includes('自愈完成：账号 10001')));
});

test('healTokenIfStale：10 秒内只试一次（close 事件会连续触发）', async () => {
  const h = makeCtx();
  await h.svc.healTokenIfStale('第一次');
  await h.svc.healTokenIfStale('第二次');
  assert.equal(h.out.discovered, 1, '第二次被节流');
});

test('healTokenIfStale：发现失败/抛异常都不外溢', async () => {
  const fail = makeCtx({ ctxExtra: { discoverSnowLumaConnection: async () => ({ ok: false, error: '连不上' }) } });
  await fail.svc.healTokenIfStale('close');
  assert.ok(fail.out.logs.some((l) => l.includes('token 自愈失败（close）：连不上')));

  const boom = makeCtx({ ctxExtra: { discoverSnowLumaConnection: async () => { throw new Error('炸了'); } } });
  await assert.doesNotReject(() => boom.svc.healTokenIfStale('close'));
  assert.ok(boom.out.logs.some((l) => l.includes('token 自愈异常')));
});

test('syncTokenToFile：只写文件、不动物件', async () => {
  const h = makeCtx();
  await h.svc.syncTokenToFile();
  assert.equal(h.out.tokenPersisted, 1);
  assert.equal(h.out.closed, 0);
  assert.equal(h.out.connected, 0);
});
