import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStateStore } from '../src/domain/shared/state-store.mjs';
import { createLifeLog } from '../src/domain/shared/life-log.mjs';
import { createLifeLoop } from '../src/domain/life/life-loop.mjs';

const H = 3600 * 1000;

function tmp(nowValue = 1793713000000) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'life-loop-'));
  let now = nowValue;
  const store = createStateStore({ root: path.join(base, 'state') });
  const lifeLog = createLifeLog({ root: path.join(base, 'logs'), clock: () => now });
  const loop = createLifeLoop({ store, lifeLog, now: () => now, minTickMs: 0, checkpointMs: H, sleeping: () => false });
  return { loop, store, lifeLog, base, setNow: (v) => { now = v; } };
}

test('tick：清醒 1h 照常消耗精力并持久化', async () => {
  const { loop, store, setNow } = tmp(0);
  await loop.tick({ now: 0, force: true });
  setNow(H);
  const r = await loop.tick({ now: H, force: true });
  assert.equal(r.skipped, false);
  assert.ok(r.dt > 0);
  const saved = store.readJson('self-state.json');
  assert.ok(saved.energy < 0.6, 'awake tick should drain');
  assert.equal(saved.at, H);
});

test('tick：长断档（>2h）按离线休息处理，精力恢复而不是抽干', async () => {
  const { loop, store, setNow } = tmp(0);
  await loop.tick({ now: 0, force: true });
  setNow(9 * H);
  await loop.tick({ now: 9 * H, force: true });
  const saved = store.readJson('self-state.json');
  assert.ok(saved.energy > 0.6, 'offline gap should recover, got ' + saved.energy);
});

test('minTick：小于阈值时跳过（不写状态）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'life-loop-'));
  let now = 0;
  const store = createStateStore({ root: path.join(base, 'state') });
  const loop = createLifeLoop({ store, now: () => now, minTickMs: 60000 });
  await loop.tick({ now: 0, force: true });
  now = 1000;
  const r = await loop.tick({ now: 1000 });
  assert.equal(r.skipped, true);
});

test('checkpoint：按 checkpointMs 写 life.tick 事件', async () => {
  const { loop, lifeLog, setNow } = tmp(0);
  await loop.tick({ now: 0, force: true });
  setNow(H + 1);
  await loop.tick({ now: H + 1, force: true });
  const events = lifeLog.read({ type: 'life.tick' });
  assert.ok(events.length >= 1);
  assert.ok(Number.isFinite(events[0].payload.energy));
});

test('sleepStart/sleepEnd：事件落生命线，状态更新', async () => {
  const { loop, lifeLog } = tmp(0);
  await loop.sleepStart(1000);
  await loop.sleepEnd(2000);
  const events = lifeLog.read();
  assert.deepEqual(events.map((e) => e.type), ['sleep.started', 'sleep.ended']);
  assert.equal(loop.state.at, 2000);
});

test('load：从已存状态恢复；损坏文件回默认', async () => {
  const { loop, store } = tmp(0);
  await loop.tick({ now: 1000, force: true });
  const fresh = createLifeLoop({ store, now: () => 5000 });
  const s = fresh.load();
  assert.equal(s.at, 1000);
  fs.writeFileSync(path.join(store.root, 'self-state.json'), '{bad');
  const broken = createLifeLoop({ store, now: () => 6000 });
  assert.equal(broken.load().at, 6000);
});

test('start/stop：定时器可启停，status 反映运行态', async () => {
  const { loop } = tmp(0);
  loop.start();
  assert.equal(loop.status().running, true);
  loop.stop();
  assert.equal(loop.status().running, false);
});

// [SLEEP-EVENT] 修复回归：sleep 是外部谓词、不写进 self-state，翻转必须由 life-loop 自己持有，
// 否则每 60s 都会重复写一条 sleep.started（稳态维度被灌水）。
test('sleep 翻转：只在边界各写一次事件，连续拍不重复', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'life-loop-sleep-'));
  let now = 0;
  let asleep = false;
  const store = createStateStore({ root: path.join(base, 'state') });
  const lifeLog = createLifeLog({ root: path.join(base, 'logs'), clock: () => now });
  const loop = createLifeLoop({ store, lifeLog, now: () => now, minTickMs: 0, checkpointMs: H, sleeping: () => asleep });

  await loop.tick({ now: 0, force: true });   // 首拍只记录初始态，不写事件
  assert.equal(lifeLog.read().filter((e) => e.type.startsWith('sleep.')).length, 0);

  asleep = true;
  for (let i = 1; i <= 4; i += 1) { now = i * H; await loop.tick({ now: i * H, force: true }); }
  asleep = false;
  for (let i = 5; i <= 7; i += 1) { now = i * H; await loop.tick({ now: i * H, force: true }); }

  const rows = lifeLog.read().filter((e) => e.type.startsWith('sleep.'));
  assert.deepEqual(rows.map((e) => e.type), ['sleep.started', 'sleep.ended'], '两次边界、各一条');
  assert.equal(rows[0].payload.offlineGap, false);
});

test('缺少 store：明确报错', () => {
  assert.throws(() => createLifeLoop({}), /store required/);
});
