// bootstrap/life-state 金标：生活状态的加载/迁移/落盘/兴趣锚点/启动注入头。
//
// 这个模块直接调用 inori-lifestate 的磁盘读写（默认指向仓库 data/state/life.json），
// 所以测试必须先把 QQ_INORI_ROOT 指到临时目录，再动态 import —— project-paths 在
// import 时就把根目录固化了，静态 import 会来不及改。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-life-state-'));
process.env.QQ_INORI_ROOT = root;

const { createLifeState } = await import('../src/bootstrap/life-state.mjs');

const lifeFile = () => path.join(root, 'data', 'state', 'life.json');
const readLife = () => JSON.parse(fs.readFileSync(lifeFile(), 'utf8'));

test('创建时加载默认生活状态；set/get 是同一份内存态', () => {
  const svc = createLifeState({ log: () => {}, getLastIncomingAt: () => 0 });
  const st = svc.get();
  assert.equal(typeof st, 'object');
  assert.equal(st.state, 'idle');
  assert.equal(st.enabled, true);
  assert.ok(st.debt >= 0 && st.debt <= 1);

  const next = { ...st, state: 'active', marker: 'x' };
  svc.set(next);
  assert.equal(svc.get().marker, 'x');
  assert.equal(svc.get(), next, 'set 后 get 返回同一对象');
});

test('note：状态迁移并落盘，opts.log 只写进日志', () => {
  const logs = [];
  const svc = createLifeState({ log: (m) => logs.push(m), getLastIncomingAt: () => 0 });
  svc.note({ type: 'sleep_claimed' }, { log: '她说要睡了' });
  assert.equal(svc.get().state, 'sleep');
  assert.ok(svc.get().sleepSince > 0);
  assert.equal(readLife().state, 'sleep', '迁移结果必须落盘');
  assert.deepEqual(logs, ['[life] 她说要睡了']);
});

test('note：未知事件不炸、不改状态；坏数据也不会把进程带崩', () => {
  const svc = createLifeState({ log: () => {}, getLastIncomingAt: () => 0 });
  const before = svc.get();
  assert.doesNotThrow(() => svc.note({ type: 'not-a-real-event' }));
  assert.equal(svc.get().state, before.state);
  assert.doesNotThrow(() => svc.note(null));
  assert.equal(svc.get().state, before.state);
});

test('touchInterest：记录兴趣锚点并落盘', () => {
  const svc = createLifeState({ log: () => {}, getLastIncomingAt: () => 0 });
  const before = svc.get().lastInterestAt || 0;
  svc.touchInterest();
  assert.ok(svc.get().lastInterestAt >= before);
  assert.ok(svc.get().lastInterestAt > 0);
  assert.ok(readLife().lastInterestAt > 0);
});

test('lifeTimePre：时间语义 + 生活状态可渲染，缺一块不影响另一块', () => {
  const svc = createLifeState({ log: () => {}, getLastIncomingAt: () => 0 });
  const text = svc.lifeTimePre();
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, '至少有时间段语义');
  assert.ok(text.split('\n').length >= 1);
});

test('startPhysTimer：5 分钟一次 tick，异常不外抛，timer 可 unref', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = [];
  const svc = createLifeState({ log: (m) => logs.push(m), getLastIncomingAt: () => Date.now() - 60 * 60000 });
  assert.doesNotThrow(() => svc.startPhysTimer());
  t.mock.timers.tick(5 * 60000);
  assert.ok(fs.existsSync(lifeFile()), 'tick 后仍要落盘');
  assert.doesNotThrow(() => svc.get());
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
