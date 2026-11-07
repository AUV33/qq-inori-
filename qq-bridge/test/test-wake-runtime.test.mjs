// wake-runtime 金标：调度器/发送器的懒构造、依赖快照接线、模式读取不冻结。
//
// 模块本身只负责「构造 + 传依赖」，所以断言集中在：单例语义、返回面、传入的闭包是否按预期
// 读取运行态（getCurrentMode / getSocialV2State / buildFreedomPolicy）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeRuntime } from '../src/domain/conversation/wake-runtime.mjs';

function makeRuntime(overrides = {}) {
  const calls = {
    logs: [],
    freedom: [],
    memoryExtract: [],
    delivered: [],
    synced: 0,
  };
  let mode = 'reserved2';
  const st = { recentMessages: [{ text: 'hi' }], proactiveTimer: null };
  const cfg = {
    ownerQQ: 10001,
    socialV2: { enabled: true, proactive: { enabled: true, probability: 0.5 } },
  };
  const deps = {
    FOCUS_SLOTS: 6,
    SAFE_INJECTION_CAPS: {},
    STATE_DATA_DIR: '/state',
    TOOL_LOG_FILE: '/state/tools.jsonl',
    UNDELIVERED_FILE: '/state/undelivered.json',
    activityTracker: {},
    addressedJudgmentLine: () => '',
    applyReplyPace: async () => {},
    appraiseValence: () => 0,
    armAtSplit: () => {},
    armPendingWakeLease: () => {},
    armWakeRetryForPending: () => {},
    behaviorDigestRow: () => ({}),
    budgetWarnings: () => [],
    buildFreedomPolicy: (opts) => {
      calls.freedom.push(opts);
      return { initiate: { can: false, reason: 'budget-exhausted' } };
    },
    buildLinkDigest: () => '',
    buildRecallQuery: () => '',
    buildSelfModel: () => ({}),
    buildWakePromptV2: () => 'PROMPT',
    cancelReplyCheckV2: () => {},
    cfg,
    chaseAdaptMax: 2,
    chaseState: {},
    classifyTopic: () => '',
    cleanText: (s) => String(s),
    cognition: {},
    compactInjection: { blocks: [], added: [] },
    composeSelfSnapshot: () => '',
    computeGroupHabits: () => ({}),
    computeProactivity: () => 0.5,
    computeStyleStats: () => ({}),
    decideMood: () => ({}),
    deliverPrompt: async (...args) => { calls.delivered.push(args); return { ok: true }; },
    describeStyle: () => '',
    disarmPendingWakeLease: () => {},
    enforceInjectionBudget: (s) => s,
    ensureRerank: async () => {},
    ensureWakeableV2: () => {},
    evaluateStyle: () => ({}),
    expireGoals: () => [],
    expireLessons: () => [],
    extractLinks: () => [],
    findSkills: () => [],
    formatBudgetLine: () => '',
    fs: { readFileSync: () => '[]', existsSync: () => false },
    getLifeState: () => ({ state: 'awake' }),
    getSocialV2State: () => st,
    readTuning: () => ({}),
    groupFeedbackRate: () => 0,
    groupMutedUntil: async () => 0,
    inferLessonTrigger: () => null,
    isConversationBusyV2: () => false,
    isSameLocalDay: () => false,
    isSessionAllowedInCurrentMode: () => true,
    lessonPendingByKey: () => null,
    listUndelivered: () => [],
    loadFocus: () => ({}),
    loadGoals: () => [],
    loadLessons: () => [],
    loadMoodState: () => ({}),
    loadSkills: () => [],
    log: (m) => { calls.logs.push(String(m)); },
    logAction: () => {},
    mergeBlocks: (s) => s,
    moodLine: () => '',
    muteWakeSkipped: new Set(),
    noteSkillInjected: () => {},
    paceBatchMs: () => 0,
    path: { join: (a, b) => `${a}/${b}` },
    pendingWakeKeys: new Set(),
    pickTalkingPeers: () => [],
    prepareAffectHint: async () => {},
    questionHint: () => '',
    readJsonlSafe: () => [],
    readPageForIntake: async () => null,
    recallBlock: () => '',
    recordFloorDecision: () => {},
    renderBehaviorLedger: () => '',
    renderBehaviorLogLine: () => '',
    renderCoreFacts: () => '',
    renderFocusBlock: () => '',
    renderGoalIdeas: () => '',
    renderGoals: () => '',
    renderGraphLine: () => '',
    renderGroupHabits: () => '',
    renderInsightHints: () => '',
    renderKnowledgeCandidates: () => '',
    renderLearningWritesLine: () => '',
    renderLedger: () => '',
    renderLessons: () => '',
    renderMembers: () => '',
    renderPeerBotLine: () => '',
    renderQuoteContext: () => '',
    renderSelfModel: () => '',
    renderSelfProfile: () => '',
    renderSelfRecentBlock: () => '',
    renderSelfTrend: () => '',
    renderSkillCandidateLine: () => '',
    renderThoughts: () => '',
    renderTraceHint: () => '',
    renderUndeliveredLine: () => '',
    renderWorksLine: () => '',
    retireSession: () => {},
    rewriteLessons: async () => [],
    runMemoryExtractV2: async (...args) => { calls.memoryExtract.push(args); },
    saveGoals: () => {},
    saveMoodState: () => {},
    saveSkills: () => {},
    saveSocialV2State: () => {},
    sedimentGroupMemoryIfStale: () => {},
    selectLessonsForContext: () => [],
    sendWakePromptV2: async () => {},
    setupSleepTimerV2: () => {},
    shouldWake: () => true,
    sinkUnsentHint: () => {},
    socialGraph: { nodes: new Map(), edges: [] },
    socialV2: { paused: false, conversations: new Map() },
    stampReplyPace: () => ({}),
    state: { sessions: {} },
    stateDataPath: (x) => `/state/${x}`,
    stateWithKey: (k) => ({ k }),
    stripUrls: (s) => s,
    summarizeBehavior: () => '',
    summarizeLearningWrites: () => '',
    summarizePrompt: () => ({ blocks: [], blockCount: 0 }),
    summarizeSelfTrend: () => '',
    takeDeviceBlockedLine: () => '',
    targetFromScene: () => null,
    tickMood: () => ({}),
    toolCallLogFile: '/state/tools.jsonl',
    touchLesson: () => {},
    undeliveredFile: '/state/undelivered.json',
    wakePriorityV2: () => 0,
    wakeRetryCounts: new Map(),
    wakeRetryTimers: new Map(),
    worksStore: {},
    getCurrentMode: () => mode,
    ...(overrides.deps ?? {}),
  };
  const rt = createWakeRuntime(deps);
  return { rt, deps, calls, st, cfg, setMode: (m) => { mode = m; } };
}

