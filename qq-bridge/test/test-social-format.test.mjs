// social-format 金标：参与度参考、静默时长建议、记忆视图拼装、appendMemory 四条写入通道。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialFormat } from '../src/domain/social/social-format.mjs';

const NOW = Date.now();
const ago = (ms) => NOW - ms;

function makeCtx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-socfmt-'));
  const out = { logs: [], appended: [], cacheResets: 0, saves: 0 };
  const svc = createSocialFormat({
    cfg: { socialV2: { wait: { defaultQuietMs: 8000 } } },
    isDirectedAtAi: (t) => /你|在吗|\?/.test(String(t)),
    looksLikeUnfinished: (t) => /然后$|，$/.test(String(t)),
    redactKnownTokensOnly: (t) => String(t).replace(/secret/g, '***'),
    truncateText: (t, n) => (String(t).length > n ? String(t).slice(0, n) : String(t)),
    readMemoryRows: () => overrides.memoryRows ?? [],
    getMemoryFile: () => overrides.memoryFile ?? path.join(dir, 'memory.jsonl'),
    appendJsonl: (file, row) => { out.appended.push({ file, row }); return overrides.appendResult ?? { ok: true }; },
    log: (m) => out.logs.push(String(m)),
    resetCoreFactsCache: () => { out.cacheResets += 1; },
    saveSocialV2State: () => { out.saves += 1; },
    fs,
    ...overrides.ctxExtra,
  });
  return { svc, out, dir };
}

test('formatParticipationV2：没有消息返回空串；有消息时给条数与参与建议', () => {
  const h = makeCtx();
  assert.equal(h.svc.formatParticipationV2(null), '');
  assert.equal(h.svc.formatParticipationV2({ recentMessages: [] }), '');

  const st = {
    recentMessages: [
      { isSelf: false, text: '在吗', time: ago(60000) },
      { isSelf: false, text: '你最近咋样', time: ago(30000) },
      { isSelf: true, text: '还行', time: ago(20000) },
    ],
    unread: [{ text: '在吗你' }],
    lastAiReplyAt: ago(10000),
  };
  const line = h.svc.formatParticipationV2(st);
  assert.ok(line.startsWith('【参与度参考】'));
  assert.ok(line.includes('你最近 1 小时发言 1 次'));
  assert.ok(line.includes('群友发言 2 条'));
  assert.ok(line.includes('有人直接找你'), '有直接找她的未读时优先提示回应');
});

test('formatParticipationV2：刚连回多次 → 提示可以少说', () => {
  const h = makeCtx();
  const st = {
    recentMessages: [
      { isSelf: true, text: 'a', time: ago(30000) },
      { isSelf: true, text: 'b', time: ago(20000) },
      { isSelf: false, text: '别人', time: ago(10000) },
    ],
    lastAiReplyAt: ago(5000),
  };
  assert.ok(h.svc.formatParticipationV2(st).includes('刚刚已经连回过好几次'));
});

test('suggestQuietMsV2：默认 8s；像没说完/15 秒内连发 3 条 → 12s', () => {
  const h = makeCtx();
  assert.equal(h.svc.suggestQuietMsV2(null), 8000);
  assert.equal(h.svc.suggestQuietMsV2({ recentMessages: [] }), 8000);

  const unfinished = { recentMessages: [{ isSelf: false, text: '我跟你讲，', time: ago(1000) }] };
  assert.equal(h.svc.suggestQuietMsV2(unfinished), 12000);

  const burst = { recentMessages: [1, 2, 3].map((i) => ({ isSelf: false, text: `m${i}`, time: ago(1000 + i * 100) })) };
  assert.equal(h.svc.suggestQuietMsV2(burst), 12000);
});

test('formatMemoryV2：话题（含搁置/待追问）、未说出口的想法、群友印象', () => {
  const h = makeCtx();
  const st = {
    activeTopics: [
      { text: '周末去哪', lastMentionAt: ago(3 * 3600 * 1000) },
      { text: '他家的猫', lastMentionAt: ago(60000), pendingQuestion: '猫叫什么名字', pendingSince: ago(4 * 3600 * 1000) },
      { text: '' },
    ],
    pendingThoughts: [{ text: '想问问它吃啥', motivation: '好奇' }, { text: '过期的', expiresAt: ago(1000) }],
    memberImpressions: { 小明: { traits: ['话多', '爱发图'], interactionCount: 5 } },
  };
  const text = h.svc.formatMemoryV2(st);
  assert.ok(text.includes('【进行中的话题】'));
  assert.ok(text.includes('（已搁置）'));
  assert.ok(text.includes('挂了 4 小时了'), '挂太久的待追问要明说');
  assert.ok(text.includes('【你想说但还没说的】'));
  assert.ok(!text.includes('过期的'), '过期想法不渲染');
  assert.ok(text.includes('【对群友的印象】'));
  assert.ok(text.includes('小明：话多、爱发图（互动 5 次）'));
});

