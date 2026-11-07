// social-append 金标：入站消息写 recent/unread 的边界、媒体/转发清洗、副作用与群反馈计数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocialAppend } from '../src/domain/social/social-append.mjs';

function makeCtx(overrides = {}) {
  const out = { raw: [], echoes: [], facts: [], members: [], saves: 0, chase: [], factsExtract: [] };
  const state = { conv: {} };
  const seenForwardIds = new Map();
  const svc = createSocialAppend({
    getSocialV2State: (key) => {
      if (!state.conv[key]) state.conv[key] = { recentMessages: [], unread: [], lastUnreadSeq: 0, lastIncomingAt: 0, activeTopics: [] };
      return state.conv[key];
    },
    cleanMemberName: (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim(),
    cfg: { ownerQQ: 10001, socialV2: { context: { recentLimit: 3, unreadLimit: 2 } } },
    sanitizeForwardId: (v) => (v ? String(v).replace(/[^0-9a-zA-Z_-]/g, '') : ''),
    seenForwardIds,
    truncateText: (s, n) => (s.length > n ? s.slice(0, n) : s),
    truncateTextTail: (s, n) => (s.length > n ? s.slice(-n) : s),
    recordRawAndClaims: (key, msg) => out.raw.push({ key, msg }),
    detectEchoChain: (key, st, msg) => out.echoes.push({ key, text: msg.text }),
    maybeExtractFacts: (key, msg) => out.facts.push({ key, text: msg.text }),
    sanitizeFact: (s) => s,
    extractFacts: (text) => {
      out.factsExtract.push(text);
      return text.includes('喜欢') ? [{ text: '他喜欢猫' }] : [];
    },
    noteMember: (key, payload) => out.members.push({ key, ...payload }),
    cancelChaseV2: (key, why) => out.chase.push({ key, why }),
    chaseState: (st) => (st.chase ??= { unanswered: 0 }),
    saveSocialV2State: () => { out.saves += 1; },
    ...overrides,
  });
  return { svc, out, state, seenForwardIds };
}

test('消息极性：neg/pos/neutral 落进 msg.tone，供群气氛使用', () => {
  const h = makeCtx();
  const put = (text) => h.svc.appendSocialV2Message('group:9', '甲', text, text, false, false, 1, [], '10002', []);
  put('笨死了，就这？');
  put('谢谢你，太厉害了');
  put('今天天气不错');
  const msgs = h.state.conv['group:9'].recentMessages;
  assert.equal(msgs[0].tone, 'neg');
  assert.equal(msgs[1].tone, 'pos');
  assert.equal(msgs[2].tone, 'neutral');
});

test('入站感知：meta.selfId/mentionedIds 能让“@她”被识别为 her', () => {
  const h = makeCtx();
  h.svc.appendSocialV2Message('group:1', '小明', '@她 在吗', '@她 在吗', false, false, 1, [], '10002', [], { selfId: '999', mentionedIds: ['999'] });
  const msg = h.state.conv['group:1'].recentMessages.at(-1);
  assert.equal(msg.perception.addressee, 'her');
  assert.equal(msg.perception.speechAct, 'question');
});

test('appendSocialV2Message：seq 递增、时间戳更新、preSleepWait 清零', () => {
  const h = makeCtx();
  const st = h.state.conv['group:1'] = { recentMessages: [], unread: [], lastUnreadSeq: 7, activeTopics: [], preSleepWaitSatisfiedAt: 1, preSleepWaitAccumMs: 2 };
  h.svc.appendSocialV2Message('group:1', 'A', '你好', '你好', false, false, 1001, [], 5);
  assert.equal(st.lastUnreadSeq, 8);
  assert.ok(st.lastIncomingAt > 0);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  assert.equal(st.preSleepWaitAccumMs, 0);
  assert.equal(st.recentMessages.length, 1);
  const msg = st.recentMessages[0];
  assert.equal(msg.seq, 8);
  assert.equal(msg.messageId, '1001');
  assert.equal(msg.sender, 'A');
  assert.equal(msg.userId, '5');
  assert.equal(msg.isSelf, false);
  assert.equal(msg.ownerLabel, '');
});

test('appendSocialV2Message：recent/unread 超上限裁掉最旧的', () => {
  const h = makeCtx();
  const st = h.state.conv['group:1'] = { recentMessages: [{ text: '旧1' }, { text: '旧2' }, { text: '旧3' }], unread: [{ seq: 1 }, { seq: 2 }], lastUnreadSeq: 3, activeTopics: [] };
  h.svc.appendSocialV2Message('group:1', 'A', '新', '新', false, false, 1002);
  assert.equal(st.recentMessages.length, 3, 'recentLimit=3');
  assert.equal(st.unread.length, 2, 'unreadLimit=2');
  assert.equal(st.recentMessages[st.recentMessages.length - 1].text, '新');
});

test('appendSocialV2Message：名字清洗为空回落「某人」，控制字符不落库', () => {
  const h = makeCtx();
  h.svc.appendSocialV2Message('group:1', '\u0000\u0001', 'x', 'x', false, false, 1);
  const st = h.state.conv['group:1'];
  assert.equal(st.recentMessages[0].sender, '某人');
});

test('appendSocialV2Message：媒体清洗（face 要 faceId、image 要 file/url）', () => {
  const h = makeCtx();
  h.svc.appendSocialV2Message('group:1', 'A', 'x', 'x', false, false, 1, [
    { kind: 'face', faceId: 14 },
    { kind: 'face' },
    { kind: 'image', file: 'a.jpg' },
    { kind: 'image', url: 'https://x/y.png' },
    { kind: 'image' },
    { kind: 'weird', file: 'z.png' },
  ]);
  const msg = h.state.conv['group:1'].recentMessages[0];
  assert.deepEqual(msg.media.map((m) => m.kind), ['face', 'image', 'image', 'image']);
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.media[3].kind, 'image', '未知 kind 按 image 处理');
});

