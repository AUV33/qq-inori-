// digest-service 金标：当天摘要的跳过条件、行为账并入、行为快照的小时去重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDigestService } from '../src/domain/memory/digest-service.mjs';

function makeCtx({ sessions = {}, recent = {}, rows = [], ledger = '', overrides = {} } = {}) {
  const state = { appended: [], logs: [] };
  const svc = createDigestService({
    fs: {
      readFileSync: () => (Array.isArray(rows) ? rows.map((r) => JSON.stringify(r)).join('\n') : rows),
    },
    cfg: { socialV2: { digest: { enabled: true } } },
    state: { sessions },
    getSocialV2State: (key) => ({ recentMessages: recent[key] ?? [] }),
    filesForScope: (dir, key) => ({ file: `mem-${key}.jsonl`, scope: key }),
    MEM_DIR: '/mem',
    alreadyDigested: (existing, day) => existing.some((r) => r.kind === 'day-digest' && r.day === day),
    digestDay: (msgs) => ({ ok: true, text: `今天聊了 ${msgs.length} 条`, total: msgs.length }),
    renderBehaviorLedger: () => ledger,
    sanitizeFact: (s) => String(s),
    appendJsonl: (file, row) => state.appended.push({ file, row }),
    log: (m) => state.logs.push(String(m)),
    ...overrides,
  });
  return { svc, state };
}

test('writeDailyDigestV2：关掉开关就什么都不写', () => {
  const h = makeCtx({
    sessions: { 'group:1': 'sid' },
    recent: { 'group:1': [{ text: 'hi' }] },
    overrides: { cfg: { socialV2: { digest: { enabled: false } } } },
  });
  h.svc.writeDailyDigestV2();
  assert.equal(h.state.appended.length, 0);
});

test('writeDailyDigestV2：owner lane 与无消息会话跳过', () => {
  const h = makeCtx({
    sessions: { 'group:1#owner': 'sid-a', 'group:2': 'sid-b', 'group:3': 'sid-c' },
    recent: { 'group:1#owner': [{ text: 'owner 车道' }], 'group:2': [], 'group:3': [{ text: '有内容' }] },
  });
  h.svc.writeDailyDigestV2();
  assert.deepEqual(h.state.appended.map((a) => a.file), ['mem-group:3.jsonl']);
});

test('writeDailyDigestV2：当天已写过就不重复写', () => {
  const day = new Date().toLocaleDateString('sv-SE');
  const h = makeCtx({
    sessions: { 'group:1': 'sid' },
    recent: { 'group:1': [{ text: 'hi' }] },
    rows: [{ kind: 'day-digest', day, text: '已有' }],
  });
  h.svc.writeDailyDigestV2();
  assert.equal(h.state.appended.length, 0);
});

test('writeDailyDigestV2：摘要失败按 reason 跳过，不写空条目', () => {
  const h = makeCtx({
    sessions: { 'group:1': 'sid' },
    recent: { 'group:1': [{ text: 'hi' }] },
    overrides: { digestDay: () => ({ ok: false, reason: '太少', total: 1 }) },
  });
  h.svc.writeDailyDigestV2();
  assert.equal(h.state.appended.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes('跳过（太少，1 条）')));
});

test('writeDailyDigestV2：把行为账接在摘要后面（“我都干了什么”要能被检索到）', () => {
  const h = makeCtx({
    sessions: { 'group:1': 'sid' },
    recent: { 'group:1': [{ text: 'hi' }, { text: 'yo' }] },
    ledger: '【行为账】看了 3 个视频',
  });
  h.svc.writeDailyDigestV2();
  assert.equal(h.state.appended.length, 1);
  const row = h.state.appended[0].row;
  assert.equal(row.kind, 'day-digest');
  assert.equal(row.theme, '日常');
  assert.ok(row.text.includes('今天聊了 2 条'));
  assert.ok(row.text.includes('我做的事：看了 3 个视频'), '行为账要挂进同一条摘要');
});

test('writeDailyDigestV2：单个会话抛错只记日志，不影响其它会话', () => {
  let first = true;
  const h = makeCtx({
    sessions: { 'group:1': 'a', 'group:2': 'b' },
    recent: { 'group:1': [{ text: 'x' }], 'group:2': [{ text: 'y' }] },
    overrides: {
      getSocialV2State: (key) => {
        if (key === 'group:1' && first) { first = false; throw new Error('会话坏了'); }
        return { recentMessages: [{ text: 'ok' }] };
      },
    },
  });
  assert.doesNotThrow(() => h.svc.writeDailyDigestV2());
  assert.ok(h.state.logs.some((l) => l.includes('摘要失败（已忽略）')));
});

test('writeBehaviorMemorySnapshot：行为账为空就不写', () => {
  const h = makeCtx({ ledger: '' });
  h.svc.writeBehaviorMemorySnapshot();
  assert.equal(h.state.appended.length, 0);
});

test('writeBehaviorMemorySnapshot：同一小时只写一条，跨小时再写', () => {
  const now = new Date();
  const day = now.toLocaleDateString('sv-SE');
  const hh = String(now.getHours()).padStart(2, '0');
  const deduped = makeCtx({
    ledger: '【行为账】整理记忆',
    rows: [{ kind: 'event', theme: '我做的事', text: `${day} ${hh} 点前我做了：整理记忆` }],
  });
  deduped.svc.writeBehaviorMemorySnapshot();
  assert.equal(deduped.state.appended.length, 0, '这一小时已经写过');

  const fresh = makeCtx({ ledger: '【行为账】整理记忆' });
  fresh.svc.writeBehaviorMemorySnapshot();
  assert.equal(fresh.state.appended.length, 1);
  const row = fresh.state.appended[0].row;
  assert.equal(row.kind, 'event');
  assert.equal(row.theme, '我做的事');
  assert.equal(row.importance, 2);
  assert.ok(row.text.includes('点前我做了：整理记忆'));
});
