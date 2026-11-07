// test-shadow-ports.test.mjs · S4b：影子端口不得伪造"她说过话"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createShadowPorts, assertPorts } from '../src/kernel/ports.mjs';
import { createKernel } from '../src/kernel/index.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const H = 3600000;

function portsWithStore() {
  const written = [];
  const store = {
    readJson: () => null,
    writeJson: (file, value) => { written.push({ file, value }); return value; },
  };
  return { ports: createShadowPorts({ at: T, store }), written };
}

test('影子端口形状完整；act 明确无 sentKey（不发消息）', () => {
  const { ports } = portsWithStore();
  assertPorts(ports);
  const result = ports.act.perform({ selected: 'initiate' }, {}, T);
  assert.equal(result.ok, true);
  assert.equal(result.shadow, true);
  assert.equal(result.sentKey, undefined);
  assert.equal(ports.act.history().length, 1);
});

test('影子内核：孤独驱动 initiate，但事件流里没有伪造的 message.sent', () => {
  const { ports } = portsWithStore();
  const k = createKernel({ ports, reflectMs: 1000 * H });
  k.tick(T);
  const trace = k.tick(T + 7 * H);
  assert.equal(trace.decision.selected, 'initiate');
  const sent = ports.events.read().filter((e) => e.type === 'message.sent');
  assert.equal(sent.length, 0, '影子没有真的发出消息，不得写 message.sent');
  assert.ok(ports.events.read().some((e) => e.type === 'action.taken'));
  assert.equal(k.state.unread.length, 0, '没有消息被"发出"，未读不应被清空');
});

test('影子 sense 可注入消息：决策 reply，但未读保留（因为没真发）', () => {
  const { ports } = portsWithStore();
  const k = createKernel({ ports, reflectMs: 1000 * H });
  ports.sense.push({ type: 'message.received', payload: { key: 'private:1' }, at: T + 1 });
  const trace = k.tick(T + 1);
  assert.equal(trace.decision.selected, 'reply');
  assert.equal(k.state.unread.length, 1, '影子不发送，不应把未读清掉');
  assert.equal(ports.events.read().filter((e) => e.type === 'message.sent').length, 0);
});

test('影子 memory 不谎报巩固条数；状态照常落盘', () => {
  const { ports, written } = portsWithStore();
  const k = createKernel({ ports, reflectMs: 1000 * H });
  k.tick(T);
  assert.equal(ports.events.read().filter((e) => e.type === 'memory.consolidated').length, 0);
  assert.ok(written.length >= 1, 'state.save 应写 store');
  assert.equal(written.at(-1).file, 'kernel-state.json');
});
