// inori-taskpool 金标：池上限/超时/队列上限的夹取、FIFO 挑下一条、超时判定、池状态渲染与持久化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_PARALLEL, DEFAULT_TASK_MAX_MS, DEFAULT_QUEUE_MAX,
  poolCap, taskMaxMs, queueMax, canDispatch, pickNextQueued, expiredRunning, renderPoolLine, loadPool, savePool,
} from '../src/domain/leaves/inori-taskpool.js';

test('poolCap / taskMaxMs / queueMax：非法值回落默认，边界夹取', () => {
  assert.equal(poolCap({}), DEFAULT_MAX_PARALLEL);
  assert.equal(poolCap({ socialV2: { taskPool: { maxParallel: 5 } } }), 5);
  assert.equal(poolCap({ socialV2: { taskPool: { maxParallel: 0 } } }), DEFAULT_MAX_PARALLEL, '0 不算合法并行数');
  assert.equal(poolCap({ socialV2: { taskPool: { maxParallel: 'x' } } }), DEFAULT_MAX_PARALLEL);

  assert.equal(taskMaxMs({}), DEFAULT_TASK_MAX_MS);
  assert.equal(taskMaxMs({ socialV2: { taskPool: { taskMaxMs: 1000 } } }), DEFAULT_TASK_MAX_MS, '低于 60s 兜底');
  assert.equal(taskMaxMs({ socialV2: { taskPool: { taskMaxMs: 60000 } } }), 60000);

  assert.equal(queueMax({}), DEFAULT_QUEUE_MAX);
  assert.equal(queueMax({ socialV2: { taskPool: { queueMax: 0 } } }), 0, '0 = 不排队，是合法配置');
  assert.equal(queueMax({ socialV2: { taskPool: { queueMax: -1 } } }), DEFAULT_QUEUE_MAX);
});

test('canDispatch：在跑数小于上限才能派', () => {
  const cfg = { socialV2: { taskPool: { maxParallel: 2 } } };
  assert.equal(canDispatch(0, cfg), true);
  assert.equal(canDispatch(1, cfg), true);
  assert.equal(canDispatch(2, cfg), false);
});

test('pickNextQueued：只挑 queued，按 at 升序 FIFO，同 at 按 id 稳定序', () => {
  const rows = [
    { id: 'b', status: 'queued', at: '2026-11-02T10:00:00' },
    { id: 'a', status: 'queued', at: '2026-11-02T10:00:00' },
    { id: 'z', status: 'running', at: '2026-11-02T09:00:00' },
    { id: 'c', status: 'done', at: '2026-11-02T08:00:00' },
    { id: 'd', status: 'queued', at: '2026-11-02T11:00:00' },
  ];
  assert.equal(pickNextQueued(rows).id, 'a');
  assert.equal(pickNextQueued([{ id: 'x', status: 'running' }]), null);
  assert.equal(pickNextQueued([]), null);
  assert.equal(pickNextQueued(null), null);
});

test('expiredRunning：只挑超过上限且带 sessionId 的', () => {
  const now = 1_800_000_000_000;
  const running = [
    { taskId: 't1', sessionId: 's1', dispatchAt: now - 100_000 },
    { taskId: 't2', sessionId: 's2', dispatchAt: now - 10_000 },
    { taskId: 't3', dispatchAt: now - 100_000 },
  ];
  const expired = expiredRunning(running, now, 60_000);
  assert.deepEqual(expired.map((r) => r.taskId), ['t1']);
});

test('renderPoolLine：空池返回空串（不造暗示）；在跑与排队分别成行', () => {
  assert.equal(renderPoolLine([], 0), '');
  assert.equal(renderPoolLine(null, 0), '');

  const line = renderPoolLine([{ taskId: 't1', taskShort: '查天气' }, { taskId: 't2' }], 3);
  assert.ok(line.includes('【任务池】2 件在跑'));
  assert.ok(line.includes('查天气'));
  assert.ok(line.includes('t2'));
  assert.ok(line.includes('另有 3 件排队'));
  assert.ok(line.includes('不用你盯'), '只递事实，不让主人操心');
});

test('renderPoolLine：只有排队没有在跑也能说清', () => {
  const line = renderPoolLine([], 2);
  assert.ok(line.includes('另有 2 件排队'));
  assert.ok(!line.includes('在跑'));
});

test('loadPool / savePool：往返一致、过滤坏条目；目录不存在会建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pool-'));
  const file = path.join(dir, 'nested', 'task-pool.json');
  const running = [{ taskId: 't1', sessionId: 's1', dispatchAt: 1 }, { taskId: 'bad', sessionId: '' }];
  assert.equal(savePool(file, running), true);
  assert.deepEqual(loadPool(file).running, [{ taskId: 't1', sessionId: 's1', dispatchAt: 1 }], '无 sessionId 的条目被过滤');

  assert.deepEqual(loadPool(path.join(dir, 'nope.json')), { running: [] });
  fs.writeFileSync(file, '不是 JSON', 'utf8');
  assert.deepEqual(loadPool(file), { running: [] });
});
