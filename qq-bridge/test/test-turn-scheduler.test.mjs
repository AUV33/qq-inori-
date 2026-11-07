// [SCHED] 并发槽派发策略的回归锁：分流（对话优先）、负载平衡（后台限流）、aging（不饿死）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGrants, turnScore } from '../src/domain/conversation/turn-scheduler.js';

const w = (label, kind, priority, at) => ({ label, kind, priority, at });
const NOW = 1_000_000;

test('对话优先：槽不够时先放 chat，后台让后', () => {
  const waiters = [
    w('isolated:ownlife', 'background', 20, NOW - 60_000), // 等最久，但仍是后台
    w('private:1', 'chat', 100, NOW),
  ];
  const grants = planGrants(waiters, { max: 1, bgLimit: 1, occupancy: 0, now: NOW });
  assert.deepEqual(grants, [1], '只该放私聊，后台不应抢在它前面');
});

test('后台不会占满所有槽：预留位留给对话', () => {
  const waiters = [0, 1, 2, 3].map((i) => w(`isolated:${i}`, 'background', 20, NOW));
  const grants = planGrants(waiters, { max: 6, bgLimit: 4, occupancy: 0, now: NOW });
  assert.equal(grants.length, 4, '后台最多占 bgLimit 个');
});

test('对话可以占满全部槽（后台没有排队时）', () => {
  const waiters = [0, 1, 2, 3, 4, 5].map((i) => w(`group:${i}`, 'chat', 60, NOW));
  const grants = planGrants(waiters, { max: 6, bgLimit: 4, occupancy: 0, now: NOW });
  assert.equal(grants.length, 6);
});

test('aging 生效：后台等久了能插到新来的后台前面', () => {
  const longWait = w('isolated:old', 'background', 20, NOW - 30_000);
  const fresh = w('isolated:new', 'background', 20, NOW);
  const grants = planGrants([fresh, longWait], { max: 1, bgLimit: 1, occupancy: 0, now: NOW });
  assert.deepEqual(grants, [1], '等久的那条先拿槽');
});

test('aging 不会让后台压过对话（后台最高 50 < 群聊 60 < 私聊 100）', () => {
  const bgOld = w('isolated:old', 'background', 20, NOW - 600_000); // aging 封顶 30 → 50
  const chat = w('group:1', 'chat', 60, NOW);                       // 60
  assert.ok(turnScore(bgOld, NOW) <= 50);
  assert.ok(turnScore(chat, NOW) > turnScore(bgOld, NOW));
  const grants = planGrants([bgOld, chat], { max: 1, bgLimit: 1, occupancy: 0, now: NOW });
  assert.deepEqual(grants, [1]);
});

test('占用已满时一个也不放（不超发）', () => {
  const waiters = [w('private:1', 'chat', 100, NOW), w('group:1', 'chat', 60, NOW)];
  const grants = planGrants(waiters, { max: 6, bgLimit: 4, occupancy: 6, now: NOW });
  assert.deepEqual(grants, []);
});

test('占用 5/6 时只放 1 个，不会一次放过量', () => {
  const waiters = [w('private:1', 'chat', 100, NOW), w('private:2', 'chat', 100, NOW)];
  const grants = planGrants(waiters, { max: 6, bgLimit: 4, occupancy: 5, now: NOW });
  assert.equal(grants.length, 1);
});

test('同一个 label 在队列里重复时只按最高的那条算一次（调用方另有告警）', () => {
  const waiters = [w('group:1', 'chat', 60, NOW - 5000), w('group:1', 'chat', 60, NOW - 4000)];
  const grants = planGrants(waiters, { max: 6, bgLimit: 4, occupancy: 0, now: NOW });
  assert.equal(grants.length, 1);
  assert.deepEqual(grants, [0], '同 label 只放最早入队的一条');
});
