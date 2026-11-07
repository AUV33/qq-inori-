// [ACTIVITY] 活动层：打开 App 后才知道「能做什么」（2026-10-30）
//
// 背景：主人拍板——「基建赚龙门币」不是独立方向，是「玩明日方舟」里的步骤；
// 她应该在打开之后才知道自己能干什么，而不是每小时被当待办推一次。
// 这里的规则是纯数据的：App ↔ 活动的对应只来自技能里的 activity / app 字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  skillsForApp,
  renderActivityContext,
  activityName,
  firstStepSummary,
  pickRandom,
  readActivityExtras,
} from '../../ai-companion-kit/packages/shared/activity-context.mjs';

const mk = (name, extra = {}) => ({ name, steps: [`${name} 的第一步`], ...extra });

test('skillsForApp：只认技能数据里的 app 字段，不猜名字', () => {
  const items = [mk('a', { app: 'com.x' }), mk('b', { app: ['com.y'] }), mk('c')];
  assert.deepEqual(skillsForApp(items, 'com.x').map((s) => s.name), ['a']);
  assert.deepEqual(skillsForApp(items, 'com.y').map((s) => s.name), ['b']);
  assert.deepEqual(skillsForApp(items, 'com.z'), []);
  assert.deepEqual(skillsForApp(items, ''), []);
  assert.deepEqual(skillsForApp(null, 'com.x'), []);
});

test('skillsForApp：退役/归档的不算', () => {
  const items = [
    mk('退役', { app: 'com.x', retired: true }),
    mk('归档', { app: 'com.x', archived: true }),
    mk('还在', { app: 'com.x' }),
  ];
  assert.deepEqual(skillsForApp(items, 'com.x').map((s) => s.name), ['还在']);
});

test('renderActivityContext：没有技能就返回空串，不硬凑', () => {
  assert.equal(renderActivityContext([]), '');
  assert.equal(renderActivityContext(null), '');
});

test('renderActivityContext：活动名与第一条步骤摘要都来自数据', () => {
  const long =
    '进基建工作区，先数清楚 15 个房间里制造站、贸易站、发电站各几个，再决定先改哪一类，别一上来就全改，改错了两天白干，改完还要回来确认三个站都在工作、订单是赤金换龙门币';
  const items = [
    mk('基建赚龙门币', {
      activity: '明日方舟',
      app: 'com.hypergryph.arknights',
      steps: [long],
    }),
    mk('方舟用 adb 进关要连点', { activity: '明日方舟', app: 'com.hypergryph.arknights', steps: ['先 phone_ocr 确认坐标'] }),
  ];
  const out = renderActivityContext(items);
  assert.ok(out.includes('【打开了「明日方舟」】'), out);
  assert.ok(out.includes('- 基建赚龙门币：进基建工作区'), out);
  assert.ok(out.includes('- 方舟用 adb 进关要连点：先 phone_ocr 确认坐标'), out);
  assert.ok(out.includes('…'), '长步骤要截断');
  assert.ok(!out.includes('订单是赤金换龙门币'), '不能把整段步骤灌进去');
  assert.ok(out.includes('这次干哪件、干到什么程度，你自己看着来'), out);
  assert.ok(!out.includes('skill_record'), '不要催她手动记，成败由工具结果自动记');
});

test('renderActivityContext：activity 可由调用方覆盖；没有活动名时退回「这个 App」', () => {
  assert.ok(renderActivityContext([mk('x', { activity: '甲' })], { activity: '乙' }).includes('【打开了「乙」】'));
  assert.ok(renderActivityContext([mk('没活动归属')]).includes('【打开了这个 App】'));
});

test('activityName / firstStepSummary：取值与压缩', () => {
  assert.equal(activityName([mk('a'), mk('b', { activity: '有名字' })]), '有名字');
  assert.equal(activityName([]), '');
  assert.equal(firstStepSummary({ steps: ['  多  空格\n换行  '] }), '多 空格 换行');
  assert.equal(firstStepSummary({ steps: ['x'.repeat(80)] }).length, 61); // 60 + 省略号
  assert.equal(firstStepSummary({ steps: [] }), '');
});

// [ACTIVITY-EXTRA] 2026-10-30：活动里「还能做什么」——只列名字，不写步骤（防编造）
test('renderActivityContext：给了 alsoDoable 才出现「这个里也还能」，随机取 2 条', () => {
  const skills = [mk('a', { activity: '明日方舟' })];
  const none = renderActivityContext(skills);
  assert.ok(!none.includes('这个里也还能'), none);

  const out = renderActivityContext(skills, {
    alsoDoable: ['公开招募', '领取邮件/签到', '看干员档案', '看剧情'],
    rng: () => 0,
  });
  assert.ok(out.includes('这个里也还能：'), out);
  assert.ok(out.includes('步骤你还没学会，想试就试'), out);
  const seg = out.split('这个里也还能：')[1].split('（')[0];
  assert.equal(seg.split('、').length, 2, '应当正好 2 条（一个顿号）');
});

test('pickRandom：数量与随机性可控', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(pickRandom(list, 2, () => 0.999).length, 2);
  assert.deepEqual(pickRandom([], 2), []);
  assert.deepEqual(pickRandom(list, 99).length, 4);
  assert.notDeepEqual(pickRandom(list, 2, () => 0), pickRandom(list, 2, () => 0.999));
});

test('readActivityExtras：按活动名读数据文件；缺文件/坏 JSON/没这个活动都返回空', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const file = path.join(dir, 'activities.json');
  fs.writeFileSync(file, JSON.stringify({ 明日方舟: { alsoDoable: ['公开招募', ' 看剧情 ', ''] } }), 'utf8');
  assert.deepEqual(readActivityExtras('明日方舟', file), ['公开招募', '看剧情']);
  assert.deepEqual(readActivityExtras('没有这个活动', file), []);
  assert.deepEqual(readActivityExtras('明日方舟', path.join(dir, 'nope.json')), []);
  fs.writeFileSync(file, '{坏 JSON', 'utf8');
  assert.deepEqual(readActivityExtras('明日方舟', file), []);
});
