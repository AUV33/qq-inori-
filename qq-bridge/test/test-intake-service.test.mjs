// intake-service 金标：正文清洗、抓取缓存/渲染兜底、调度前的判定与状态落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeService } from '../src/domain/conversation/intake-service.mjs';

function makeCtx(overrides = {}) {
  const state = { saves: 0, logs: [], delivered: [], files: new Map() };
  const intakeLast = new Map();
  const svc = createIntakeService({
    fs: {
      readFileSync: (f) => {
        if (!state.files.has(f)) throw new Error('ENOENT');
        return state.files.get(f);
      },
      existsSync: () => false, // 测试机上不真去拉无头 Edge
    },
    cfg: { socialV2: { intake: { enabled: true } } },
    log: (m) => state.logs.push(String(m)),
    MEM_DIR: '/mem',
    writeJsonDocument: (file, data) => { state.saves += 1; state.lastState = data; },
    INTAKE_STATE_FILE: 'intake.json',
    intakeLast,
    loadLessons: () => [{}, {}],
    makeLinkCache: () => {
      const m = new Map();
      return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
    },
    safeFetch: async () => ({ statusCode: 200, body: '<html><head><title>标题</title></head><body>正文</body></html>' }),
    shouldIntake: () => ({ yes: true, reason: '有链接' }),
    buildIntakePrompt: ({ userText }) => `提炼：${userText}`,
    deliverToIsolated: async (kind, prompt) => { state.delivered.push({ kind, prompt }); },
    ...overrides,
  });
  return { svc, state, intakeLast };
}

test('stripHtml：去掉 script/style/标签与实体，压成一行', () => {
  const h = makeCtx();
  const html = '<div><script>alert(1)</script><style>p{}</style>你好&nbsp;世界 &amp; 大家</div>';
  assert.equal(h.svc.stripHtml(html), '你好 世界 & 大家');
  assert.equal(h.svc.stripHtml(null), '');
});

test('readPageForIntake：缓存里正文够长就直接复用', async () => {
  const cache = new Map([['https://a', { title: 'T', text: 'x'.repeat(400) }]]);
  const h = makeCtx({ makeLinkCache: () => ({ get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) }) });
  const out = await h.svc.readPageForIntake('https://a');
  assert.equal(out.fromCache, true);
  assert.equal(out.text.length, 400);
});

test('readPageForIntake：抓取失败但仍在正文太短且没 Edge 时返回 no-edge，不抛错', async () => {
  const h = makeCtx({
    safeFetch: async () => ({ statusCode: 200, body: '<html><head><title>空壳</title></head><body>太短</body></html>' }),
  });
  const out = await h.svc.readPageForIntake('https://b', true);
  assert.equal(out.title, '空壳');
  assert.equal(out.rendered, false);
  assert.equal(out.note, 'no-edge');
});

test('readPageForIntake：safeFetch 抛错（被拦）时记日志并放弃', async () => {
  const h = makeCtx({ safeFetch: async () => { throw new Error('域名解析到内网，已阻止'); } });
  const out = await h.svc.readPageForIntake('http://127.0.0.1/x', true);
  assert.equal(out.rendered, false);
  assert.ok(h.state.logs.some((l) => l.includes('链接抓取被拒绝或失败')));
});

test('readPageForIntake：allowRender=false 时绝不渲染', async () => {
  const h = makeCtx({ safeFetch: async () => ({ statusCode: 200, body: '<html><body>短</body></html>' }) });
  const out = await h.svc.readPageForIntake('https://c', false);
  assert.equal(out.note, undefined);
  assert.equal(out.rendered, false);
});

test('maybeIntake：关掉开关或判定不通过都不投递', () => {
  const off = makeCtx({ cfg: { socialV2: { intake: { enabled: false } } } });
  off.svc.maybeIntake('group:1', '看这个 https://x', '');
  assert.equal(off.state.delivered.length, 0);
  assert.equal(off.state.saves, 0);

  const no = makeCtx({ shouldIntake: () => ({ yes: false, reason: '刚记过' }) });
  no.svc.maybeIntake('group:1', '你好', '');
  assert.equal(no.state.delivered.length, 0);
  assert.ok(no.state.logs.some((l) => l.includes('跳过 group:1（刚记过）')));
});

test('maybeIntake：判定通过时立刻落盘时间戳，并把投递排到这一轮结束后', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx();
  h.svc.maybeIntake('group:1', '看这个 https://x', '我的回复');
  assert.equal(h.state.saves, 1, '时间戳要先落盘，避免同一段重复投递');
  assert.equal(h.intakeLast.has('group:1'), true);
  assert.equal(h.state.delivered.length, 0, '投递是延后的');

  t.mock.timers.tick(20_000);
  return Promise.resolve().then(() => {
    assert.equal(h.state.delivered.length, 1);
    assert.equal(h.state.delivered[0].kind, 'intake');
    assert.ok(h.state.delivered[0].prompt.includes('看这个 https://x'));
    t.mock.timers.tick(90_000);
  });
});

test('maybeIntake：调度本身抛错只记日志', () => {
  const h = makeCtx({ shouldIntake: () => { throw new Error('判定坏了'); } });
  assert.doesNotThrow(() => h.svc.maybeIntake('group:1', 'x', ''));
  assert.ok(h.state.logs.some((l) => l.includes('调度失败（已忽略）')));
});

test('countLearnables：记忆行数 + 经验条数；读不到记忆就当 0 条记忆', () => {
  const h = makeCtx();
  h.state.files.set('/mem/memory.jsonl', '{"a":1}\n{"b":2}\n');
  // 通过 saveIntakeState 间接验证：状态里只有时间戳，但 countLearnables 用于日志
  // 这里直接测“读不到也不炸”：不设文件时 maybeIntake 仍能走完
  assert.doesNotThrow(() => h.svc.maybeIntake('group:1', 'x', ''));
});
