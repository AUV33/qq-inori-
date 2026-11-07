// 验证 createQQPorts 骨架：提供 6 端口、缺省退化为内存实现、注入真实 deps 时优先使用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQPorts } from '../src/kernel/ports.mjs';

test('createQQPorts 提供 6 端口且缺省退化为内存实现', () => {
  const p = createQQPorts({ at: 1000 });
  for (const name of ['clock', 'events', 'state', 'act', 'sense', 'memory']) {
    assert.ok(p[name] && typeof p[name] === 'object', `${name} 端口缺失`);
  }
  assert.equal(typeof p.clock.now, 'function');
  assert.equal(typeof p.events.append, 'function');
  assert.equal(typeof p.state.load, 'function');
  assert.equal(typeof p.act.perform, 'function');
  assert.equal(typeof p.sense.poll, 'function');
  assert.equal(typeof p.memory.consolidate, 'function');
  assert.equal(p.clock.now(), 1000);
});

test('createQQPorts 注入真实 deps 时优先使用注入实现', () => {
  let sent = 0;
  let polled = 0;
  const p = createQQPorts({
    at: 2000,
    act: { perform: () => { sent += 1; return { ok: true }; } },
    sense: { poll: () => { polled += 1; return [{ type: 'message.received', payload: { key: 'k' }, at: 2000 }]; } },
  });
  p.act.perform({ selected: 'reply' });
  const rows = p.sense.poll();
  assert.equal(sent, 1);
  assert.equal(polled, 1);
  assert.deepEqual(rows, [{ type: 'message.received', payload: { key: 'k' }, at: 2000 }]);
});

test('createQQPorts 与 createKernel 组合根兼容（注入即上线，内核零改动）', () => {
  const ports = createQQPorts({
    at: 3000,
    sense: { poll: () => [] },
    act: { perform: () => ({ ok: true }) },
  });
  // 不 import 内核本体，只校验形状能被 assertPorts 接受（createQQPorts 已内部断言）。
  assert.equal(typeof ports.events.since, 'function');
  assert.equal(typeof ports.state.save, 'function');
});
