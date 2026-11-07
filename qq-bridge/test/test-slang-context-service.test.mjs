// slang-context-service 金标：抽取排队的冷却/紧急策略、窗口进料过滤、提交限频、公开条目不漏证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlangContext } from '../src/domain/social/slang-context-service.mjs';

function makeCtx(overrides = {}) {
  const state = { queued: [], logs: [], entries: [] };
  const windows = new Map();
  const policy = new Map();
  const cooldowns = new Map();
  const submits = new Map();
  const svc = createSlangContext({
    cfg: { slang: { enabled: true, extractMinMessages: 3, extractCooldownMs: 300000, injectMax: 8 } },
    getSlangEntries: () => state.entries,
    slangWindows: windows,
    log: (m) => state.logs.push(String(m)),
    truncateText: (s, n) => (s.length > n ? s.slice(0, n) : s),
    renderTimeLine: () => '现在是 2026-11-02 18:00 晚上',
    queueSlangTask: (fn) => { state.queued.push(fn); },
    getDshReady: () => true,
    slangPolicyState: policy,
    slangExtractionCooldowns: cooldowns,
    slangSubmitTimes: submits,
    decideSlangExtraction: () => ({ extract: false }),
    hasUrgentSignal: () => false,
    runSlangExtraction: () => { state.ran = true; },
    buildSlangContext: () => '【黑话】绷不住=忍不住',
    ...overrides,
  });
  return { svc, state, windows, policy, cooldowns, submits };
}

test('maybeQueueSlangExtraction：关开关 / DSH 未就绪 / 消息不够都不排队', () => {
  const off = makeCtx({ cfg: { slang: { enabled: false } } });
  off.svc.maybeQueueSlangExtraction('group:1');
  assert.equal(off.state.queued.length, 0);

  const notReady = makeCtx({ getDshReady: () => false });
  notReady.svc.maybeQueueSlangExtraction('group:1');
  assert.equal(notReady.state.queued.length, 0);

  const few = makeCtx();
  few.windows.set('group:1', [{ text: 'a' }]);
  few.svc.maybeQueueSlangExtraction('group:1');
  assert.equal(few.state.queued.length, 0, '低于 minMessages 不排队');
});

test('maybeQueueSlangExtraction：决策通过才写策略/冷却并排队', () => {
  const h = makeCtx({ decideSlangExtraction: () => ({ extract: true, reason: 'normal', next: { hourCount: 1 } }) });
  h.windows.set('group:1', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  h.svc.maybeQueueSlangExtraction('group:1');
  assert.equal(h.state.queued.length, 1);
  assert.deepEqual(h.policy.get('group:1'), { hourCount: 1 });
  assert.ok(h.cooldowns.get('group:1') > 0);
  h.state.queued[0]();
  assert.equal(h.state.ran, true);
});

test('maybeQueueSlangExtraction：紧急信号要留日志；决策不通过则不动状态', () => {
  const urgent = makeCtx({
    hasUrgentSignal: () => true,
    decideSlangExtraction: () => ({ extract: true, reason: 'urgent', next: {} }),
  });
  urgent.windows.set('group:1', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  urgent.svc.maybeQueueSlangExtraction('group:1');
  assert.ok(urgent.state.logs.some((l) => l.includes('有生词信号，提前提取')));

  const no = makeCtx();
  no.windows.set('group:1', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  no.svc.maybeQueueSlangExtraction('group:1');
  assert.equal(no.policy.size, 0);
  assert.equal(no.state.queued.length, 0);
});

test('feedSlangWindow：命令/角色控制语不进窗口，长文本截断，窗口上限 80', () => {
  const h = makeCtx();
  h.svc.feedSlangWindow('group:1', 'A', '/help');
  h.svc.feedSlangWindow('group:1', 'A', '进入角色扮演');
  h.svc.feedSlangWindow('group:1', 'A', '   ');
  h.svc.feedSlangWindow('group:1', 'A', 123);
  assert.equal(h.windows.has('group:1'), false, '这些都不该进窗');

  h.svc.feedSlangWindow('group:1', 'A', '绷'.repeat(300));
  const win = h.windows.get('group:1');
  assert.equal(win.length, 1);
  assert.equal(win[0].text.length, 200, '进窗截断 200');
  assert.equal(win[0].sender, 'A');

  for (let i = 0; i < 100; i += 1) h.svc.feedSlangWindow('group:1', 'B', `第${i}条`);
  assert.equal(h.windows.get('group:1').length, 80, '窗口上限 80');
});

test('allowSlangSubmit：每秒/每小时双限频', () => {
  const h = makeCtx();
  assert.equal(h.svc.allowSlangSubmit('group:1'), true);
  assert.equal(h.svc.allowSlangSubmit('group:1'), true);
  assert.equal(h.svc.allowSlangSubmit('group:1'), false, '每分钟 2 条');
  const now = Date.now();
  h.submits.set('group:2', Array.from({ length: 10 }, () => now - 2 * 60 * 1000));
  assert.equal(h.svc.allowSlangSubmit('group:2'), false, '每小时 10 条');
  h.submits.set('group:3', Array.from({ length: 10 }, () => now - 2 * 60 * 60 * 1000));
  assert.equal(h.svc.allowSlangSubmit('group:3'), true, '过期记录被清掉');
});

test('publicSlangEntry：只给安全展示字段，绝不带 evidence（跨群泄露）', () => {
  const h = makeCtx();
  const out = h.svc.publicSlangEntry({
    id: 'x1', content: '绷不住', meaning: '忍不住', evidence: [{ key: 'group:9', text: '别的群原话' }],
    status: 'candidate', count: 3, agentConfirmedAt: '2026-11-01',
  });
  assert.equal(out.content, '绷不住');
  assert.equal(out.evidence, undefined);
  assert.equal(out.agentConfirmedAt, '2026-11-01');
  assert.equal(h.svc.publicSlangEntry(null).status, 'candidate', '未知状态给 candidate');
  assert.equal(h.svc.publicSlangEntry({}).count, 0);
});

test('confirmedSlangListV2：只要 confirmed 且有释义，按出现次数降序、受 injectMax 限制', () => {
  const h = makeCtx();
  h.state.entries = [
    { content: 'A', meaning: 'a', status: 'confirmed', count: 1 },
    { content: 'B', meaning: 'b', status: 'confirmed', count: 9 },
    { content: 'C', meaning: 'c', status: 'candidate', count: 99 },
    { content: 'D', meaning: '', status: 'confirmed', count: 5 },
  ];
  const list = h.svc.confirmedSlangListV2();
  assert.deepEqual(list.map((e) => e.content), ['B', 'A']);
  const capped = makeCtx({ cfg: { slang: { injectMax: 1 } } });
  capped.state.entries = h.state.entries;
  assert.equal(capped.svc.confirmedSlangListV2().length, 1);
});

test('withSlangContext：时间行 + 黑话块 + 正文；关掉黑话就只留时间行', () => {
  const h = makeCtx();
  const text = h.svc.withSlangContext('这是正文');
  assert.ok(text.startsWith('现在是 2026-11-02 18:00 晚上'));
  assert.ok(text.includes('【黑话】'));
  assert.ok(text.endsWith('这是正文'));
  const off = makeCtx({ cfg: { slang: { enabled: false } } });
  assert.ok(!off.svc.withSlangContext('正文').includes('【黑话】'));
});
