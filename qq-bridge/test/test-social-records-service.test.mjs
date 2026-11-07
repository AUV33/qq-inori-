// social-records-service 金标：原文/主张落盘、自我媒体留痕、群反馈窗口与「没人接」余温。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSocialRecords } from '../src/domain/social/social-records-service.mjs';

function makeCtx(overrides = {}) {
  const state = { raw: [], jsonl: [], utterances: [], rum: [], saves: 0, logs: [], conv: {} };
  const svc = createSocialRecords({
    cfg: { socialV2: { context: { recentLimit: 5 } } },
    MEM_DIR: '/mem',
    path,
    log: (m) => state.logs.push(String(m)),
    appendRaw: (dir, row) => state.raw.push({ dir, row }),
    extractClaims: (list) => list.map((x) => ({ text: `主张:${x.text}` })),
    canonScope: (key) => key,
    filesForScope: (dir, scope) => ({ file: `${dir}/${scope}.jsonl` }),
    claimToMemoryRow: (claim, { scope }) => ({ kind: 'claim', text: claim.text, scope }),
    appendJsonl: (file, row) => state.jsonl.push({ file, row }),
    getSocialV2State: (key) => {
      if (!state.conv[key]) state.conv[key] = { recentMessages: [] };
      return state.conv[key];
    },
    saveSocialV2State: () => { state.saves += 1; },
    writeGroupMemoryDigestV2: () => {},
    addRumination: (r) => state.rum.push(r),
    redactKnownTokensOnly: (s) => String(s).replace(/token=[\w-]+/g, 'token=***'),
    recordSlangUsage: () => {},
    getSlangEntries: () => [{ content: '绷不住' }],
    appendUtterance: (row) => state.utterances.push(row),
    ...overrides,
  });
  return { svc, state };
}

test('recordRawAndClaims：原文进 raw，主张进记忆，同一句不重复写', () => {
  const h = makeCtx();
  h.svc.recordRawAndClaims('group:1', { text: '他说要搬家', time: 1, sender: 'A', userId: 9, seq: 3 });
  assert.equal(h.state.raw.length, 1);
  assert.equal(h.state.raw[0].row.isSelf, false);
  assert.equal(h.state.jsonl.length, 1);
  assert.equal(h.state.jsonl[0].row.kind, 'claim');
  h.svc.recordRawAndClaims('group:1', { text: '他说要搬家', time: 2, sender: 'A', seq: 4 });
  assert.equal(h.state.jsonl.length, 1, '同一主张只写一次');
  assert.equal(h.state.raw.length, 2, '原文每次都记');
});

test('recordRawAndClaims：自己发的（没有 text 用 plain）+ 抽取抛错都不外抛', () => {
  const h = makeCtx({ extractClaims: () => { throw new Error('抽取坏了'); } });
  assert.doesNotThrow(() => h.svc.recordRawAndClaims('group:1', { plain: '备用正文', time: 1 }));
  assert.equal(h.state.raw[0].row.text, '备用正文');
});

test('recordSelfMediaMessage：往 recentMessages 补一条「我：[表情]」并按上限裁剪', () => {
  const h = makeCtx();
  const prev = Array.from({ length: 5 }, () => ({ text: 'old' }));
  h.state.conv['group:1'] = { recentMessages: prev };
  const ok = h.svc.recordSelfMediaMessage('group:1', '[图片]');
  assert.equal(ok, true);
  const list = h.state.conv['group:1'].recentMessages;
  assert.equal(list.length, 5, '不能超过 recentLimit');
  const last = list[list.length - 1];
  assert.equal(last.isSelf, true);
  assert.equal(last.hasMedia, true);
  assert.equal(last.text, '[图片]');
  assert.equal(h.state.raw.length, 1);
  assert.equal(h.state.raw[0].row.isSelf, true);
  assert.equal(h.state.saves, 1);
});

test('recordSentMessagesV2：群反馈累计 sent、重置 24h 窗口、5 分钟内接话由别处记 replied', () => {
  const h = makeCtx();
  const st = { recentMessages: [], groupFeedback: { sent: 2, replied: 1, windowStart: Date.now() } };
  h.state.conv['group:1'] = st;
  h.svc.recordSentMessagesV2('group:1', ['第一句', '第二句']);
  assert.equal(st.groupFeedback.sent, 4);
  assert.equal(st.groupFeedback.replied, 1, '这轮只是记发言，replied 由接话判定加');
  assert.ok(st.groupFeedback.pendingAt > 0);

  const stale = { recentMessages: [], groupFeedback: { sent: 9, replied: 3, windowStart: Date.now() - 25 * 3600000 } };
  h.state.conv['group:2'] = stale;
  h.svc.recordSentMessagesV2('group:2', ['新窗口']);
  assert.equal(stale.groupFeedback.sent, 1, '过期窗口清零重计');
  assert.equal(stale.groupFeedback.replied, 0);
});

test('recordSentMessagesV2：一直没人接且满 3 条 → 留一条余温，6 小时内不重复', () => {
  const h = makeCtx();
  const now = Date.now();
  const st = { recentMessages: [], groupFeedback: { sent: 2, replied: 0, windowStart: now, lastIgnoredAt: now - 7 * 3600000 } };
  h.state.conv['group:1'] = st;
  h.svc.recordSentMessagesV2('group:1', ['一条']);
  assert.equal(h.state.rum.length, 1);
  assert.equal(h.state.rum[0].source, 'ignored');

  h.svc.recordSentMessagesV2('group:1', ['再一条']);
  assert.equal(h.state.rum.length, 1, '6 小时内不重复念叨');
});

test('recordSentMessagesV2：她的发言脱敏+截断进 recentMessages/utterance/raw，并清掉睡前等待', () => {
  const h = makeCtx();
  const st = { recentMessages: [{ sender: 'A', text: '在吗', seq: 1, isSelf: false }], preSleepWaitSatisfiedAt: 1, preSleepWaitObservedAt: 2, preSleepWaitAccumMs: 3 };
  h.state.conv['group:1'] = st;
  h.svc.recordSentMessagesV2('group:1', [`好的 token=abc123 ${'啊'.repeat(300)}`]);
  const said = st.recentMessages[st.recentMessages.length - 1];
  assert.ok(said.text.includes('token=***'), '要脱敏');
  assert.ok(said.text.length <= 200, '进上下文要截断');
  assert.equal(said.isSelf, true);
  assert.equal(h.state.utterances.length, 1);
  assert.deepEqual(h.state.utterances[0].ctx, [{ seq: 1, sender: 'A', text: '在吗' }], '要带上「回的是哪条」');
  assert.equal(h.state.raw[h.state.raw.length - 1].row.isSelf, true);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  assert.equal(st.preSleepWaitAccumMs, 0);
  assert.equal(h.state.saves, 2, '群反馈与发言记录各存一次');
});

test('recordSentMessagesV2：空串不写 utterance/raw，但状态仍保存', () => {
  const h = makeCtx();
  h.state.conv['group:1'] = { recentMessages: [] };
  h.svc.recordSentMessagesV2('group:1', ['   ']);
  assert.equal(h.state.utterances.length, 1, '纯空白仍算「说过一句」进 utterance（由调用方保证不传空）');
  assert.equal(h.state.raw.length, 1);
  assert.equal(h.state.saves, 2, '群反馈 + 发言各存一次');
});
