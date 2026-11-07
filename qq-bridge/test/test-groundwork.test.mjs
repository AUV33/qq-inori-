import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGroundwork } from '../src/domain/mind/groundwork.mjs';

function tmpRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'groundwork-'));
  return { root: path.join(base, 'state/mind'), logRoot: path.join(base, 'logs/life-log') };
}

test('start：创建生命线事件与两个状态文件', async () => {
  const roots = tmpRoots();
  const gw = createGroundwork({ ...roots, now: () => 1793713000000 });
  const boot = await gw.start();
  assert.equal(boot.people, 0);
  assert.equal(boot.lifeLog.events, 1);
  assert.match(boot.narrative, /第一次醒来/);
  assert.ok(fs.existsSync(path.join(roots.root, 'offline-narrative.json')));
  assert.ok(fs.existsSync(path.join(roots.root, 'self-state.json')));
  assert.ok(fs.existsSync(path.join(roots.root, 'beliefs.json')));
  const events = gw.lifeLog.read();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'process.started');
});

test('start：第二次启动追加事件且保留信念', async () => {
  const roots = tmpRoots();
  const first = createGroundwork({ ...roots, now: () => 1000 });
  await first.start();
  const beliefs = { v: 1, at: 1000, people: { u1: { trust: 0.7 } }, groups: {} };
  fs.writeFileSync(path.join(roots.root, 'beliefs.json'), JSON.stringify(beliefs));

  const second = createGroundwork({ ...roots, now: () => 2000 });
  const boot = await second.start();
  assert.equal(boot.lifeLog.events, 2);
  assert.equal(boot.people, 1);
});

test('损坏状态文件：按默认值恢复而不抛', async () => {
  const roots = tmpRoots();
  fs.mkdirSync(roots.root, { recursive: true });
  fs.writeFileSync(path.join(roots.root, 'self-state.json'), '{bad');
  fs.writeFileSync(path.join(roots.root, 'beliefs.json'), 'null');
  const gw = createGroundwork({ ...roots, now: () => 3000 });
  const boot = await gw.start();
  assert.equal(boot.people, 0);
  assert.ok(typeof boot.selfState === 'string');
});

test('snapshot：返回自我状态与信念的冻结快照', async () => {
  const roots = tmpRoots();
  const gw = createGroundwork({ ...roots, now: () => 4000 });
  await gw.start();
  const snap = gw.snapshot();
  assert.equal(snap.v, 1);
  assert.ok(snap.selfState);
  assert.ok(snap.beliefs);
  assert.equal(typeof snap.beliefs.people, 'object');
});

test('缺少 root：明确报错', () => {
  assert.throws(() => createGroundwork({}), /root required/);
});

test('offline gap >2h：按离线休息恢复精力，不把一晚上抽干', async () => {
  const roots = tmpRoots();
  fs.mkdirSync(roots.root, { recursive: true });
  fs.writeFileSync(path.join(roots.root, 'self-state.json'), JSON.stringify({
    v: 1, at: 1000, energy: 0.2, sleepDebt: 0.4, socialHunger: 0.2, curiosity: 0.5,
    competence: 0.5, stress: 0.1, valence: 0.1, arousal: 0.3, mood: 0.1, affect: {},
  }));
  const gw = createGroundwork({ ...roots, now: () => 1000 + 13 * 3600 * 1000 });
  await gw.start();
  const saved = gw.store.readJson('self-state.json');
  assert.ok(saved.energy > 0.7, 'energy should recover after offline gap, got ' + saved.energy);
});

test('种子：peopleFile 存在时首次启动播种信念库', async () => {
  const roots = tmpRoots();
  const peopleFile = path.join(roots.root, 'people.json');
  fs.mkdirSync(roots.root, { recursive: true });
  fs.writeFileSync(peopleFile, JSON.stringify({
    1001: { id: '1001', owner: true, count: 200, lastSeen: 1793763000000 },
    1002: { id: '1002', count: 50, lastSeen: 1793763000000 },
  }));
  const gw = createGroundwork({ ...roots, peopleFile, now: () => 1793763000000 });
  const boot = await gw.start();
  assert.equal(boot.people, 2);
  const saved = gw.store.readJson('beliefs.json');
  assert.equal(Object.keys(saved.people).length, 2);
  assert.ok(saved.people['1001'].familiarity > 0.9);
});

test('noteContact：更新熟悉度并在 flush 时持久化', async () => {
  const roots = tmpRoots();
  const gw = createGroundwork({ ...roots, now: () => 1793763000000 });
  await gw.start();
  gw.noteContact('2001', { key: 'group:1', now: 1793763000000 });
  const p = gw.beliefs.people['2001'];
  assert.ok(p, 'person should be created');
  assert.equal(p.interactionCount, 1);
  assert.equal(await gw.flushBeliefs(), true);
  const saved = gw.store.readJson('beliefs.json');
  assert.equal(saved.people['2001'].interactionCount, 1);
});

test('noteGroupActivity：群信念建立/更新并 flush 持久化', async () => {
  const roots = tmpRoots();
  const gw = createGroundwork({ ...roots, now: () => 1793763000000 });
  await gw.start();
  const row = gw.noteGroupActivity('group:999', { now: 1793763000000, source: 'message' });
  assert.ok(row, 'group belief should be created');
  assert.equal(row.lastActiveAt, 1793763000000);
  assert.equal(await gw.flushBeliefs(), true);
  const saved = gw.store.readJson('beliefs.json');
  assert.ok(saved.groups['group:999']);
});