// ── 懒构造/单例 ───────────────────────────────────────────────────────────
test('getWakeScheduler：懒构造一次，返回面只有三个调度方法', () => {
  const h = makeRuntime();
  const first = h.rt.getWakeScheduler();
  const second = h.rt.getWakeScheduler();
  assert.equal(first, second, '同一运行时复用同一个调度器');
  assert.deepEqual(Object.keys(first).sort(), ['armWakeRetryForPending', 'scheduleProactiveCheckV2', 'scheduleWakeV2']);
});

test('getWakeSender：懒构造一次，返回面只有 sendWakePromptV2；与调度器互不影响', () => {
  const h = makeRuntime();
  const sched = h.rt.getWakeScheduler();
  const sender = h.rt.getWakeSender();
  assert.equal(h.rt.getWakeSender(), sender);
  assert.deepEqual(Object.keys(sender), ['sendWakePromptV2']);
  assert.notEqual(sender, sched);
  // 两个运行时实例互不共享实例
  const other = makeRuntime();
  assert.notEqual(other.rt.getWakeSender(), sender);
  assert.notEqual(other.rt.getWakeScheduler(), sched);
});

test('依赖快照在构造时取：cfg/socialV2 是原地可变的同一对象', () => {
  const h = makeRuntime();
  const sender = h.rt.getWakeSender();
  assert.equal(h.deps.cfg, h.cfg);
  h.cfg.socialV2.enabled = false;
  // 关掉社交后 sender 的第一行就会返回（不会调用 deliverPrompt）
  return sender.sendWakePromptV2('group:1', 'atMention').then(() => {
    assert.equal(h.calls.delivered.length, 0);
    assert.equal(h.calls.memoryExtract.length, 1, '唤醒时先触发记忆沉淀（后台）');
  });
});

