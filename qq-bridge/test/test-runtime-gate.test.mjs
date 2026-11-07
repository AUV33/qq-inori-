// runtime-gate 金标（运行态）：embedding 探测/批量向量、锚点与命名、门循环的粗筛→精判链路、命中处理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateService } from '../src/domain/conversation/runtime-gate.mjs';

const NOW = 1_800_000_000_000;

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gate-'));
  const out = { logs: [], wakes: [], delivered: [], follows: [], saves: 0, fetchCalls: [] };
  const conv = overrides.conversations ?? new Map();
  const deps = {
    cfgRef: {
      gate: { embedPort: 8790, embedBatch: 2, cosThreshold: 0.6, keepLogLines: 50 },
      socialV2: { gate: { local3bFirst: false }, goals: { file: 'goals.json' }, memory: {} },
      ...(overrides.cfgExtra ?? {}),
    },
    log: (m) => out.logs.push(String(m)),
    api: { events: { follow: (sid) => out.follows.push(sid) } },
    STATE_DIR: dir,
    getSocialV2State: (key) => (conv.get(key) ?? {}),
    saveSocialV2State: () => { out.saves += 1; },
    getSelfNickname: () => overrides.nick ?? '小满',
    readRoleState: () => ({ role: overrides.role ?? '' }),
    scheduleWakeV2: (key, reason) => out.wakes.push({ key, reason }),
    getSocialV2Map: () => ({ conversations: conv }),
    local3bAlive: async () => false,
    completeLocal3b: async () => '',
    deliverToIsolated: async (kind, payload, opts) => { out.delivered.push({ kind, payload }); return { ok: true, sessionId: 'gate-1' }; },
    isolatedSessions: new Map([['gate', 'gate-1']]),
    claimEmbedSpawn: () => true,
    resetClaim: () => {},
    fetchImpl: async (url, init) => {
      out.fetchCalls.push({ url, body: init?.body });
      const body = JSON.parse(init.body);
      return { status: 200, ok: true, json: async () => ({ data: body.input.map((_, i) => ({ index: i, embedding: [1, 0] })) }) };
    },
    ...overrides.deps,
  };
  const svc = createGateService(deps);
  return { svc, out, deps, dir, conv };
}

test('gateEmbedBase：显式 embedBase 优先并去掉尾斜杠，否则按 embedPort 拼', () => {
  const a = makeDeps();
  assert.equal(a.svc.gateEmbedBase(), 'http://127.0.0.1:8790');
  const b = makeDeps({ cfgExtra: { gate: { embedBase: 'http://x:9999///' } } });
  assert.equal(b.svc.gateEmbedBase(), 'http://x:9999');
});

test('gateEmbedAlive：200 才算在线；非 200/抛错都是不在线', async () => {
  const ok = makeDeps();
  assert.equal(await ok.svc.gateEmbedAlive(), true);
  const bad = makeDeps({ deps: { fetchImpl: async () => ({ status: 500 }) } });
  assert.equal(await bad.svc.gateEmbedAlive(), false);
  const boom = makeDeps({ deps: { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } } });
  assert.equal(await boom.svc.gateEmbedAlive(), false);
});

test('gateEmbedTexts：按 embedBatch 分批请求，并按 index 回填到正确位置', async () => {
  let calls = 0;
  const h = makeDeps({
    deps: {
      fetchImpl: async (url, init) => {
        calls += 1;
        const body = JSON.parse(init.body);
        return {
          status: 200, ok: true,
          json: async () => ({ data: body.input.map((t, i) => ({ index: i, embedding: [t.length, 1] })) }),
        };
      },
    },
  });
  const before = calls;
  const vecs = await h.svc.gateEmbedTexts(['a', 'bb', 'ccc', 'dddd', 'e']);
  assert.equal(calls - before, 3, '5 条 / 每批 2 → 3 批（构造时的探活不算）');
  assert.equal(vecs.length, 5);
  assert.equal(vecs[0][0], 'a'.length, '按 index 回填到原位置');
  assert.deepEqual(vecs[4], [1, 1]);
});

test('gateEmbedTexts：非 2xx 抛错（调用方据此跳过本轮）', async () => {
  const h = makeDeps({ deps: { fetchImpl: async () => ({ ok: false, status: 503 }) } });
  await assert.rejects(() => h.svc.gateEmbedTexts(['x']), /embed HTTP 503/);
});

test('gateAgentName：角色名/昵称/小写昵称去重后放进方括号；都没有给占位', () => {
  assert.equal(makeDeps({ nick: 'Shuirai', role: 'shui-inori' }).svc.gateAgentName('k'), '[shui-inori/Shuirai/shuirai]');
  assert.equal(makeDeps({ nick: '小满' }).svc.gateAgentName('k'), '[小满]', '中文 toLowerCase 相同会被去重');
  assert.equal(makeDeps({ nick: '', role: '' }).svc.gateAgentName('k'), '(未命名 agent)');
});

