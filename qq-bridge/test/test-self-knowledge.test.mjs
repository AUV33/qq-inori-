// self-knowledge 金标：自我认知块的拼装顺序、私聊附加块、单个渲染器抛错不拖垮整块。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelfKnowledge } from '../src/domain/persona/self-knowledge.mjs';

function makeCtx(overrides = {}) {
  const state = { used: [], logged: [] };
  const svc = createSelfKnowledge({
    getSocialV2State: () => ({
      recentMessages: [
        { isSelf: false, text: '他说的', plain: '他说的 plain' },
        { isSelf: true, text: '我说的', plain: '我说的 plain' },
      ],
      chase: {},
    }),
    cfg: { socialV2: { lessons: { file: 'lessons.jsonl' }, goals: { file: 'goals.json' } } },
    computeStyleStats: (rows) => ({ count: rows.length }),
    chaseState: (st) => ({ chase: !!st }),
    getChaseAdaptMax: () => 3,
    readJsonlSafe: (f) => (String(f).includes('traces') ? [{ t: 1 }, { t: 2 }] : []),
    path: { join: (...p) => p.join('/') },
    stateDataPath: (n) => `state/${n}`,
    buildSelfModel: ({ traces, lessons }) => ({ traces: traces.length, lessons: lessons.length }),
    loadLessons: () => [{}, {}, {}],
    renderSelfNarrative: () => '【叙事】我最近在学表达',
    selfAnchorLine: () => '【身份锚点（事实，不是评价）】你是 测试角色；self=p_aaaaaaaaaaaa',
    renderSelfProfile: () => '【画像】话少',
    renderSelfModel: (m) => `【自我模型】trace=${m.traces} lesson=${m.lessons}`,
    summarizeSelfTrend: () => ({ ok: true }),
    renderSelfTrend: () => '【趋势】更稳了',
    cognition: {
      load: () => [{ id: 'c1' }],
      render: () => ({ text: '【认知】想明白了一件事', ids: ['c1'] }),
      markUsed: (items, ids) => { state.used.push(...ids); return items; },
      transact: (fn) => fn([]),
    },
    loadGoals: () => ({ items: [{ id: 'g1', title: '写日记' }] }),
    renderGoals: () => '1. 写日记',
    renderGoalOpenInvitation: () => '【目标】想定就定，不想定就空着',
    activityTracker: { recentApps: () => ['vscode'], lookup: () => [{ app: 'vscode' }] },
    renderTraceHint: () => '【痕迹】刚在写代码',
    renderThoughts: () => '【想法】上次在想记忆',
    renderLessonCandidates: () => '【经验候选】别急着下结论',
    renderBehaviorLedger: () => '【行为账】2026-11-02：看了 3 个视频',
    summarizeLearningWrites: () => ({ days: 7, total: 2 }),
    renderLearningWritesLine: () => '【学习】7 天写了 2 条',
    renderSelfRecentBlock: () => '【最近】刚聊完',
    renderLiveLearningBlocks: () => '【在学】明日方舟',
    renderLedger: () => '【账本】今天花了 3 毛',
    renderWorksLine: () => '【作品】写完一篇',
    worksStore: {},
    renderSkillCandidateLine: () => '【技能候选】整理群记忆',
    ...overrides,
  });
  return { svc, state };
}

test('selfKnowledgeBlock：包含叙事、环境事实、画像/模型、认知、目标', () => {
  const h = makeCtx();
  const block = h.svc.selfKnowledgeBlock({});
  assert.ok(block.includes('【叙事】'));
  assert.ok(block.includes('【你跑在哪】'));
  assert.ok(block.includes('【身份锚点（事实，不是评价）】'));
  assert.ok(block.includes('【画像】'));
  assert.ok(block.includes('【自我模型】'));
  assert.ok(block.includes('【认知】'));
  assert.ok(block.includes('【你手头的事（你自己定的目标）】'));
  assert.ok(h.state.used.includes('c1'), '注入认知要回填 usedCount');
});

test('selfKnowledgeBlock：没有目标时给邀请语，而不是空白', () => {
  const h = makeCtx({ renderGoals: () => '', loadGoals: () => ({ items: [] }) });
  const block = h.svc.selfKnowledgeBlock({});
  assert.ok(block.includes('【目标】想定就定'));
});

test('selfKnowledgeBlock：withTraces 才带痕迹块', () => {
  const h = makeCtx();
  assert.ok(!h.svc.selfKnowledgeBlock({}).includes('【痕迹】'));
  assert.ok(h.svc.selfKnowledgeBlock({ withTraces: true }).includes('【痕迹】'));
});

test('selfKnowledgeBlock：带 key 时补行为账/学习/最近；私聊才有账本/作品/技能候选', () => {
  const group = makeCtx().svc.selfKnowledgeBlock({ key: 'group:1' });
  assert.ok(group.includes('我最近做过的'));
  assert.ok(group.includes('【学习】'));
  assert.ok(group.includes('【最近】'));
  assert.ok(group.includes('【在学】'));
  assert.ok(!group.includes('【账本】'), '群里不给花销账本');
  assert.ok(!group.includes('【作品】'));
  assert.ok(!group.includes('【技能候选】'));

  const priv = makeCtx().svc.selfKnowledgeBlock({ key: 'private:1' });
  assert.ok(priv.includes('【账本】'));
  assert.ok(priv.includes('【作品】'));
  assert.ok(priv.includes('【技能候选】'));
});

test('selfKnowledgeBlock：任一渲染器抛错只丢那一块，其余照常', () => {
  const h = makeCtx({
    renderSelfProfile: () => { throw new Error('画像坏了'); },
    renderThoughts: () => { throw new Error('想法坏了'); },
    cognition: { load: () => { throw new Error('认知坏了'); } },
  });
  const block = h.svc.selfKnowledgeBlock({});
  assert.ok(block.includes('【叙事】'), '前面的块还在');
  assert.ok(block.includes('【自我模型】'), '后面的块也在');
  assert.ok(!block.includes('【画像】'));
});

test('buildSelfModelForPrompt：只取最近 12 条他人 / 20 条自己，plain 优先', () => {
  let captured = null;
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => ({ isSelf: false, text: `他${i}`, plain: `他plain${i}` })),
    ...Array.from({ length: 25 }, (_, i) => ({ isSelf: true, text: `我${i}` })),
  ];
  const h = makeCtx({
    getSocialV2State: () => ({ recentMessages: rows }),
    buildSelfModel: (payload) => { captured = payload; return payload; },
  });
  h.svc.buildSelfModelForPrompt('group:1');
  assert.equal(captured.styleEntry.scene.count, 12);
  assert.equal(captured.styleEntry.mine.count, 20);
  assert.equal(captured.styleEntry.scene.count, 12);
  assert.equal(captured.traces.length, 2, '当天 traces 读进来');
  assert.equal(captured.lessons.length, 3);
});
