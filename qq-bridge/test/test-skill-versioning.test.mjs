import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analytics,
  applyOutcome,
  ensureFields,
  history,
  merge,
  revise,
  rollback,
  upsert,
} from '../src/domain/leaves/inori-skills.js';

const store = () => ({ version: 1, items: [] });

test('旧技能迁移：flat 字段变成当前版本快照，lifetime 从当前成绩起算', () => {
  const s = {
    id: 's1', name: '旧技能', desc: 'd', steps: ['a'], verify: '文件:x',
    success: 2, fail: 1, attempts: 3, mastery: 0.4, confidence: 0.6, version: 1,
  };
  ensureFields(s);
  assert.equal(s.versions.length, 1);
  assert.deepEqual(s.versions[0].performance, { success: 2, fail: 1, attempts: 3, mastery: 0.4, confidence: 0.6 });
  assert.deepEqual(s.lifetime, { success: 2, fail: 1, attempts: 3 });
});

test('新建技能：v1、空成绩、versions 快照存在', () => {
  const st = store();
  const r = upsert(st, { name: '装游戏', steps: ['搜名字', '点安装'] });
  assert.equal(r.created, true);
  assert.equal(r.skill.version, 1);
  assert.equal(r.skill.success, 0);
  assert.equal(r.skill.versions.length, 1);
  assert.equal(r.skill.versions[0].version, 1);
});

test('同名重写：版本+1，旧版成绩留在 versions/history，当前成绩清零', () => {
  const st = store();
  const r1 = upsert(st, { name: '装游戏', steps: ['旧步骤'], verify: '文件:x' });
  applyOutcome(st, r1.skill.id, { ok: true, verifiedBy: 'verify', evidence: 'ok' });
  assert.equal(r1.skill.success, 1);
  const r2 = upsert(st, { name: '装游戏', steps: ['新步骤'], verify: '文件:y' });
  assert.equal(r2.changed, true);
  assert.equal(r2.fromVersion, 1);
  assert.equal(r2.toVersion, 2);
  assert.equal(r2.skill.success, 0);
  assert.equal(r2.skill.mastery, 0);
  assert.equal(r2.skill.history.length, 1);
  assert.deepEqual(r2.skill.versions.find((v) => v.version === 1).performance.success, 1);
  assert.deepEqual(r2.skill.lifetime, { success: 1, fail: 0, attempts: 1 });
});

test('同名但内容没变：不升版本', () => {
  const st = store();
  const r1 = upsert(st, { name: '装游戏', steps: ['a'] });
  const r2 = upsert(st, { name: '装游戏', steps: ['a'] });
  assert.equal(r2.changed, false);
  assert.equal(r2.skill.version, 1);
});

test('revise：改判据生成新版本，旧验证不污染新版', () => {
  const st = store();
  const r1 = upsert(st, { name: '装游戏', steps: ['a'], verify: '文件:x' });
  applyOutcome(st, r1.skill.id, { ok: true, verifiedBy: 'verify', evidence: 'ok' });
  assert.equal(r1.skill.verifiedVersion, 1);
  const r2 = revise(st, r1.skill.id, { verify: '文件:y' });
  assert.equal(r2.changed, true);
  assert.equal(r2.toVersion, 2);
  assert.equal(r2.skill.verified, false);
  assert.equal(r2.skill.verifiedVersion, 0);
  assert.equal(r2.skill.versions.find((v) => v.version === 1).performance.success, 1);
});

test('applyOutcome 验证成功：当前版 success/mastery/verifiedVersion 同步', () => {
  const st = store();
  const r = upsert(st, { name: '装游戏', steps: ['a'], verify: '文件:x' });
  const s = applyOutcome(st, r.skill.id, { ok: true, verifiedBy: 'verify', evidence: 'ok' });
  assert.equal(s.success, 1);
  assert.equal(s.mastery, 0.1);
  assert.equal(s.verifiedVersion, 1);
  assert.equal(s.versions.find((v) => v.version === 1).performance.success, 1);
  assert.equal(s.lifetime.success, 1);
});

