// group-memory 金标：群记忆节流/锚点、3B 事实抽取的前置条件、群像去重、静默沉淀。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGroupMemory } from '../src/domain/social/group-memory.mjs';

function makeCtx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-gmem-'));
  const state = { rows: [], appended: [], saves: 0, logs: [], topics: 0, factsLlm: 0, extract: 0 };
  const conv = new Map();
  const svc = createGroupMemory({
    cfg: { socialV2: {} },
    getSocialV2State: (key) => {
      if (!conv.has(key)) conv.set(key, {});
      return conv.get(key);
    },
    saveSocialV2State: () => { state.saves += 1; },
    log: (m) => state.logs.push(String(m)),
    fs, path, MEM_DIR: dir,
    filesForScope: (d, key) => ({ file: path.join(dir, `${key}.jsonl`), scope: key }),
    loadEntries: (file) => (file === path.join(dir, 'x') ? state.rows : state.rows),
    appendJsonl: (file, row) => state.appended.push({ file, row }),
    buildGroupDigest: () => ({ text: 'A 说要去爬山；B 说也想去', kept: 2, dropped: 1 }),
    sanitizeFact: (s) => s,
    withWindow: (s) => `${s}（窗口）`,
    loadMoodState: () => ({ warmth: 0.5, energy: 0.4 }),
    appendGroupTopicsV2: () => { state.topics += 1; },
    appendGroupFactsLlm: () => { state.factsLlm += 1; return Promise.resolve(); },
    summarizeGroupSpeakers: () => ({ speakers: [{ name: 'A', count: 3 }, { name: 'B', count: 1 }], total: 4 }),
    DEFAULT_EXTRACT: { minGapMs: 300000, minMessages: 4, maxFacts: 3 },
    shouldExtractMemory: () => true,
    local3bAlive: async () => true,
    ensureLocal3b: () => {},
    extractMemoryFacts: async () => ({ facts: ['A 答应周末去爬山'], raw: 'raw' }),
    completeLocal3b: async () => 'facts',
    ...overrides,
  });
  return { svc, state, conv, dir };
}

const msgs = (n = 3) => Array.from({ length: n }, (_, i) => ({ text: `消息${i}`, sender: i % 2 ? 'B' : 'A', time: Date.now() - i * 1000, isSelf: false, seq: i + 1 }));

test('writeGroupMemoryDigestV2：非群 / 关开关 / 间隔内 / 摘要是空 都不写', () => {
  const h = makeCtx();
  h.svc.writeGroupMemoryDigestV2('private:1');
  assert.equal(h.state.appended.length, 0);

  const off = makeCtx({ cfg: { socialV2: { groupMemory: { enabled: false } } } });
  off.conv.set('group:1', { recentMessages: msgs() });
  off.svc.writeGroupMemoryDigestV2('group:1');
  assert.equal(off.state.appended.length, 0);

  const gapped = makeCtx();
  gapped.conv.set('group:1', { recentMessages: msgs(), groupMemoAt: Date.now() - 1000 });
  gapped.svc.writeGroupMemoryDigestV2('group:1');
  assert.equal(gapped.state.appended.length, 0);

  const empty = makeCtx({ buildGroupDigest: () => ({ text: '', kept: 0, dropped: 0 }) });
  empty.conv.set('group:1', { recentMessages: msgs() });
  empty.svc.writeGroupMemoryDigestV2('group:1');
  assert.equal(empty.state.appended.length, 0);
});

test('writeGroupMemoryDigestV2：写入 group-digest，带主导发言人、情绪、锚点与节流时间', () => {
  const h = makeCtx();
  const st = { recentMessages: [
    { text: 'A 说', sender: 'A', time: Date.now() - 3000, isSelf: false },
    { text: 'B 说', sender: 'B', time: Date.now() - 2000, isSelf: false },
    { text: 'B 又说', sender: 'B', time: Date.now() - 1000, isSelf: false },
  ] };
  h.conv.set('group:1', st);
  h.svc.writeGroupMemoryDigestV2('group:1');
  assert.equal(h.state.appended.length, 1);
  const row = h.state.appended[0].row;
  assert.equal(row.kind, 'group-digest');
  assert.equal(row.theme, '群聊');
  assert.equal(row.importance, 2);
  assert.ok(row.text.includes('（窗口）'));
  assert.equal(row.sender, 'B', '主导发言人按出现次数取 B（3 条里 B 占 2）');
  assert.equal(row.mood, '0.50/0.40');
  assert.ok(st.groupMemoAt > 0);
  assert.ok(st.groupMemoAnchor > 0);
  assert.equal(h.state.saves, 1);
  assert.equal(h.state.topics, 1, '写完顺手更新群话题');
  assert.equal(h.state.factsLlm, 1, '也会排队云端事实抽取');
});

test('writeGroupMemoryDigestV2：情绪读不到就不写 mood 字段（不要伪造 0.00）', () => {
  const h = makeCtx({ loadMoodState: () => { throw new Error('情绪文件坏了'); } });
  h.conv.set('group:1', { recentMessages: msgs() });
  h.svc.writeGroupMemoryDigestV2('group:1');
  assert.equal(h.state.appended[0].row.mood, undefined);
});

