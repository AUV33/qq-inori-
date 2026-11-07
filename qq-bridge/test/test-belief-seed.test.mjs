import test from 'node:test';
import assert from 'node:assert/strict';

import { seedBeliefsFromPeople } from '../src/domain/mind/belief-seed.mjs';
import { getPerson } from '../src/domain/mind/belief-store.mjs';

const NOW = 1793763000000;

test('种子：owner/普通成员、熟悉度对数饱和、lastContactAt', () => {
  const store = seedBeliefsFromPeople({
    1: { id: '1', owner: true, count: 200, lastSeen: NOW - 1000 },
    2: { id: '2', owner: false, count: 50, lastSeen: NOW - 2000 },
    3: { id: '3', count: 0 },
  }, { now: NOW });
  const owner = getPerson(store, '1', { now: NOW });
  assert.equal(owner.kind, 'private');
  assert.ok(owner.familiarity > 0.9);
  assert.equal(owner.lastContactAt, NOW - 1000);
  const member = getPerson(store, '2', { now: NOW });
  assert.equal(member.kind, 'group_member');
  assert.ok(member.familiarity > 0.6 && member.familiarity < 0.7);
  const zero = getPerson(store, '3', { now: NOW });
  assert.equal(zero.familiarity, 0);
});

test('种子：脏数据跳过、maxPeople 截断到高频者', () => {
  const store = seedBeliefsFromPeople({
    a: { count: 1 }, b: { count: 99 }, c: null, d: { count: 50 }, e: 'x',
  }, { now: NOW, maxPeople: 2 });
  const ids = Object.keys(store.people).sort();
  assert.deepEqual(ids, ['b', 'd']);
});

test('种子：空/非法输入返回空库，不抛', () => {
  for (const input of [null, undefined, 0, 'x', []]) {
    const store = seedBeliefsFromPeople(input, { now: NOW });
    assert.equal(Object.keys(store.people).length, 0);
  }
});
