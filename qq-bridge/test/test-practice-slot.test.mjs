// [PRACTICE-QUIET] 练手位挑选规则（2026-10-29）
//
// 旧行为：injected>0 && success==0，按 injected 降序取前 2 → 「明日方舟 adb 部署干员」
// （injected 2709、success 0）每小时的自主时间都出现一次，制造「再试一次」的死循环。
// 现在：练手位只摆「新学、还没怎么试过」的（injected < 120）；试过头的算「先放着」，不再常驻。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPracticeSlots, renderPracticeSlots, DEFAULT_MAX_INJECTED } from '../src/domain/social/practice-slot.mjs';

const skill = (name, injected, success = 0, extra = {}) => ({ name, injected, success, ...extra });

test('pickPracticeSlots：试过很多次仍 0 成功的进 stuck，不再摆出来', () => {
  const items = [
    skill('明日方舟 adb 部署干员', 2709),
    skill('刚学的截图对齐', 12),
  ];
  const { fresh, stuck } = pickPracticeSlots(items);
  assert.deepEqual(fresh.map((s) => s.name), ['刚学的截图对齐']);
  assert.deepEqual(stuck.map((s) => s.name), ['明日方舟 adb 部署干员']);
});

test('pickPracticeSlots：有新学的按注入次数降序、最多 2 条', () => {
  const items = [skill('a', 5), skill('b', 90), skill('c', 30), skill('d', 119)];
  const { fresh } = pickPracticeSlots(items);
  assert.deepEqual(fresh.map((s) => s.name), ['d', 'b']);
});

test('pickPracticeSlots：成功过的、退役的、从没注入过的不进练手位', () => {
  const items = [
    skill('做成过', 300, 3),
    skill('退役了', 50, 0, { retired: true }),
    skill('没注入过', 0),
  ];
  assert.deepEqual(pickPracticeSlots(items).fresh, []);
  assert.deepEqual(pickPracticeSlots(items).stuck, []);
});

test('pickPracticeSlots：maxInjected 可调，边界值算 stuck', () => {
  assert.equal(pickPracticeSlots([skill('刚好', DEFAULT_MAX_INJECTED)]).fresh.length, 0);
  assert.equal(pickPracticeSlots([skill('刚好', DEFAULT_MAX_INJECTED)]).stuck.length, 1);
  assert.equal(pickPracticeSlots([skill('刚好', 119)]).fresh.length, 1);
});

test('renderPracticeSlots：只有「试过头的」时返回空串，不拿它凑数', () => {
  assert.equal(renderPracticeSlots([skill('明日方舟 adb 部署干员', 2709)]), '');
  assert.equal(renderPracticeSlots([]), '');
  assert.equal(renderPracticeSlots(null), '');
});

test('renderPracticeSlots：有新学的才渲染，带判据与许可', () => {
  const line = renderPracticeSlots([skill('新技能', 7, 0, { verify: '命令: node x.mjs' })]);
  assert.ok(line.includes('【练手位】'));
  assert.ok(line.includes('新技能'));
  assert.ok(line.includes('命令: node x.mjs'));
  assert.ok(line.includes('想试就试'));
});

test('真实技能库：明日方舟 adb 部署干员不再出现在练手位', async () => {
  const fs = await import('node:fs');
  const path = new URL('../../../data/state/skills.json', import.meta.url);
  if (!fs.existsSync(path)) return; // 换机器没有数据就跳过
  const store = JSON.parse(fs.readFileSync(path, 'utf8'));
  const line = renderPracticeSlots(store.items || []);
  assert.ok(!line.includes('明日方舟 adb 部署干员'), '这条注入 2709 次仍未成功，应被搁置');
});

// [ACTIVITY-SCOPE] 2026-10-30：有活动归属的技能不进泛练手位——它们只在打开那个 App 时才递。
test('pickPracticeSlots：写了 activity/app 的技能不进泛练手位，普通技能照旧', () => {
  const items = [
    skill('基建赚龙门币', 1, 0, { activity: '明日方舟', app: 'com.hypergryph.arknights' }),
    skill('只写了 app', 3, 0, { app: ['com.example.app'] }),
    skill('普通新技能', 2),
  ];
  const { fresh, stuck } = pickPracticeSlots(items);
  assert.deepEqual(fresh.map((s) => s.name), ['普通新技能']);
  assert.deepEqual(stuck, []);
  assert.ok(!renderPracticeSlots(items).includes('龙门币'));
});

test('真实技能库：方舟技能已归到活动里，不再被泛练手位推', async () => {
  const fs = await import('node:fs');
  const path = new URL('../../../data/state/skills.json', import.meta.url);
  if (!fs.existsSync(path)) return;
  const store = JSON.parse(fs.readFileSync(path, 'utf8'));
  const line = renderPracticeSlots(store.items || []);
  assert.ok(!line.includes('基建赚龙门币'), '它有 activity/app 归属，应只在打开 App 时出现');
  const apex = (store.items || []).filter((s) => s.activity === '明日方舟');
  assert.ok(apex.length >= 5, `方舟技能应有 5 条归属，实际 ${apex.length}`);
  assert.ok(apex.every((s) => s.app === 'com.hypergryph.arknights'), '每条都要带用 adb 核实过的包名');
});
