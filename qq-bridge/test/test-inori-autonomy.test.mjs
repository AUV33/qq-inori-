// inori-autonomy 金标：独处决策的优先级（补愿望 > 挂心事 > 推进目标 > 关系反思 > 学习复盘 > 自由休息），
// 以及措辞纪律：只给选项与许可，不派任务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAction, buildAutonomyPrompt } from '../src/domain/leaves/inori-autonomy.js';

const NOW = 1_800_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const goal = (over = {}) => ({ status: 'active', text: '整理群记忆', touchedAt: iso(10 * 3600000), ...over });

test('优先级 ①：掉地上的愿望最先补上（哪怕也有目标/挂心事）', () => {
  const a = chooseAction({
    now: NOW,
    pendingWish: { count: 2 },
    goals: [goal()],
    curiosityLoops: [{ text: '想弄懂某词' }],
  });
  assert.equal(a.kind, 'wish-makeup');
  assert.ok(a.reason.includes('连着太忙'));
  assert.ok(a.prompt.includes('连着 2 次都没去成'));
  assert.ok(a.prompt.includes('别为了"做点什么"而硬做'), '许可语气');
});

test('优先级 ①.5：没有掉地愿望时先看自己挂心的事', () => {
  const a = chooseAction({ now: NOW, curiosityLoops: [{ text: '想弄清 bge-m3', source: '群聊' }, { text: '第二件' }] });
  assert.equal(a.kind, 'curiosity-chase');
  assert.ok(a.prompt.includes('bge-m3'));
  assert.ok(a.prompt.includes('来自群聊'));
  assert.ok(a.prompt.includes('另外还挂着：「第二件」'));
  assert.ok(a.prompt.includes('不是任务，查不查随你'));
});

test('优先级 ②：挂心事为空时才轮到「目标久未推进」', () => {
  const stale = chooseAction({ now: NOW, goals: [goal({ touchedAt: iso(7 * 3600000), nextAction: '先分类' })] });
  assert.equal(stale.kind, 'goal-progress');
  assert.ok(stale.prompt.includes('下一步：先分类'));
  assert.ok(stale.prompt.includes('goal_progress'), '告诉她记账入口');
  assert.ok(stale.prompt.includes('goal_done'), '完成要写 evidence');

  const fresh = chooseAction({ now: NOW, goals: [goal({ touchedAt: iso(60 * 1000) })] });
  assert.notEqual(fresh.kind, 'goal-progress', '6 小时内动过的目标不催');
});

test('优先级 ③：最近有互动 → 关系反思（提醒一次情绪别当长期结论）', () => {
  const a = chooseAction({
    now: NOW,
    recentMessages: [{ text: '他说的', isSelf: false, sender: 'A' }],
    relationship: { recentFacts: 2 },
  });
  assert.equal(a.kind, 'relationship-reflection');
  assert.ok(a.prompt.includes('一次情绪不要当长期结论'));
});

test('优先级 ④：有对话但还没有经验 → 学习复盘；不许为学习而硬写', () => {
  const a = chooseAction({ now: NOW, recentMessages: [{ text: '聊了几句', isSelf: false }], lessons: [] });
  assert.equal(a.kind, 'learning-review');
  assert.ok(a.prompt.includes('不要为了学习而硬写'));
});

test('兜底：什么都没有就是自由休息（自主时间不要求产出）', () => {
  const a = chooseAction({ now: NOW });
  assert.equal(a.kind, 'creative-rest');
  assert.ok(a.prompt.includes('自主时间不要求产出'));
});

test('自己的发言不算互动（不能拿她自己的话当关系素材）', () => {
  const a = chooseAction({
    now: NOW,
    recentMessages: [{ text: '我自己说的', isSelf: true, sender: '我' }],
    relationship: { recentFacts: 0 },
  });
  assert.equal(a.kind, 'creative-rest');
});

test('buildAutonomyPrompt：带 kind 与选择理由，方便事后回看为什么这么选', () => {
  const text = buildAutonomyPrompt({ now: NOW, pendingWish: { count: 1 } });
  assert.ok(text.startsWith('【自主时间｜wish-makeup】'));
  assert.ok(text.includes('选择理由：'));
});

test('已归档/暂停的目标不参与挑选', () => {
  const a = chooseAction({ now: NOW, goals: [{ status: 'done', text: '做完了', touchedAt: iso(99 * 3600000) }] });
  assert.equal(a.kind, 'creative-rest');
});

test('挂心事的措辞：给手段、给许可；空/空白 loops 不造暗示', () => {
  const a = chooseAction({ now: NOW, curiosityLoops: [{ text: '三角洲倒卖弹药怎么赚最快', source: '群里' }] });
  assert.ok(a.prompt.includes('web_search'), '告诉手段');
  assert.ok(a.prompt.includes('查不查随你'), '决定权归她');
  for (const loops of [[], [{ text: '   ' }]]) {
    const b = chooseAction({ now: NOW, curiosityLoops: loops });
    assert.notEqual(b.kind, 'curiosity-chase', '空 loops 不该造出挂心事');
  }
});

test('多条挂心事：主项进正文，其余最多再列三条（不刷屏）', () => {
  const a = chooseAction({
    now: NOW,
    curiosityLoops: [
      { text: '第一件：三角洲', source: '视频' },
      { text: '第二件' }, { text: '第三件' }, { text: '第四件' }, { text: '第五件' },
    ],
  });
  assert.ok(a.prompt.includes('第一件'));
  assert.ok(a.prompt.includes('第二件'));
  assert.ok(!a.prompt.includes('第五件'), '最多再列三条');
});
