// 技能库反馈闭环自检：成功加权 / 失败降权 / 连续失败只降级不删除（2026-10-27）
import assert from 'node:assert/strict';
import { find, recordResult } from '../src/domain/leaves/inori-skills.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

function mk(name, tags, success = 0, fail = 0) {
  return { id: 's1', name, desc: '', steps: [], verify: '', tags, success, fail, retired: false };
}

ok('成功过的技能在同等匹配下排前', () => {
  const store = { items: [mk('明日方舟部署', ['明日方舟', '部署'], 0, 0), mk('明日方舟基建', ['明日方舟', '基建'], 2, 0)] };
  const hits = find(store, '明日方舟', 3);
  assert.equal(hits[0].skill.name, '明日方舟基建');
});

ok('失败会压低检索得分', () => {
  const store = { items: [mk('A', ['测试'], 2, 0)] };
  const before = find(store, '测试')[0].score;
  recordResult(store, 's1', false);
  const after = find(store, '测试')[0].score;
  assert.ok(after < before, `expected ${after} < ${before}`);
});

ok('成功记数会提高检索得分', () => {
  const store = { items: [mk('A', ['测试'], 0, 0)] };
  const before = find(store, '测试')[0].score;
  recordResult(store, 's1', true);
  const after = find(store, '测试')[0].score;
  assert.ok(after > before, `expected ${after} > ${before}`);
});

ok('失败 5 次且从未成功 → 降级，不退役/不删除', () => {
  const store = { items: [mk('X', ['x'], 0, 0)] };
  for (let i = 0; i < 5; i += 1) recordResult(store, 's1', false);
  assert.equal(store.items[0].degraded, true);
  assert.equal(store.items[0].retired, false);
  assert.equal(store.items[0].fail, 5);
  assert.ok(store.items[0].attempts >= 5);
  assert.ok(Number(store.items[0].confidence) < 0.5);
});

ok('成功过的不因一次失败退役', () => {
  const store = { items: [mk('Y', ['y'], 1, 0)] };
  recordResult(store, 's1', false);
  assert.equal(store.items[0].retired, false);
  assert.equal(store.items[0].degraded, false);
});

ok('降级后成功一次会恢复（不删除、不永久封死）', () => {
  const store = { items: [mk('Z', ['z'], 0, 0)] };
  for (let i = 0; i < 5; i += 1) recordResult(store, 's1', false);
  assert.equal(store.items[0].degraded, true);
  recordResult(store, 's1', true);
  assert.equal(store.items[0].degraded, false);
  assert.equal(store.items[0].status, 'ok');
});

console.log(`🎉 技能反馈闭环测试通过（${passed} 项）`);
