import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionService } from '../src/domain/send/vision-service.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

function makeService(overrides = {}) {
  const calls = { follows: [], grants: [], binds: [], released: [], submits: [], logs: [] };
  const service = createVisionService({
    isReady: () => true,
    ensureSession: async () => 'vision-1',
    follow: (id) => calls.follows.push(id),
    acquireSlot: async (label, opts) => { const g = { label, ...opts }; calls.grants.push(g); return g; },
    bindGrant: (g, id) => { calls.binds.push([g, id]); return true; },
    releaseGrant: (g) => calls.released.push(g),
    submit: async (req) => { calls.submits.push(req); return { result: { ok: true } }; },
    createCollector: () => ({
      push(event) {
        if (event.type !== 'turn/end') return null;
        return { reason: { kind: 'completed' }, text: '图片里是一张手机主屏' };
      },
    }),
    log: (line) => calls.logs.push(line),
    ...overrides,
  });
  return { service, calls };
}

test('ask：成功路径——订阅、绑槽、投递、收到 turn 文本', async () => {
  const { service, calls } = makeService();
  const pending = service.ask([PNG], '描述这张图');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.follows, ['vision-1']);
  assert.equal(calls.binds.length, 1);
  assert.equal(calls.binds[0][1], 'vision-1');
  // 事件投递把等待者唤醒
  service.handleEvent({ sessionId: 'vision-1', event: { type: 'turn/start' } });
  service.handleEvent({ sessionId: 'vision-1', event: { type: 'turn/end' } });
  assert.equal(await pending, '图片里是一张手机主屏');
  assert.equal(calls.released.length, 0);
});

test('ask：投递被拒——释放槽位、清等待者，不再挂住', async () => {
  const { service, calls } = makeService({
    submit: async () => ({ result: { ok: false, error: { code: 'rejected', message: 'busy' } } }),
  });
  await assert.rejects(() => service.ask([PNG], '看'), /投递被拒/);
  assert.equal(calls.released.length, 1);
  // 之后再收到该会话事件也不该抛
  assert.equal(service.handleEvent({ sessionId: 'vision-1', event: { type: 'turn/end' } }), true);
});

test('ask：DSH 不可用 / 空图直接拒绝', async () => {
  const { service } = makeService({ isReady: () => false });
  await assert.rejects(() => service.ask([PNG], '看'), /DSH 当前不可用/);
  const { service: s2 } = makeService();
  await assert.rejects(() => s2.ask([], '看'), /images 不能为空/);
});

test('ask：超时——拒绝并清掉等待者', async () => {
  const { service } = makeService({ createCollector: () => ({ push: () => null }) });
  await assert.rejects(() => service.ask([PNG], '看', { timeoutMs: 30 }), /看图超时/);
  // 清干净后，事件不再唤醒任何人
  assert.equal(service.handleEvent({ sessionId: 'vision-1', event: { type: 'turn/end' } }), true);
});

test('ask：多帧时提示按顺序看变化；最多 5 张图', async () => {
  const { service, calls } = makeService();
  const pending = service.ask([PNG, PNG, PNG, PNG, PNG, PNG, PNG], '看变化');
  await new Promise((r) => setTimeout(r, 0));
  const content = calls.submits[0].content;
  assert.match(content[0].text, /连续 7 帧/);
  assert.equal(content.filter((p) => p.type === 'image').length, 5);
  service.handleEvent({ sessionId: 'vision-1', event: { type: 'turn/end' } });
  await pending;
});

test('handleEvent：非看图会话返回 false，不吃事件', () => {
  const { service } = makeService();
  assert.equal(service.handleEvent({ sessionId: 'other', event: { type: 'turn/end' } }), false);
});

test('handleEvent：turn 未完成时把原因带回', async () => {
  const { service } = makeService({
    createCollector: () => ({ push: () => ({ reason: { kind: 'cancelled' }, text: '' }) }),
  });
  const pending = service.ask([PNG], '看');
  await new Promise((r) => setTimeout(r, 0));
  service.handleEvent({ sessionId: 'vision-1', event: { type: 'turn/end' } });
  await assert.rejects(() => pending, /看图 turn 未完成：cancelled/);
});