test('writeGroupMemoryDigestV2：写库抛错只记日志', () => {
  const h = makeCtx({ appendJsonl: () => { throw new Error('磁盘满'); } });
  h.conv.set('group:1', { recentMessages: msgs() });
  assert.doesNotThrow(() => h.svc.writeGroupMemoryDigestV2('group:1'));
  assert.ok(h.state.logs.some((l) => l.includes('写群记忆失败')));
});

test('runMemoryExtractV2：关开关 / 没有待抽消息 / 3B 不在 都返回 0', async () => {
  const off = makeCtx({ cfg: { socialV2: { memoryExtract: { enabled: false } } } });
  assert.equal(await off.svc.runMemoryExtractV2('group:1', msgs()), 0);

  const none = makeCtx();
  assert.equal(await none.svc.runMemoryExtractV2('group:1', [{ text: '', isSelf: false }, { text: '自己说的', isSelf: true }]), 0);

  const dead = makeCtx({ local3bAlive: async () => false });
  dead.conv.set('group:1', {});
  assert.equal(await dead.svc.runMemoryExtractV2('group:1', msgs()), 0);
  assert.equal(dead.state.appended.length, 0);
});

test('runMemoryExtractV2：抽出事实写成 kind=fact，并先占位防每轮重试', async () => {
  const h = makeCtx();
  const st = {};
  h.conv.set('group:1', st);
  const written = await h.svc.runMemoryExtractV2('group:1', msgs(6));
  assert.equal(written, 1);
  assert.equal(h.state.appended[0].row.kind, 'fact');
  assert.equal(h.state.appended[0].row.theme, '抽取');
  assert.ok(st.memExtractAt > 0, '先占位，抽不出来也不连环重试');
});

test('appendGroupFactIfChangedV2：样本不足 / 群像没变 / 节流内 都不写；变了才写', () => {
  const h = makeCtx();
  h.state.rows = [{ kind: 'group-digest', time: new Date().toLocaleString('sv-SE') }];
  h.svc.appendGroupFactIfChangedV2('group:1');
  assert.equal(h.state.appended.length, 0, '只有 1 段摘要，样本不足');

  h.state.rows = [
    { kind: 'group-digest', time: new Date().toLocaleString('sv-SE') },
    { kind: 'group-digest', time: new Date().toLocaleString('sv-SE') },
    { kind: 'group-fact', sig: 'A:3,B:1', time: new Date().toLocaleString('sv-SE') },
  ];
  h.svc.appendGroupFactIfChangedV2('group:1');
  assert.equal(h.state.appended.length, 0, '群像签名没变不重复写');

  const fresh = makeCtx();
  fresh.state.rows = [
    { kind: 'group-digest', time: new Date().toLocaleString('sv-SE') },
    { kind: 'group-digest', time: new Date().toLocaleString('sv-SE') },
  ];
  fresh.conv.set('group:1', {});
  fresh.svc.appendGroupFactIfChangedV2('group:1');
  assert.equal(fresh.state.appended.length, 1);
  const row = fresh.state.appended[0].row;
  assert.equal(row.kind, 'group-fact');
  assert.equal(row.sig, 'A:3,B:1');
  assert.equal(row.importance, 4);
});

test('appendGroupFactIfChangedV2：30 分钟节流内不写第二次', () => {
  const h = makeCtx();
  h.state.rows = [
    { kind: 'group-digest', time: new Date().toLocaleString('sv-SE') },
    { kind: 'group-digest', time: new Date().toLocaleString('sv-SE') },
  ];
  h.conv.set('group:1', { groupFactAt: Date.now() - 1000 });
  h.svc.appendGroupFactIfChangedV2('group:1');
  assert.equal(h.state.appended.length, 0);
});

test('sedimentGroupMemoryIfStale：别人新消息不足 3 条 / 节流内 都不动', () => {
  const h = makeCtx();
  h.conv.set('group:1', { recentMessages: msgs(2), groupMemoAnchor: 0 });
  h.svc.sedimentGroupMemoryIfStale('group:1');
  assert.equal(h.state.appended.length, 0);

  const gapped = makeCtx();
  gapped.conv.set('group:1', { recentMessages: msgs(5), groupMemoAnchor: 0, groupMemoAt: Date.now() - 1000 });
  gapped.svc.sedimentGroupMemoryIfStale('group:1');
  assert.equal(gapped.state.appended.length, 0, '刚写过就等下一个窗口');
});

test('sedimentGroupMemoryIfStale：够了就沉淀（她整场没说话也留素材）', () => {
  const h = makeCtx();
  const st = { recentMessages: msgs(4), groupMemoAnchor: 0 };
  h.conv.set('group:1', st);
  h.svc.sedimentGroupMemoryIfStale('group:1');
  assert.equal(h.state.appended.length, 1);
  assert.ok(h.state.logs.some((l) => l.includes('静默轮沉淀了一条群记忆')));
  assert.ok(st.groupMemoAnchor > 0, '锚点前进，避免下一轮重复录入同批内容');
});
