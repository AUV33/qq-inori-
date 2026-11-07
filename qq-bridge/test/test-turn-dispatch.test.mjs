import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnDispatch } from '../src/domain/conversation/turn-dispatch.js';
import { planGrants as planTurnGrants } from '../src/domain/conversation/turn-scheduler.js';

/** 手动定时器：测试里不依赖真实时间 */
function makeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { due: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.due <= target).sort((a, b) => a[1].due - b[1].due);
        if (!due.length) break;
        const [id, v] = due[0];
        timers.delete(id);
        t = v.due;
        v.fn();
      }
      t = target;
    },
  };
  return clock;
}

function makeDispatch(overrides = {}) {
  const clock = makeClock();
  const logs = [];
  const dispatch = createTurnDispatch({
    maxConcurrent: () => 3,
    reserveForChat: () => 2,
    log: (l) => logs.push(l),
    plan: planTurnGrants,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { dispatch, clock, logs };
}

test('acquire：空闲时立刻拿到槽，kind 自动判断', async () => {
  const { dispatch } = makeDispatch();
  const grant = await dispatch.acquire('private:10001');
  assert.equal(grant.ok, true);
  assert.equal(grant.kind, 'chat');
  assert.equal(dispatch.stats().granted, 1);
});

test('begin/finish：令牌转活跃、结束释放并派发下一个', async () => {
  const { dispatch } = makeDispatch({ maxConcurrent: () => 1, reserveForChat: () => 0 });
  const g1 = await dispatch.acquire('private:1');
  assert.equal(dispatch.bind(g1, 's1'), true);
  assert.equal(dispatch.begin('s1'), true);
  assert.equal(dispatch.isActive('s1'), true);
  assert.equal(dispatch.stats().active, 1);
  assert.equal(dispatch.stats().granted, 0);

  let g2resolved = null;
  const g2p = dispatch.acquire('group:2').then((g) => { g2resolved = g; return g; });
  await new Promise((r) => setTimeout(r, 0));
  // 只有一个槽：s1 不结束，第二个只能排队
  assert.equal(g2resolved, null);
  dispatch.finish('s1');
  await g2p;
  assert.ok(g2resolved);
});

test('release：投递失败立刻还槽，排队者能进', async () => {
  const { dispatch } = makeDispatch({ maxConcurrent: () => 1, reserveForChat: () => 0 });
  const g1 = await dispatch.acquire('private:1');
  const g2p = dispatch.acquire('private:2');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dispatch.stats().queued, 1);
  dispatch.release(g1);
  const g2 = await g2p;
  assert.ok(g2.ok);
});

test('同一 label 严格串行：前一个没结束，后一个不会被派发', async () => {
  const { dispatch } = makeDispatch({ maxConcurrent: () => 3, reserveForChat: () => 0 });
  const a = await dispatch.acquire('group:123456789');
  dispatch.bind(a, 'sA');
  dispatch.begin('sA');
  let second = null;
  dispatch.acquire('group:123456789').then((g) => { second = g; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(second, null, '同 label 的第二个请求必须等第一个结束');
  dispatch.finish('sA');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(second, '第一个结束后第二个应被派发');
});

test('租约回收：拿到槽 60 秒不开始回合，令牌回收并派给下一个', async () => {
  const { dispatch, clock, logs } = makeDispatch({ maxConcurrent: () => 1, reserveForChat: () => 0 });
  const first = await dispatch.acquire('private:1');   // 拿槽但不 bind/begin
  assert.equal(dispatch.stats().granted, 1);
  const second = dispatch.acquire('private:2');
  let got = null; second.then((g) => { got = g; });
  clock.advance(60000);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(got, '回收后应派发下一个');
  assert.ok(logs.some((l) => l.includes('60 秒内没开始回合')), logs.join('\n'));
});

test('排队兜底：等 20 秒强制放行', async () => {
  const { dispatch, clock } = makeDispatch({ maxConcurrent: () => 1, reserveForChat: () => 0 });
  const g1 = await dispatch.acquire('private:1');
  dispatch.bind(g1, 's1');
  dispatch.begin('s1');
  const p = dispatch.acquire('private:2');
  clock.advance(20000);
  const g2 = await p;
  assert.equal(g2.forced, true);
  assert.equal(g2.ok, false);
});

test('stats：active/granted/queued 分开计数', async () => {
  const { dispatch } = makeDispatch({ maxConcurrent: () => 2, reserveForChat: () => 1 });
  const a = await dispatch.acquire('private:1');
  dispatch.bind(a, 's1');
  dispatch.begin('s1');
  const b = await dispatch.acquire('group:2');
  // 后台只留 1 个槽（bgLimit=1），此时占用已 2 → 后台请求排队
  const c = dispatch.acquire('isolated:vision', { kind: 'background' });
  await new Promise((r) => setTimeout(r, 0));
  const s = dispatch.stats();
  assert.equal(s.active, 1);
  assert.equal(s.granted, 1);
  assert.equal(s.queued, 1);
  assert.equal(s.max, 2);
  assert.equal(dispatch.bind(b, 's2'), true);
  dispatch.finish('s1');
  dispatch.release(b);   // 让出 chat 槽，后台才有位置
  await c;
});

// [P2-1] 后台小时预算：超额排队、超时丢弃记账、聊天不受限。
test('P2-1 后台预算：超过 maxPerHour 的派发留在队列', async () => {
  const { dispatch } = makeDispatch({
    maxConcurrent: () => 6,
    reserveForChat: () => 0,
    budget: () => ({ maxPerHour: 2, windowMs: 3_600_000, queueTimeoutMs: 120_000 }),
  });
  const first = await dispatch.acquire('isolated:ownlife', { kind: 'background' });
  assert.equal(first.ok, true);
  dispatch.release(first);
  const second = await dispatch.acquire('isolated:diary', { kind: 'background' });
  assert.equal(second.ok, true);
  dispatch.release(second);

  let third = null;
  dispatch.acquire('isolated:vision', { kind: 'background' }).then((g) => { third = g; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(third, null, '第三个后台必须排队，不能超发');
  assert.deepEqual(dispatch.budgetStats(), { maxPerHour: 2, used: 2, windowMs: 3_600_000 });
});

test('P2-1 后台预算：排队到 queueTimeoutMs 且预算仍满 → 丢弃并记账', async () => {
  const drops = [];
  const { dispatch, clock } = makeDispatch({
    maxConcurrent: () => 6,
    reserveForChat: () => 0,
    budget: () => ({ maxPerHour: 1, windowMs: 3_600_000, queueTimeoutMs: 120_000 }),
    onDrop: (info) => drops.push(info),
  });
  const first = await dispatch.acquire('isolated:ownlife', { kind: 'background' });
  dispatch.release(first);
  const pending = dispatch.acquire('isolated:diary', { kind: 'background' });
  clock.advance(120_000);
  const g = await pending;
  assert.equal(g.ok, false);
  assert.equal(g.dropped, true);
  assert.equal(g.reason, 'hourly_budget');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, 'hourly_budget');
  assert.equal(drops[0].maxPerHour, 1);
});

test('P2-1 后台预算只挡后台：聊天照常派发', async () => {
  const { dispatch } = makeDispatch({
    maxConcurrent: () => 6,
    reserveForChat: () => 0,
    budget: () => ({ maxPerHour: 1, windowMs: 3_600_000, queueTimeoutMs: 120_000 }),
  });
  const bg = await dispatch.acquire('isolated:ownlife', { kind: 'background' });
  dispatch.release(bg);
  const chat = await dispatch.acquire('private:1');
  assert.equal(chat.ok, true);
  assert.equal(chat.kind, 'chat');
});

test('P2-1 预算豁免：gate 不占后台额度，也不会被预算挡', async () => {
  const { dispatch } = makeDispatch({
    maxConcurrent: () => 6,
    reserveForChat: () => 0,
    budget: () => ({ maxPerHour: 1, windowMs: 3_600_000, queueTimeoutMs: 120_000, exemptKinds: ['gate'] }),
  });
  const bg = await dispatch.acquire('isolated:ownlife', { kind: 'background' });
  dispatch.release(bg);
  assert.equal(dispatch.budgetStats().used, 1);
  const gate = await dispatch.acquire('isolated:gate', { kind: 'background' });
  assert.equal(gate.ok, true, '预算满时 gate 仍要能派发（聊天路径的前置）');
  assert.equal(dispatch.budgetStats().used, 1, 'gate 不应占用后台额度');
});

test('P2-1 后台排队超时但预算有空位 → 仍按兜底放行（不丢任务）', async () => {
  const { dispatch, clock } = makeDispatch({
    maxConcurrent: () => 1,
    reserveForChat: () => 0,
    // 租约拉长：避免聊天令牌 60 秒被回收，把后台提前放进来（那样验证不到排队超时分支）
    leaseMs: 10_000_000,
    budget: () => ({ maxPerHour: 6, windowMs: 3_600_000, queueTimeoutMs: 120_000 }),
  });
  await dispatch.acquire('private:1'); // 占满唯一槽位（聊天）
  const pending = dispatch.acquire('isolated:diary', { kind: 'background' });
  clock.advance(120_000);
  const g = await pending;
  assert.equal(g.forced, true);
  assert.equal(g.ok, false);
});

// [P2-2] 优先级分层与资源门。
test('P2-2 priorityOf：后台派发采用注入的优先级', async () => {
  const seen = [];
  const { dispatch } = makeDispatch({
    maxConcurrent: () => 6,
    reserveForChat: () => 0,
    plan: (waiters, opts) => {
      seen.push(...waiters.map((w) => w.priority));
      return planTurnGrants(waiters, opts);
    },
    priorityOf: (kind, label) => (label === 'isolated:slang' ? 10 : kind === 'chat' ? 60 : 40),
  });
  const g = await dispatch.acquire('isolated:slang', { kind: 'background' });
  assert.equal(g.ok, true);
  assert.equal(seen[0], 10);
});

test('P2-2 资源门：shouldHold 的后台本轮不派发，其他照常', async () => {
  const { dispatch } = makeDispatch({
    maxConcurrent: () => 6,
    reserveForChat: () => 0,
    shouldHold: (w) => w.label === 'isolated:slang',
  });
  let held = null;
  dispatch.acquire('isolated:slang', { kind: 'background' }).then((g) => { held = g; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(held, null, '被资源门挡下的后台不能拿到槽');
  const ok = await dispatch.acquire('isolated:vision', { kind: 'background' });
  assert.equal(ok.ok, true, '高优先级后台不受影响');
});

test('P2-1 预算豁免：ownlife 不被小时预算挡住（她自己的生活）', async () => {
  const dispatch = createTurnDispatch({
    maxConcurrent: () => 4,
    reserveForChat: () => 1,
    log: () => {},
    plan: planTurnGrants,
    budget: () => ({ maxPerHour: 1, windowMs: 3_600_000, queueTimeoutMs: 120_000, exemptKinds: ['gate', 'ownlife'] }),
    priorityOf: () => 20,
  });
  const first = await dispatch.acquire('isolated:vision', { kind: 'background' });
  assert.equal(first.ok, true);
  const own = await dispatch.acquire('isolated:ownlife', { kind: 'background' });
  assert.equal(own.ok, true, '预算满时 ownlife 仍要能派发');
  dispatch.dispose?.();
});
