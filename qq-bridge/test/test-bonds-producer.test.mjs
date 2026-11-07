// test-bonds-producer.test.mjs · S6b-2：入站接触必须真的进关系账，且不落 PII、不刷屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGroundwork } from '../src/domain/mind/groundwork.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';
import { personIdFor } from '../src/domain/social/identity-map.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const PID = personIdFor('qq', '10001');

async function waitFor(fn, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
function readBonds(root) {
  try {
    return fs.readFileSync(path.join(root, 'bonds.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('入站接触 → bonds familiarity +0.02；每小时每人只记一次；无 PII', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonds-producer-'));
  const geo = createGroundwork({ root, now: () => T, bondsFile: path.join(root, 'bonds.jsonl') });
  geo.noteContact('10001', { now: T, key: 'private:10001' });
  assert.ok(await waitFor(() => readBonds(root).length >= 1), '接触应写入关系账');
  let rows = readBonds(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'observe');
  assert.equal(rows[0].personId, PID);
  assert.equal(rows[0].dimension, 'familiarity');
  assert.equal(rows[0].delta, 0.02);

  const raw = fs.readFileSync(path.join(root, 'bonds.jsonl'), 'utf8');
  assert.equal(raw.includes('10001'), false, '关系账不得落 QQ 号明文');

  // 同一小时内再接触：不重复写
  geo.noteContact('10001', { now: T + 60000, key: 'private:10001' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readBonds(root).length, 1, '每小时每人只记一次接触');

  // 两小时后：再记一次
  geo.noteContact('10001', { now: T + 2 * 3600000, key: 'private:10001' });
  assert.ok(await waitFor(() => readBonds(root).length >= 2));
  rows = readBonds(root);
  assert.equal(rows.length, 2);

  const hub = createStateHub({ root, now: () => T + 3 * 3600000, log: () => {} });
  hub.load();
  const bond = hub.getBond(PID);
  assert.ok(bond, 'state-hub 应读得到这条关系');
  assert.ok(Math.abs(bond.familiarity - 0.54) < 1e-9, String(bond.familiarity));
  assert.equal(bond.taboo.length, 0);
  await geo.flushBeliefs();
});

test('非 QQ 数字 id（群号/名字）不写入关系账', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonds-producer2-'));
  const geo = createGroundwork({ root, now: () => T, bondsFile: path.join(root, 'bonds.jsonl') });
  geo.noteContact('group:123456', { now: T, key: 'group:123456' });
  geo.noteContact('示例甲', { now: T, key: 'private:1' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(readBonds(root).length, 0, '非 QQ UIN 不应被当成 personId 来源');
  await geo.flushBeliefs();
});