test('appendMemoryV2：activeTopic 新建/去重置顶/参与者去重/上限 20', () => {
  const h = makeCtx();
  const st = {};
  h.svc.appendMemoryV2(st, 'activeTopic', '周末去哪', { participants: ['小明', '小红'] });
  assert.equal(st.activeTopics.length, 1);
  assert.deepEqual(st.activeTopics[0].participants, ['小明', '小红']);

  h.svc.appendMemoryV2(st, 'activeTopic', '周末去哪', { participants: ['小红', '小刚'] });
  assert.equal(st.activeTopics.length, 1, '同话题不新增');
  assert.deepEqual(st.activeTopics[0].participants.sort(), ['小刚', '小红', '小明'].sort());
  assert.ok(st.activeTopics[0].lastMentionAt > 0);

  for (let i = 0; i < 30; i += 1) h.svc.appendMemoryV2(st, 'activeTopic', `话题${i}`);
  assert.ok(st.activeTopics.length <= 20, '话题有界 20');
});

test('appendMemoryV2：pendingThought 新建/刷新过期时间/上限 20', () => {
  const h = makeCtx();
  const st = {};
  h.svc.appendMemoryV2(st, 'pendingThought', '想说的话', { motivation: '好奇' });
  assert.equal(st.pendingThoughts.length, 1);
  assert.ok(st.pendingThoughts[0].expiresAt > Date.now());
  const first = st.pendingThoughts[0].expiresAt;
  h.svc.appendMemoryV2(st, 'pendingThought', '想说的话', { expiresAtMs: 60000 });
  assert.equal(st.pendingThoughts.length, 1, '同文不新增');
  assert.ok(st.pendingThoughts[0].expiresAt < first + 1);

  for (let i = 0; i < 30; i += 1) h.svc.appendMemoryV2(st, 'pendingThought', `想法${i}`);
  assert.ok(st.pendingThoughts.length <= 20);
});

test('appendMemoryV2：memberImpression 拒绝原型污染键，traits 去重且有界 50 人', () => {
  const h = makeCtx();
  const st = {};
  h.svc.appendMemoryV2(st, 'memberImpression', '话多', { target: '__proto__' });
  assert.deepEqual(st.memberImpressions ?? {}, {}, '原型键被拒');
  h.svc.appendMemoryV2(st, 'memberImpression', '话多', { target: '小明' });
  assert.deepEqual(st.memberImpressions.小明.traits, ['话多']);
  assert.equal(st.memberImpressions.小明.interactionCount, 1);
  h.svc.appendMemoryV2(st, 'memberImpression', '话多', { target: '小明' });
  assert.equal(st.memberImpressions.小明.traits.length, 1, '同 trait 不重复');
  assert.equal(st.memberImpressions.小明.interactionCount, 2);
});

test('appendMemoryV2：fact 落私聊库、同文去重、写失败走 fs 兜底并重置缓存', () => {
  const h = makeCtx({ memoryRows: [{ text: '已有的事实' }] });
  const st = {};
  h.svc.appendMemoryV2(st, 'fact', '已有的事实');
  assert.equal(h.out.appended.length, 0, '同文不重复写');

  h.svc.appendMemoryV2(st, 'fact', '新的事实');
  assert.equal(h.out.appended.length, 1);
  assert.equal(h.out.appended[0].row.kind, 'fact');
  assert.equal(h.out.appended[0].row.src, 'her');
  assert.equal(h.out.cacheResets, 1);

  const failing = makeCtx({ appendResult: { ok: false } });
  failing.svc.appendMemoryV2({}, 'fact', '失败兜底的事实');
  assert.ok(failing.out.logs.some((l) => l.includes('她记了一条事实')), 'fs 兜底写成功仍记日志');
});
