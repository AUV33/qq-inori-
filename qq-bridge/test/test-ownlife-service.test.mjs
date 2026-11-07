// ownlife-service 的接线金标：默认值透传、生活门、deliver 前置条件、掉地愿望去重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnLifeService } from '../src/domain/social/ownlife-service.mjs';

function ctx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ownlife-'));
  let captured = null;
  let appended = 0;
  const state = {
    paused: false,
    mode: 'reserved2',
    life: { awake: true },
    drowsy: 0,
    lastPhone: 0,
  };
  const base = {
    fs, path,
    cfg: { ownerQQ: 12345, ownLife: {} },
    log: () => {},
    STATE_DIR: dir,
    MEM_DIR: dir,
    createOwnLife: (opts) => { captured = opts; return { start() {}, stop() {} }; },
    mayOwnWake: () => state.life.awake,
    drowsinessOf: () => state.drowsy,
    getLifeState: () => state.life,
    getLastPhoneOpAt: () => state.lastPhone,
    socialV2: { get paused() { return state.paused; } },
    getCurrentMode: () => state.mode,
    getSocialV2State: () => ({ recentMessages: [] }),
    loadGoals: () => [],
    loadLessons: () => [],
    filesForScope: () => ({ file: path.join(dir, 'memory.jsonl'), scope: 'private' }),
    summarizeRelationship: () => ({}),
    requireMemoryEntries: () => [],
    openCuriosityLoops: () => [],
    buildAutonomyPrompt: () => '',
    renderRelationship: () => '',
    lifeTimePre: () => '',
    ruminationPre: () => '',
    drainUnsentHints: () => {},
    renderUnsentLine: () => null,
    quantSnapshotLine: () => null,
    renderAgencyBlock: () => '',
    loadDayPlan: () => ({ items: [] }),
    renderIntentionCandidates: () => '',
    buildIntentionCandidates: () => [],
    openWishItems: () => [],
    loadWishState: () => ({}),
    appendJsonl: (file, row) => { appended += 1; fs.appendFileSync(file, JSON.stringify(row) + "\n"); },
    deliverToIsolated: async () => {},
    dispatchOwnlifeUnified: () => {},
    isConversationBusyV2: () => false,
    isSessionAllowedInCurrentMode: () => true,
    boredomOf: () => 0,
    markInterest: () => {},
    dueWishes: () => [],
    markWishRun: () => {},
    pendingJudgeList: () => [],
    findUnknownTerms: () => [],
    renderUnknownTerms: () => '',
    loadSlang: () => [],
    renderSlangJudgeLine: () => '',
    sedimentBrowseIfAny: () => {},
    renderWanderNudge: () => '',
    saveLifeFile: () => {},
    saveWishState: () => {},
    sendWakePromptV2: async () => {},
    renderLifeLine: () => '',
    renderCuriosityLine: () => '',
  };
  Object.assign(base, overrides);
  return {
    ctx: base,
    state,
    get captured() { return captured; },
    get appended() { return appended; },
    dir,
  };
}

test('没有 ownerQQ / 配置关闭：不创建 ownLife', () => {
  for (const cfg of [{ ownerQQ: null, ownLife: {} }, { ownerQQ: 12345, ownLife: { enabled: false } }]) {
    const h = ctx({ cfg });
    createOwnLifeService(h.ctx).startOwnLife();
    assert.equal(h.captured, null);
  }
});

test('生活门：睡着/犯困/正忙/正常', () => {
  const h = ctx();
  createOwnLifeService(h.ctx).startOwnLife();
  const gate = h.captured.getLifeGate;
  h.state.life = { awake: false };
  assert.equal(gate(), 'sleeping');
  h.state.life = { awake: true };
  h.state.drowsy = 0.8;
  assert.equal(gate(), 'drowsy');
  h.state.drowsy = 0;
  h.state.lastPhone = Date.now();
  assert.equal(gate(), 'in-progress');
  h.state.lastPhone = 0;
  assert.equal(gate(), 'ok');
});

test('配置透传：maxPerDay=0 保留、minPerDay 默认 2、路径在 state 下', () => {
  const h = ctx({ cfg: { ownerQQ: 12345, ownLife: { maxPerDay: 0 } } });
  createOwnLifeService(h.ctx).startOwnLife();
  assert.equal(h.captured.maxPerDay, 0);
  assert.equal(h.captured.minPerDay, 2);
  assert.equal(h.captured.key, 'private:12345');
  assert.ok(h.captured.statePath.endsWith('own-life.json'));
  assert.ok(h.captured.rhythmPath.endsWith('own-life-rhythm.json'));
  assert.equal(h.captured.isBusy(), false);
});

test('deliver：暂停或非 reserved2 时拒绝', async () => {
  const h = ctx();
  createOwnLifeService(h.ctx).startOwnLife();
  h.state.paused = true;
  await assert.rejects(h.captured.deliver('x'), /暂停/);
  h.state.paused = false;
  h.state.mode = 'chat';
  await assert.rejects(h.captured.deliver('x'), /reserved2/);
});