// ── 发送器的运行态读取 ────────────────────────────────────────────────────
test('sendWakePromptV2：模式不是 reserved2 时直接返回（构造后改模式要能生效）', async () => {
  const h = makeRuntime();
  const sender = h.rt.getWakeSender();
  h.setMode('chat');
  await sender.sendWakePromptV2('group:1', 'atMention');
  assert.equal(h.calls.delivered.length, 0);
  assert.equal(h.calls.memoryExtract.length, 1);
});

test('sendWakePromptV2：socialV2.paused 时直接返回', async () => {
  const h = makeRuntime();
  const sender = h.rt.getWakeSender();
  h.deps.socialV2.paused = true;
  await sender.sendWakePromptV2('group:1', 'atMention');
  assert.equal(h.calls.delivered.length, 0);
});

test('scheduleWakeV2：社交总开关关闭时静默返回', () => {
  const h = makeRuntime();
  h.cfg.socialV2.enabled = false;
  const sched = h.rt.getWakeScheduler();
  assert.doesNotThrow(() => sched.scheduleWakeV2('group:1', 'atMention'));
  assert.equal(h.calls.logs.length, 0);
});

test('scheduleWakeV2：会话暂停（socialV2.paused）时静默返回', () => {
  const h = makeRuntime();
  h.deps.socialV2.paused = true;
  const sched = h.rt.getWakeScheduler();
  assert.doesNotThrow(() => sched.scheduleWakeV2('group:1', 'atMention'));
  assert.equal(h.calls.logs.length, 0);
});

test('scheduleWakeV2：模式不允许的会话记一行 reserved2 日志后返回', () => {
  const h = makeRuntime({
    deps: {
      isSessionAllowedInCurrentMode: (key) => key !== 'group:9',
    },
  });
  const sched = h.rt.getWakeScheduler();
  sched.scheduleWakeV2('group:9', 'atMention');
  assert.ok(h.calls.logs.some((l) => l.includes('[reserved2] 跳过计划唤醒 group:9（atMention）：会话已不在当前模式允许范围内')));
});

// ── 自由预算 ──────────────────────────────────────────────────────────────
// [BUG] wake-runtime.mjs:166 —— `ownerQQ: cfg.cfg.ownerQQ` 读错层：app 传进来的 cfg 就是
// loadConfig().cfg（没有 .cfg 字段），于是 getFreedomPolicy 每次调用都抛
// TypeError("Cannot read properties of undefined (reading 'ownerQQ')")，
// 而 wake-schedule.mjs:334 的 best-effort catch 把它吞掉 → 主动预算闸门从未生效。
test('scheduleProactiveCheckV2：主动预算耗尽时应向 buildFreedomPolicy 取策略并跳过排程', (t) => {
  const h = makeRuntime();
  t.after(() => { if (h.st.proactiveTimer) clearTimeout(h.st.proactiveTimer); });
  const sched = h.rt.getWakeScheduler();
  sched.scheduleProactiveCheckV2('group:1');

  assert.equal(
    h.calls.freedom.length,
    1,
    `getFreedomPolicy 应被调用一次（实际 ${h.calls.freedom.length} 次）——wake-runtime.mjs:166 的 cfg.cfg.ownerQQ 会抛 TypeError 被 wake-schedule.mjs:334 吞掉；日志：${h.calls.logs.join(' | ')}`,
  );
  assert.deepEqual(h.calls.freedom[0], {
    key: 'group:1',
    mode: 'reserved2',
    ownerQQ: h.cfg.ownerQQ,
    cfg: h.cfg,
    state: h.st,
  }, 'buildFreedomPolicy 的入参要来自运行态（ownerQQ 应从 cfg 顶层取）');
  assert.ok(h.calls.logs.some((l) => l.includes('[freedom] group:1 跳过主动检查：budget-exhausted')));
  assert.ok(!h.st.proactiveTimer, '预算耗尽就不排主动检查定时器');
});
