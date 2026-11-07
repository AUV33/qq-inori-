// [ACTIVITY-MENU] 可选活动备选（2026-10-30）
//
// 规则（主人两次拍板）：玩方舟是可选活动；而且「随机一点，别催她干什么」。
// 所以这一层要锁住三件事：① 不是每次都出现；② 顺序随机、不固定引导；③ 措辞只给事实+许可，不出现祈使句。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupActivities, renderActivityMenu } from '../src/domain/conversation/activity-menu.mjs';

const mk = (name, activity, extra = {}) => ({ name, activity, steps: [`${name} 第一步`], ...extra });
const alwaysShow = () => 0; // 骰子恒 0 → 必出
const neverShow = () => 0.99; // 骰子恒 0.99 → 必不出

/** 固定序列 rng：按顺序吐值，用完后重复最后一个。 */
const seq = (...vals) => {
  let i = 0;
  return () => (i < vals.length ? vals[i++] : vals[vals.length - 1]);
};

test('groupActivities：按 activity 归组，跳过退役/归档/没写活动名', () => {
  const items = [
    mk('a', '明日方舟'),
    mk('b', '明日方舟'),
    mk('c', '画世界'),
    mk('退役', '明日方舟', { retired: true }),
    mk('归档', '明日方舟', { archived: true }),
    mk('没活动', ''),
    mk('空白活动', '   '),
  ];
  const g = groupActivities(items);
  const byName = new Map(g.map((x) => [x.activity, x.count]));
  assert.equal(byName.get('明日方舟'), 2);
  assert.equal(byName.get('画世界'), 1);
  assert.equal(g.length, 2);
  assert.deepEqual(groupActivities(null), []);
  assert.deepEqual(groupActivities([{ name: 'x' }]), []);
});

test('renderActivityMenu：概率门——骰子不到就不出现', () => {
  const items = [mk('a', '明日方舟'), mk('b', '画世界')];
  assert.equal(renderActivityMenu(items, { rng: neverShow }), '');
  assert.ok(renderActivityMenu(items, { rng: alwaysShow }).includes('【备选】'));
  assert.equal(renderActivityMenu(items, { rng: alwaysShow, chance: 0 }), '');
});

test('renderActivityMenu：随机挑最多 limit 个', () => {
  const items = [mk('a', '甲'), mk('b', '乙'), mk('c', '丙')];
  const text = renderActivityMenu(items, { limit: 2, rng: alwaysShow });
  assert.equal((text.match(/（\d+ 件）/g) || []).length, 2, text);
});

test('renderActivityMenu：顺序随机，不总是同一个活动排第一', () => {
  const items = [mk('a', '甲'), mk('b', '乙'), mk('c', '丙')];
  // 骰子 0 → 通过概率门；随后 0.999 → Fisher–Yates 不换位；0 → 全部换到最前
  const first = renderActivityMenu(items, { limit: 3, rng: seq(0, 0.999, 0.999, 0.999) });
  const second = renderActivityMenu(items, { limit: 3, rng: seq(0, 0, 0, 0) });
  const head = (t) => t.split('\n').pop();
  assert.notEqual(head(first), head(second), `两次顺序应不同：\n${first}\n---\n${second}`);
});

test('renderActivityMenu：只给事实+许可，没有祈使/催促词', () => {
  const text = renderActivityMenu([mk('a', '明日方舟'), mk('b', '画世界')], { rng: alwaysShow });
  for (const banned of ['你能挑', '想玩哪个', '就打开', '该去', '应该', '记得', 'skill_record', '注入']) {
    assert.ok(!text.includes(banned), `不该出现「${banned}」：${text}`);
  }
  assert.ok(text.includes('不用现在决定'), text);
  assert.ok(text.includes('不想干就发呆'), text);
});

test('renderActivityMenu：泛活动池可以没有技能归属，且不编步骤', () => {
  const text = renderActivityMenu([], {
    rng: alwaysShow, limit: 10,
    extraActivities: ['发呆，什么都不做', '听一会儿歌', '看会儿书'],
  });
  assert.ok(text.includes('发呆，什么都不做'), text);
  assert.ok(text.includes('听一会儿歌'), text);
  assert.ok(text.includes('看会儿书'), text);
  assert.ok(text.includes('不用现在决定'), text);
  assert.ok(!text.includes('（0 件）'), text);
});

test('renderActivityMenu：没有可选项就返回空串，不硬凑', () => {
  assert.equal(renderActivityMenu([], { rng: alwaysShow }), '');
  assert.equal(renderActivityMenu(null, { rng: alwaysShow }), '');
  assert.equal(renderActivityMenu([{ name: 'x', steps: [] }], { rng: alwaysShow }), '');
});

test('真实技能库：出的时候是方舟/画世界两个备选，不出的时候是空串', async () => {
  const fs = await import('node:fs');
  const path = new URL('../../../data/state/skills.json', import.meta.url);
  if (!fs.existsSync(path)) return;
  const store = JSON.parse(fs.readFileSync(path, 'utf8'));
  const shown = renderActivityMenu(store.items || [], { rng: alwaysShow, limit: 4 });
  assert.ok(shown.includes('明日方舟（5 件）'), shown);
  assert.ok(shown.includes('画世界（2 件）'), shown);
  assert.equal(renderActivityMenu(store.items || [], { rng: neverShow, limit: 4 }), '');
});