test('onDrop：24h 内同类"没去成"只写一条', async () => {
  const h = ctx();
  createOwnLifeService(h.ctx).startOwnLife();
  await h.captured.onDrop({ at: Date.now(), count: 3, total: 3 });
  assert.equal(h.appended, 1);
  await h.captured.onDrop({ at: Date.now(), count: 3, total: 4 });
  assert.equal(h.appended, 1);
});

// ── 拼装与三条节拍（free-tick / self-wake / boredom）────────────────────────
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

function withCalls(overrides = {}) {
  const calls = { dispatched: [], wakes: [], logs: [], base: null };
  const h = ctx({
    getDshReady: () => true,
    getSlangEntries: () => [{ content: '绷不住' }],
    getBrowseStore: () => ({ entries: [] }),
    dispatchOwnlifeUnified: async (reason, text) => { calls.dispatched.push({ reason, text }); return true; },
    sendWakePromptV2: async (key, reason) => { calls.wakes.push({ key, reason }); },
    buildAutonomyPrompt: () => '自主',
    renderRelationship: () => '关系',
    lifeTimePre: () => '生活',
    ruminationPre: () => '反刍',
    renderUnsentLine: () => '未送',
    quantSnapshotLine: () => '净值',
    renderAgencyBlock: () => '能动',
    renderIntentionCandidates: () => '候选',
    loadDayPlan: () => ({ items: [] }),
    ...overrides,
    log: (m) => calls.logs.push(String(m)),
  });
  h.calls = calls;
  return h;
}

test('deliver：拼装顺序固定，正文永远在最后', async () => {
  const h = withCalls();
  createOwnLifeService(h.ctx).startOwnLife();
  await h.captured.deliver('正文');
  const text = h.calls.dispatched[0].text;
  assert.ok(text.indexOf('自主') < text.indexOf('关系'));
  assert.ok(text.indexOf('关系') < text.indexOf('生活'));
  assert.ok(text.indexOf('生活') < text.indexOf('反刍'));
  assert.ok(text.indexOf('候选') < text.indexOf('未送'));
  assert.ok(text.endsWith('正文'), '正文放最后，前面都是上下文');
  assert.equal(h.calls.dispatched[0].reason, 'own-life');
});

test('deliver：生词行与黑话判定队列插到最前面（先看到要学的词）', async () => {
  const h = withCalls({
    findUnknownTerms: () => [{ term: '绷不住' }],
    renderUnknownTerms: (list) => (list.length ? `【生词】${list.map((x) => x.term).join('、')}` : ''),
    renderSlangJudgeLine: () => '【黑话判定】2 词',
  });
  createOwnLifeService(h.ctx).startOwnLife();
  await h.captured.deliver('正文');
  const text = h.calls.dispatched[0].text;
  assert.ok(text.indexOf('【生词】') < text.indexOf('自主'));
  assert.ok(text.indexOf('【黑话判定】') < text.indexOf('自主'));
  assert.ok(h.calls.logs.some((l) => l.includes('待查 1 个词')));
});

test('deliver：闲逛提示置顶；上下文构建抛错也照常投递基础提示', async () => {
  const wander = withCalls({ renderWanderNudge: () => '【闲逛】上次逛是 3 天前' });
  createOwnLifeService(wander.ctx).startOwnLife();
  await wander.captured.deliver('正文');
  assert.ok(wander.calls.dispatched[0].text.startsWith('【闲逛】'));

  const broken = withCalls({ buildAutonomyPrompt: () => { throw new Error('拼装坏了'); } });
  createOwnLifeService(broken.ctx).startOwnLife();
  await broken.captured.deliver('正文');
  assert.equal(broken.calls.dispatched.length, 1, '一个块坏了不能吞掉她整段独处时间');
  assert.equal(broken.calls.dispatched[0].text, '正文');
  assert.ok(broken.calls.logs.some((l) => l.includes('上下文构建失败')));
});

