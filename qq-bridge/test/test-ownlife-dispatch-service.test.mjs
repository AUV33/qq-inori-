// ownlife-dispatch-service 金标：忙时排队/去重/上限、投递失败回队、90 秒没开始回合重投一次、drain 优先级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnLifeDispatch } from '../src/domain/social/ownlife-dispatch-service.mjs';

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const state = { delivered: [], persists: 0, logs: [] };
  const ownlifeQueue = [];
  const lastTurnStartAt = new Map();
  const turnDispatch = { active: false, isActive: () => turnDispatch.active };
  const isolatedDead = new Set();
  const svc = createOwnLifeDispatch({
    cfg: { ownerQQ: 10001 },
    log: (m) => state.logs.push(String(m)),
    ownlifeQueue,
    persistOwnlifeQueue: () => { state.persists += 1; },
    ensureIsolatedSession: async () => 'sid-1',
    turnDispatch,
    getPhoneProbe: () => ({ get: async () => ({ ok: false, reason: '没检测到设备' }) }),
    renderPhoneLine: (ps) => (ps.ok ? '' : `【手机】${ps.reason}`),
    activityMenuLine: () => '\n【活动】可以画画',
    practiceSlotLine: () => '\n【练手位】明日方舟',
    deliverToIsolated: async (kind, text, meta) => { state.delivered.push({ kind, text, meta }); },
    getLastTurnStartAt: () => lastTurnStartAt,
    isolatedDead,
    saveIsolatedDead: () => { state.savedDead = (state.savedDead || 0) + 1; },
    ...overrides,
  });
  return { svc, state, ownlifeQueue, turnDispatch, lastTurnStartAt, isolatedDead };
}

test('正忙时排队：同 reason 去重、最多 3 条、落盘并返回 false', async () => {
  const h = makeCtx();
  h.turnDispatch.active = true;
  assert.equal(await h.svc.dispatchOwnlifeUnified('own-life', 'A'), false);
  assert.equal(await h.svc.dispatchOwnlifeUnified('own-life', 'B'), false);
  assert.equal(h.ownlifeQueue.length, 1, '同 reason 只留一条');
  assert.equal(h.ownlifeQueue[0].text, 'A', '先来的文本保留');
  for (const r of ['boredom', 'free-tick', 'x', 'y']) await h.svc.dispatchOwnlifeUnified(r, 'T');
  assert.equal(h.ownlifeQueue.length, 3, '队列上限 3');
  assert.ok(h.state.persists >= 1);
  assert.ok(h.state.logs.some((l) => l.includes('ownlife 正忙，排队')));
});

test('own-life 投递：拼上活动菜单/练手位/手机状态，并投到 owner 私聊', async () => {
  const h = makeCtx();
  assert.equal(await h.svc.dispatchOwnlifeUnified('own-life', '正文'), true);
  assert.equal(h.state.delivered.length, 1);
  const { text, meta } = h.state.delivered[0];
  assert.ok(text.startsWith('正文'));
  assert.ok(text.includes('【活动】'));
  assert.ok(text.includes('【练手位】'));
  assert.ok(text.includes('【手机】没检测到设备'));
  assert.equal(meta.key, 'private:10001');
  assert.equal(meta.reason, 'own-life');
});

test('非 own-life 的投递不改写文本', async () => {
  const h = makeCtx();
  await h.svc.dispatchOwnlifeUnified('boredom', '只发正文');
  const { text } = h.state.delivered[0];
  assert.equal(text, '只发正文');
});

test('投递失败：放回队列等下次 drain，返回 false', async () => {
  const h = makeCtx({ deliverToIsolated: async () => { throw new Error('DSH 没就绪'); } });
  assert.equal(await h.svc.dispatchOwnlifeUnified('own-life', '正文'), false);
  assert.equal(h.ownlifeQueue.length, 1);
  assert.equal(h.ownlifeQueue[0].reason, 'own-life');
  assert.ok(h.state.logs.some((l) => l.includes('投递失败')));
});

test('90 秒仍没开始回合 → 重投一次；第二次还没开始就放弃', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx();
  await h.svc.dispatchOwnlifeUnified('own-life', '正文');
  assert.equal(h.state.delivered.length, 1);
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(h.state.delivered.length, 2, '第一次重投');
  assert.equal(h.isolatedDead.has('ownlife'), false, '第一次重投不急着判定会话失效（可能只是事件漏了）');
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(h.state.delivered.length, 2, '第二次到限就放弃，不再重投');
  assert.ok(h.state.logs.some((l) => l.includes('重投后仍没开始回合')));
  assert.equal(h.isolatedDead.has('ownlife'), true, '放弃后才标记重建，交给下一轮');
  assert.ok(h.state.savedDead >= 1);
});

test('回合已经开始 / 还没到 90 秒 / 会话已活跃 → 不重投', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx();
  await h.svc.dispatchOwnlifeUnified('own-life', '正文');
  h.lastTurnStartAt.set('sid-1', Date.now() + 1000); // 回合在投递之后开始了
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(h.state.delivered.length, 1, '回合已开始就不该重投');

  const busy = makeCtx();
  await busy.svc.dispatchOwnlifeUnified('own-life', '正文');
  busy.turnDispatch.active = true;
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(busy.state.delivered.length, 1, '会话忙时也不重投');
});

test('drainOwnlifeQueue：按 own-life > boredom > free-tick 优先级取一条并投递', async () => {
  const h = makeCtx();
  h.ownlifeQueue.push(
    { reason: 'free-tick', text: 'F' },
    { reason: 'boredom', text: 'B' },
    { reason: 'own-life', text: 'O' },
  );
  h.svc.drainOwnlifeQueue();
  await flush();
  assert.equal(h.ownlifeQueue.length, 2);
  assert.equal(h.state.persists >= 1, true);
  assert.equal(h.state.delivered[0].text.startsWith('O'), true);
  assert.equal(h.svc.drainOwnlifeQueue(), undefined, '空队列直接返回');
});