test('history：返回当前版本与每版成绩/验证', () => {
  const st = store();
  const r = upsert(st, { name: '装游戏', steps: ['a'], verify: '文件:x' });
  applyOutcome(st, r.skill.id, { ok: true, verifiedBy: 'verify', evidence: 'ok' });
  revise(st, r.skill.id, { steps: ['b'] });
  const h = history(st, r.skill.id);
  assert.equal(h.currentVersion, 2);
  assert.equal(h.versions.length, 2);
  assert.equal(h.versions[0].performance.success, 1);
  assert.equal(h.versions[1].verifiedVersion, 0);
});

test('revise 带 reason：旧版本快照记下修订原因', () => {
  const st = store();
  const r = upsert(st, { name: '装游戏', steps: ['a'] });
  const r2 = revise(st, r.skill.id, { steps: ['b'], reason: '上次卡在商店预约' });
  assert.equal(r2.toVersion, 2);
  const old = r2.skill.versions.find((v) => v.version === 1);
  assert.equal(old.reason, '上次卡在商店预约');
});

test('rollback：回到旧版内容但生成新版本，当前成绩清零', () => {
  const st = store();
  const r1 = upsert(st, { name: '装游戏', steps: ['a'], verify: '文件:x' });
  applyOutcome(st, r1.skill.id, { ok: true, verifiedBy: 'verify', evidence: 'ok' });
  revise(st, r1.skill.id, { steps: ['b'], verify: '文件:y' });
  const r3 = rollback(st, r1.skill.id, 1);
  assert.equal(r3.changed, true);
  assert.equal(r3.fromVersion, 2);
  assert.equal(r3.toVersion, 3);
  assert.equal(r3.restoredFrom, 1);
  assert.deepEqual(r3.skill.steps, ['a']);
  assert.equal(r3.skill.verify, '文件:x');
  assert.equal(r3.skill.success, 0);
  assert.equal(r3.skill.mastery, 0);
  assert.equal(r3.skill.versions.find((v) => v.version === 2).reason, 'rollback:v1');
});

test('merge：source 归档、target 保留并记录 mergedFrom', () => {
  const st = store();
  const a = upsert(st, { name: '装游戏 A', steps: ['a'], tags: ['安卓'] });
  const b = upsert(st, { name: '装游戏 B', steps: ['b'], tags: ['预约'] });
  const r = merge(st, a.skill.id, b.skill.id);
  assert.equal(r.ok, true);
  assert.equal(r.source.archived, true);
  assert.equal(r.source.mergedInto, b.skill.id);
  assert.equal(r.target.mergedFrom.length, 1);
  assert.deepEqual(r.target.tags.sort(), ['安卓', '预约'].sort());
  assert.equal(r.target.steps[0], 'b', '不自动拼接 steps');
});

test('merge：不能合并自己/已归档技能', () => {
  const st = store();
  const a = upsert(st, { name: 'A', steps: ['a'] });
  assert.equal(merge(st, a.skill.id, a.skill.id).ok, false);
  const b = upsert(st, { name: 'B', steps: ['b'] });
  merge(st, a.skill.id, b.skill.id);
  assert.equal(merge(st, a.skill.id, b.skill.id).ok, false);
});


test('analytics：版本数/验证/注入/成败统计只报事实', () => {
  const st = store();
  const a = upsert(st, { name: 'A', steps: ['a'], verify: '文件:x' });
  applyOutcome(st, a.skill.id, { ok: true, verifiedBy: 'verify', evidence: 'ok', source: 'test' });
  const b = upsert(st, { name: 'B', steps: ['b'] });
  applyOutcome(st, b.skill.id, { ok: false, hint: '失败点', source: 'test' });
  revise(st, b.skill.id, { steps: ['b2'], reason: '改一版' });
  const s = analytics(st);
  assert.equal(s.total, 2);
  assert.equal(s.multiVersion, 1);
  assert.equal(s.versions, 3);
  assert.equal(s.verifiedCurrent, 1);
  assert.equal(s.injected, 0);
  assert.equal(s.success, 1);
  assert.equal(s.fail, 0, '当前版本没有失败；旧版失败在 lifetime');
  assert.equal(s.lifetime.success, 1);
  assert.equal(s.lifetime.fail, 1);
});