test('free-tick：模式不对 / DSH 未就绪 / 睡着 / 有未读 都不触发', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const notReserved = withCalls({ cfg: { ownerQQ: 12345, ownLife: {}, socialV2: { freeTick: { probability: 1, intervalMs: 60000, minGapMs: 300000 } } } });
  notReserved.state.mode = 'chat';
  createOwnLifeService(notReserved.ctx).startOwnLife();
  t.mock.timers.tick(60000); await flush();
  assert.equal(notReserved.calls.dispatched.filter((d) => d.reason === 'free-tick').length, 0);

  const notReady = withCalls({ cfg: { ownerQQ: 12345, ownLife: {}, socialV2: { freeTick: { probability: 1, intervalMs: 60000, minGapMs: 300000 } } }, getDshReady: () => false });
  createOwnLifeService(notReady.ctx).startOwnLife();
  t.mock.timers.tick(60000); await flush();
  assert.equal(notReady.calls.dispatched.filter((d) => d.reason === 'free-tick').length, 0);

  const asleep = withCalls({ cfg: { ownerQQ: 12345, ownLife: {}, socialV2: { freeTick: { probability: 1, intervalMs: 60000, minGapMs: 300000 } } } });
  asleep.state.life = { awake: true, state: 'sleep' };
  createOwnLifeService(asleep.ctx).startOwnLife();
  t.mock.timers.tick(60000); await flush();
  assert.equal(asleep.calls.dispatched.filter((d) => d.reason === 'free-tick').length, 0, '睡着不吵她');

  const unread = withCalls({
    cfg: { ownerQQ: 12345, ownLife: {}, socialV2: { freeTick: { probability: 1, intervalMs: 60000, minGapMs: 300000 } } },
    getSocialV2State: () => ({ recentMessages: [], unread: [{ seq: 1 }] }),
  });
  createOwnLifeService(unread.ctx).startOwnLife();
  t.mock.timers.tick(60000); await flush();
  assert.equal(unread.calls.dispatched.filter((d) => d.reason === 'free-tick').length, 0, '有人找她先回人');
});

test('free-tick：过概率门才投递，且受每小时上限约束', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = withCalls({ cfg: { ownerQQ: 12345, ownLife: {}, socialV2: { freeTick: { probability: 1, intervalMs: 60000, minGapMs: 300000, maxPerHour: 2 } } } });
  createOwnLifeService(h.ctx).startOwnLife();
  for (let i = 0; i < 40; i += 1) { t.mock.timers.tick(60000); await flush(); }
  const ticks = h.calls.dispatched.filter((d) => d.reason === 'free-tick');
  assert.ok(ticks.length >= 1, '应该给过自己的时间');
  assert.ok(ticks.length <= 2, '每小时最多 2 次');
  assert.ok(h.calls.logs.some((l) => l.includes('[free-tick]')));
});

test('self-wake：到点愿望叫醒；会话忙就顺延不硬插', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let wishState = { items: [{ id: 'w1' }] };
  const h = withCalls({
    dueWishes: () => (wishState.items.length ? [{ id: 'w1', key: 'group:1', wish: '去群里说句话' }] : []),
    markWishRun: (state, ids) => { wishState = { ...state, items: state.items.filter((x) => !ids.includes(x.id)) }; return wishState; },
    loadWishState: () => wishState,
    saveWishState: (s) => { wishState = s; },
  });
  createOwnLifeService(h.ctx).startOwnLife();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(30000); await flush(); }
  assert.equal(h.calls.wakes.length, 1, '叫醒一次后 runAt 归零，不该反复叫');
  assert.equal(h.calls.wakes[0].reason, 'selfWake');
  assert.equal(h.calls.wakes[0].key, 'group:1');

  const busy = withCalls({ dueWishes: () => [{ id: 'w1', key: 'group:1', wish: 'x' }], isConversationBusyV2: () => true });
  createOwnLifeService(busy.ctx).startOwnLife();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(30000); await flush(); }
  assert.equal(busy.calls.wakes.length, 0, '她正忙就顺延');
});

test('boredom：无聊不够 / 困 / 正忙活 都不投递；够了才投递并累加计数', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  // [FIX-FLAKY] 无聊轮有「安静时段 03:00–08:00 不闹」的规则：不钉时钟的话这条用例
  // 白天过、凌晨稳定红（实测 03:0x 跑必失败）。钉到白天 14:00 再跑，判定才只看无聊/困/忙。
  t.mock.timers.setTime(Date.parse('2026-11-03T14:00:00+08:00'));
  const low = withCalls({ boredomOf: () => 0.2 });
  createOwnLifeService(low.ctx).startOwnLife();
  t.mock.timers.tick(300000); await flush();
  assert.equal(low.calls.dispatched.filter((d) => d.reason === 'boredom').length, 0);

  const drowsy = withCalls({ boredomOf: () => 0.9, drowsinessOf: () => 0.9 });
  createOwnLifeService(drowsy.ctx).startOwnLife();
  t.mock.timers.tick(300000); await flush();
  assert.equal(drowsy.calls.dispatched.filter((d) => d.reason === 'boredom').length, 0, '困了该睡不是找事');

  const ready = withCalls({ boredomOf: () => 0.9 });
  createOwnLifeService(ready.ctx).startOwnLife();
  t.mock.timers.tick(300000); await flush();
  const rounds = ready.calls.dispatched.filter((d) => d.reason === 'boredom');
  assert.equal(rounds.length, 1);
  assert.ok(rounds[0].text.includes('【无聊轮】'));
  assert.ok(ready.state.life.boreCount >= 1, '计数要写回状态');
});
