import test from 'node:test';
import assert from 'node:assert/strict';

import { runParallel, collectValues } from '../src/domain/conversation/task-parallel.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 内存 scope 工厂：每个 id 一个独立 Map，验证任务单元命名空间隔离
function memoryScopeFactory() {
  const stores = new Map();
  return (id) => {
    if (!stores.has(id)) stores.set(id, new Map());
    const m = stores.get(id);
    return { id, get: (k) => m.get(k), set: (k, v) => m.set(k, v), _raw: m };
  };
}

test('并发执行：总耗时远小于串行之和，且结果按原顺序汇聚', async () => {
  const tasks = [
    { id: 'a', run: async () => { await delay(50); return 'A'; } },
    { id: 'b', run: async () => { await delay(30); return 'B'; } },
    { id: 'c', run: async () => { await delay(40); return 'C'; } },
  ];
  const t0 = Date.now();
  const results = await runParallel(tasks);
  const dt = Date.now() - t0;
  // 串行预期 50+30+40=120ms；并发应明显更短（留调度误差余量）
  assert.ok(dt < 110, `应并发执行，总耗时 ${dt}ms 应远小于串行 120ms`);
  assert.deepEqual(results.map((r) => r.value), ['A', 'B', 'C']);
});

test('独立作用域：任务单元之间不共享状态', async () => {
  const scopeFactory = memoryScopeFactory();
  const tasks = [
    { id: 'u1', run: async ({ scope }) => { scope.set('note', 'from-u1'); await delay(20); return scope.get('note'); } },
    { id: 'u2', run: async ({ scope }) => { scope.set('note', 'from-u2'); await delay(10); return scope.get('note'); } },
  ];
  const results = await runParallel(tasks, { scopeFactory });
  assert.equal(results[0].value, 'from-u1');
  assert.equal(results[1].value, 'from-u2');
  // 反向验证：单元只读到自己写入的值（命名空间隔离）
  assert.equal(scopeFactory('u1').get('note'), 'from-u1');
  assert.equal(scopeFactory('u2').get('note'), 'from-u2');
});

test('失败隔离（默认 propagate=false）：单单元崩不影响其他，结果标记 ok=false', async () => {
  const tasks = [
    { id: 'ok1', run: async () => 'good' },
    { id: 'bad', run: async () => { throw new Error('boom'); } },
    { id: 'ok2', run: async () => 'fine' },
  ];
  let threw = false;
  let results;
  try { results = await runParallel(tasks); } catch { threw = true; }
  assert.equal(threw, false, '默认不应向外抛错');
  assert.equal(results[0].ok, true);
  assert.equal(results[0].value, 'good');
  assert.equal(results[1].ok, false);
  assert.match(results[1].error.message, /boom/);
  assert.equal(results[2].ok, true);
  assert.equal(results[2].value, 'fine');
  // collectValues 跳过失败项
  assert.deepEqual(collectValues(results), ['good', undefined, 'fine']);
});

test('propagate=true：任一单元抛错则整体 reject', async () => {
  const tasks = [
    { id: 'ok', run: async () => 'ok' },
    { id: 'bad', run: async () => { throw new Error('fatal'); } },
  ];
  await assert.rejects(() => runParallel(tasks, { propagate: true }), /fatal/);
});

test('空任务列表安全返回空数组', async () => {
  assert.deepEqual(await runParallel([]), []);
  assert.deepEqual(await runParallel(undefined), []);
});