test('appendSocialV2Message：forwardIds 去重清洗并累积到 seenForwardIds（上限 1000）', () => {
  const h = makeCtx();
  h.svc.appendSocialV2Message('group:1', 'A', 'x', 'x', false, false, 1, [], null, ['ab c', 'ab c', 'de']);
  const msg = h.state.conv['group:1'].recentMessages[0];
  assert.deepEqual(msg.forwardIds, ['abc', 'de']);
  assert.equal(msg.hasForward, true);
  assert.deepEqual([...h.seenForwardIds.get('group:1')], ['abc', 'de']);

  // 塞满 1000 后仍保持有界
  const set = new Set(Array.from({ length: 1000 }, (_, i) => `f${i}`));
  h.seenForwardIds.set('group:1', set);
  h.svc.appendSocialV2Message('group:1', 'A', 'y', 'y', false, false, 2, [], null, ['新来的']);
  assert.ok(h.seenForwardIds.get('group:1').size <= 1000);
});

test('appendSocialV2Message：原始/复读/事实/成员档案四条副作用都触发，并把「他喜欢」改写成中性说法', () => {
  const h = makeCtx();
  h.svc.appendSocialV2Message('group:1', 'A', '他喜欢猫', '他喜欢猫', true, true, 1003, [], 9);
  assert.equal(h.out.raw.length, 1);
  assert.equal(h.out.echoes.length, 1);
  assert.equal(h.out.members.length, 1);
  assert.equal(h.out.members[0].isSelf, false);
  assert.equal(h.out.members[0].quoteTargetIsSelf, true);
  assert.deepEqual(h.out.members[0].facts, ['喜欢猫'], '「他喜欢」要改写成「喜欢」');
  assert.equal(h.state.conv['group:1'].recentMessages[0].ownerLabel, '管理员（ownerQQ 10001）');
  assert.ok(h.out.saves >= 1);
});

test('appendSocialV2Message：主人私聊会触发 maybeExtractFacts；群里不会', () => {
  const h = makeCtx();
  h.svc.appendSocialV2Message('private:10001', '主人', '我喜欢猫', '我喜欢猫', false, true, 1);
  assert.equal(h.out.facts.length, 1);
});