test('markGateSeen：只抬 gateHighSeq 且落盘', () => {
  const h = makeDeps();
  const st = {};
  h.conv.set('group:1', st);
  h.svc.markGateSeen('group:1', [{ seq: 3 }, { seq: 7 }, {}]);
  assert.equal(st.gateHighSeq, 7);
  assert.equal(h.out.saves, 1);
  h.svc.markGateSeen('group:1', [{ seq: 5 }]);
  assert.equal(st.gateHighSeq, 7, '不回退');
  assert.equal(h.out.saves, 1);
});

test('applyGateHits：无命中也记日志；有命中就写 gateLastHits 并排唤醒', () => {
  const h = makeDeps();
  const st = {};
  h.conv.set('group:1', st);
  h.svc.applyGateHits({ key: 'group:1', msgs: [{ seq: 1 }], hits: [], raw: '{}' });
  assert.equal(h.out.wakes.length, 0);
  assert.ok(fs.existsSync(path.join(h.dir, 'attention-gate.log')));

  h.svc.applyGateHits({ key: 'group:1', msgs: [{ seq: 2 }], hits: [{ i: 1, why: '叫她' }], raw: '{"hits":[]}' });
  assert.equal(st.gateHighSeq, 2);
  assert.equal(st.gateLastHits.hits[0].why, '叫她');
  assert.deepEqual(h.out.wakes, [{ key: 'group:1', reason: 'topicMention' }]);
});

test('applyGateHits：她设了无限潜水时只记录、不强制唤醒（尊重她的决定）', () => {
  const h = makeDeps();
  const st = { wakeConfig: { infinite: true } };
  h.conv.set('group:1', st);
  h.svc.applyGateHits({ key: 'group:1', msgs: [{ seq: 2 }], hits: [{ i: 1, why: '叫她' }] });
  assert.equal(h.out.wakes.length, 0);
  assert.ok(h.out.logs.some((l) => l.includes('无限潜水') && l.includes('不强制唤醒')));
  assert.ok(st.gateLastHits, '命中仍要记录下来');
});

test('appendGateLog：写 jsonl 并按 keepLogLines 截断', () => {
  const h = makeDeps();
  for (let i = 0; i < 60; i += 1) h.svc.appendGateLog({ i });
  const lines = fs.readFileSync(path.join(h.dir, 'attention-gate.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 50, '超过 keepLogLines 只留最后 50 行');
  assert.equal(JSON.parse(lines[lines.length - 1]).i, 59);
});

test('loadGateSensOverride：无文件返回 null；合法文件解析；改写后按 mtime 刷新', () => {
  const h = makeDeps();
  assert.equal(h.svc.loadGateSensOverride(), null);
  const file = path.join(h.dir, 'gate-sensitivity.json');
  fs.writeFileSync(file, JSON.stringify({ cosThreshold: 0.7, by: '她' }), 'utf8');
  const first = h.svc.loadGateSensOverride();
  assert.equal(first.cosThreshold, 0.7);
  assert.equal(first.by, '她');
  // 同 mtime 命中缓存
  assert.equal(h.svc.loadGateSensOverride(), first);
});

test('gateLoopTick：关掉门 / 门会话忙 / 不够批次 都直接返回', async () => {
  const off = makeDeps({ cfgExtra: { gate: { enabled: false } } });
  await off.svc.gateLoopTick();
  assert.equal(off.out.delivered.length, 0);

  const few = makeDeps({ conversations: new Map([['group:1', { unread: [{ seq: 1 }] }]]) });
  await few.svc.gateLoopTick();
  assert.equal(few.out.delivered.length, 0, '不足 minPending 不判');
});

test('gateLoopTick：余弦低于阈值 → 标记已看过并跳过；高于阈值 → 投递给 gate 会话', async () => {
  const low = makeDeps({
    conversations: new Map([['group:1', { unread: Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, text: `消息${i}` })) }]]),
    deps: {
      // 按内容区分「消息批次」与「锚点请求」：两者给正交向量 → 余弦≈0，应该被门槛挡下。
      // 不能用调用顺序判断：Promise.all 里两次 gateEmbedTexts 是交错发请求的。
      fetchImpl: async (url, init) => {
        const b = JSON.parse(init.body);
        const isAnchor = b.input.some((t) => !/^消息/.test(String(t)));
        const vec = isAnchor ? [1, 0] : [0.1, 1];
        return { status: 200, ok: true, json: async () => ({ data: b.input.map((_, i) => ({ index: i, embedding: vec })) }) };
      },
    },
    nick: '小满',
  });
  low.conv.get('group:1').wakeConfig = { triggers: { keywords: ['方舟'] } };
  await low.svc.gateLoopTick();
  assert.equal(low.out.delivered.length, 0, 'cos 低 → 不投递');
  assert.ok(low.conv.get('group:1').gateHighSeq > 0, '但要把这批标成已看过');

  const high = makeDeps({
    conversations: new Map([['group:1', { unread: Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, text: `消息${i}` })) }]]),
  });
  high.conv.get('group:1').wakeConfig = { triggers: { keywords: ['方舟'] } };
  await high.svc.gateLoopTick();
  assert.ok(high.out.delivered.length >= 1, 'cos=1 ≥ 阈值 → 投递');
  assert.equal(high.out.delivered[0].kind, 'gate');
  assert.ok(high.out.logs.some((l) => l.includes('粗筛命中') && l.includes('flash 精判中')));
});
