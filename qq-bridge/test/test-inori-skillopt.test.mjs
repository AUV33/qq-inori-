// inori-skillopt 金标：失败是「优化」不是「淘汰」——写失败点、降置信度，但不删除；成功无判据只记尝试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appAliases, matchSkill, optimizeSkill } from '../src/domain/leaves/inori-skillopt.js';

const skills = () => ({
  version: 1,
  items: [
    { id: 's1', name: '明日方舟 部署干员', desc: '打开方舟部署', tags: ['明日方舟', 'arknights'], confidence: 0.6, ok: 2, fail: 0 },
    { id: 's2', name: '整理群记忆', desc: '把群聊要点记进记忆', tags: ['记忆'], confidence: 0.8, ok: 5, fail: 0 },
    { id: 's3', name: '废弃技能', desc: '明日方舟', tags: ['明日方舟'], deprecated: true },
  ],
});

test('appAliases：安卓包名映射到人话别名（前缀匹配）', () => {
  assert.deepEqual(appAliases('com.hypergryph.arknights'), ['明日方舟', 'arknights', 'ark']);
  assert.deepEqual(appAliases('com.tencent.mm'), ['微信']);
  assert.deepEqual(appAliases('其他包'), []);
  assert.deepEqual(appAliases(null), []);
});

test('matchSkill：按 app 别名/名称/描述/标签命中；跳过已废弃技能', () => {
  const hit = matchSkill(skills(), { app: 'com.hypergryph.arknights' });
  assert.equal(hit.id, 's1', '靠别名命中明日方舟技能');
  assert.equal(matchSkill(skills(), { goal: '整理群记忆' }).id, 's2');
  assert.equal(matchSkill(skills(), { app: '明日方舟' }).id, 's1', '废弃技能不参与匹配');
  assert.equal(matchSkill(skills(), { app: '毫不相干' }), null);
  assert.equal(matchSkill(null, { app: 'x' }), null);
});

test('optimizeSkill：卡住 → 记失败点并降置信度，技能保留（不删除）', () => {
  const json = skills();
  const before = { ...json.items[0] };
  const r = optimizeSkill(json, { app: 'com.hypergryph.arknights', stuck: true });
  assert.equal(r.changed, true);
  assert.ok(r.note.includes('失败 +1'));
  assert.ok(r.note.includes('已记下改进点'));
  assert.ok(json.items.length >= 2, '失败不能把技能删掉');
  const after = json.items.find((x) => x.id === 's1');
  assert.ok(after.fail > before.fail);
  assert.ok((after.confidence ?? 0) < (before.confidence ?? 1), '置信度要降');
  assert.ok(Array.isArray(after.hints) && after.hints.some((h) => h.includes('卡住了')), '失败点要写进技能的 hints');
});

test('optimizeSkill：卡住时的 hint 可覆盖，且截断到 160 字', () => {
  const json = skills();
  optimizeSkill(json, { app: '明日方舟', stuck: true, hint: '换个按钮再点' + '啊'.repeat(300) });
  const after = json.items.find((x) => x.id === 's1');
  const hint = (after.hints || []).find((h) => h.startsWith('换个按钮再点')) || '';
  assert.ok(hint.startsWith('换个按钮再点'));
  assert.ok(hint.length <= 160);
});

test('optimizeSkill：活动走通（steps>=3）只记 attempt，没有判据不算成功', () => {
  const json = skills();
  const before = { ...json.items[0] };
  const r = optimizeSkill(json, { app: '明日方舟', steps: 4 });
  assert.equal(r.changed, true);
  assert.ok(r.note.includes('没有判据不算成功'));
  const after = json.items.find((x) => x.id === 's1');
  assert.equal(Number(after.ok), Number(before.ok), '不能把「走通」记成成功');
  assert.ok((after.attempts ?? 0) >= 1, '要记一次尝试');
});

test('optimizeSkill：步数不足且没卡住 → 不动技能', () => {
  const json = skills();
  const r = optimizeSkill(json, { app: '明日方舟', steps: 2 });
  assert.equal(r.changed, false);
  assert.equal(r.note, '');
});

test('optimizeSkill：匹配不到技能时安静返回（不造记录）', () => {
  const json = skills();
  const r = optimizeSkill(json, { app: '完全没有的技能' });
  assert.deepEqual(r, { skill: null, changed: false, note: '' });
});