test('appendSocialV2Message：她发言后 5 分钟内有接话 → replied+1 并清 pendingAt', () => {
  const h = makeCtx();
  const st = h.state.conv['group:1'] = {
    recentMessages: [], unread: [], lastUnreadSeq: 0, activeTopics: [],
    groupFeedback: { sent: 2, replied: 0, pendingAt: Date.now() - 1000, windowStart: Date.now() },
  };
  h.svc.appendSocialV2Message('group:1', 'A', '接一句', '接一句', false, false, 1);
  assert.equal(st.groupFeedback.replied, 1);
  assert.equal(st.groupFeedback.pendingAt, 0);
});

test('appendSocialV2Message：超过 5 分钟才有人接就不算被接', () => {
  const h = makeCtx();
  const st = h.state.conv['group:1'] = {
    recentMessages: [], unread: [], lastUnreadSeq: 0, activeTopics: [],
    groupFeedback: { sent: 2, replied: 0, pendingAt: Date.now() - 6 * 60 * 1000, windowStart: Date.now() },
  };
  h.svc.appendSocialV2Message('group:1', 'A', '太晚了', '太晚了', false, false, 1);
  assert.equal(st.groupFeedback.replied, 0);
  assert.ok(st.groupFeedback.pendingAt > 0, '不动 pendingAt（那是另一批的计时）');
});

test('appendSocialV2Message：话题命中就刷新 lastMentionAt', () => {
  const h = makeCtx();
  const topic = { text: '明日方舟的干员', participants: ['B'], lastMentionAt: 0 };
  h.svc.appendSocialV2Message('group:1', 'A', '明日方舟的干员真难得', '明日方舟的干员真难得', false, false, 1);
  h.state.conv['group:1'].activeTopics.push(topic);
  h.svc.appendSocialV2Message('group:1', 'A', '明日方舟的干员真难得', '明日方舟的干员真难得', false, false, 2);
  assert.ok(topic.lastMentionAt > 0);
});

test('appendSocialV2Poke：拍一拍文案、poke 字段、unread 上限与 chase 重置', () => {
  const h = makeCtx();
  const st = h.state.conv['group:1'] = { recentMessages: [], unread: [{ seq: 1 }, { seq: 2 }], lastUnreadSeq: 2, activeTopics: [], chase: { unanswered: 3 } };
  const msg = h.svc.appendSocialV2Poke('group:1', { sender: 'A', userId: 9, targetId: 10001, targetIsSelf: true, action: '拍了拍', suffix: '的脸' });
  assert.equal(msg.text, '[拍一拍] A 拍了拍 你 的脸');
  assert.equal(msg.kind, 'poke');
  assert.deepEqual(msg.poke, { targetId: '10001', targetIsSelf: true, groupId: null });
  assert.equal(st.unread.length, 2, '仍受 unreadLimit 约束');
  assert.equal(st.chase.unanswered, 0, '对方有动静就重置连续未回');
  assert.ok(h.out.chase.length >= 1);
});

test('appendSocialV2Poke：targetIsSelf=false 时目标是 id；缺失时给「未知」', () => {
  const h = makeCtx();
  const msg = h.svc.appendSocialV2Poke('group:1', { sender: 'A', targetId: 123, targetIsSelf: false });
  assert.equal(msg.text, '[拍一拍] A 拍了拍 123');
  const unknown = h.svc.appendSocialV2Poke('group:2', {});
  assert.equal(unknown.text, '[拍一拍] 未知 拍了拍 未知');
  assert.equal(h.state.conv['group:2'].recentMessages[0].sender, '未知');
});

test('副作用抛错不影响主流程（成员档案坏了也要把消息写进去）', () => {
  const h = makeCtx({ noteMember: () => { throw new Error('档案坏了'); } });
  assert.doesNotThrow(() => h.svc.appendSocialV2Message('group:1', 'A', 'x', 'x', false, false, 1));
  assert.equal(h.state.conv['group:1'].recentMessages.length, 1);
  assert.equal(h.out.saves, 1);
});
