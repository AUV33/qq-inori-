// reasoning-service 金标：思考缓冲、摘要/长文留存、失败经验候选、群反馈率、主动度、复读检测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReasoningService } from '../src/domain/memory/reasoning-service.mjs';

function makeCtx(overrides = {}) {
  const state = { thoughts: [], files: new Map(), logs: [], ruminations: [] };
  const svc = createReasoningService({
    cfg: { socialV2: { mood: { file: 'mood.json' } } },
    log: (m) => state.logs.push(String(m)),
    fs: {
      writeFileSync: (file, body) => state.files.set(file, body),
    },
    reverse: new Map([['sid-1', 'group:1']]),
    appendThought: (kind, text) => state.thoughts.push({ kind, text }),
    readJsonlSafe: (file) => {
      const body = state.files.get(file);
      if (!body) return [];
      return String(body).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    REASONING_LOG_FILE: 'reasoning-log.jsonl',
    LESSON_CANDIDATES_FILE: 'lesson-candidates.jsonl',
    addRumination: (r) => state.ruminations.push(r),
    loadMoodState: () => ({ warmth: 0.6 }),
    ...overrides,
  });
  return { svc, state };
}

const long = (n = 200) => '想'.repeat(n);
// 真实事件形状：思考在 event.data.message.content 里，type=reasoning
const event = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text }] } } });
const sentences = (n = 200) => `${'我在想这件事该怎么做。'.repeat(Math.ceil(n / 11))}`.slice(0, n);

test('captureReasoning：turn/start 清空缓冲，非 assistant 事件不记', () => {
  const h = makeCtx();
  h.svc.captureReasoning('sid-1', event(long(60)));
  h.svc.captureReasoning('sid-1', { type: 'turn/start' });
  h.svc.captureReasoning('sid-1', { type: 'tool/call', text: long(60) });
  h.svc.captureReasoning('', event(long(60)));
  assert.equal(h.svc.flushReasoning('sid-1'), undefined);
  assert.ok(h.state.logs.some((l) => l.includes('本轮没收到思考')));
});

test('captureReasoning：单回合最多留 30 段，最旧的被挤掉', () => {
  const h = makeCtx();
  for (let i = 0; i < 35; i += 1) h.svc.captureReasoning('sid-1', event(`第${i}段` + '啊'.repeat(60)));
  h.svc.flushReasoning('sid-1');
  const saved = JSON.parse(h.state.files.get('reasoning-log.jsonl').trim());
  assert.ok(!saved.text.includes('第0段'), '最旧的段应被挤掉');
  assert.ok(saved.text.includes('第34段'), '最新的段要保留');
});

test('flushReasoning：太短的思考不记（<40 字）', () => {
  const h = makeCtx();
  h.svc.captureReasoning('sid-1', event('想了一下'));
  h.svc.flushReasoning('sid-1');
  assert.equal(h.state.thoughts.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes('太短不记')));
});

test('flushReasoning：正常回合写一条 thoughts 摘要', () => {
  const h = makeCtx();
  h.svc.captureReasoning('sid-1', event(`${sentences(80)}所以先确认一下记忆里有没有这个人。`));
  h.svc.flushReasoning('sid-1');
  assert.equal(h.state.thoughts.length, 1);
  assert.equal(h.state.thoughts[0].kind, 'reasoning');
  assert.ok(h.state.thoughts[0].text.length > 0);
});

test('flushReasoning：长思考留全文，日志最多留 200 条', () => {
  const h = makeCtx();
  const existing = Array.from({ length: 200 }, (_, i) => ({ at: new Date().toISOString(), text: `old${i}` }));
  h.state.files.set('reasoning-log.jsonl', existing.map((r) => JSON.stringify(r)).join('\n') + '\n');
  h.svc.captureReasoning('sid-1', event(sentences(1500)));
  h.svc.flushReasoning('sid-1');
  const rows = h.state.files.get('reasoning-log.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 200, '上限 200 条');
  assert.equal(rows[rows.length - 1].sessionId, 'sid-1');
  assert.ok(rows[rows.length - 1].text.length <= 4000);
});

test('flushReasoning：失败回合留经验候选并记一条反刍，重复候选不重复写', () => {
  const h = makeCtx();
  const text = `${sentences(80)}这次没做成，下次先检查设备连接状态再重试，别急着换方法。`;
  h.svc.captureReasoning('sid-1', event(text));
  h.svc.flushReasoning('sid-1', { failed: true });
  const rows = h.state.files.get('lesson-candidates.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'sid-1');
  assert.equal(h.state.ruminations.length, 1);
  assert.equal(h.state.ruminations[0].source, 'task-failed');
  assert.equal(h.state.ruminations[0].key, 'group:1');

  // 同一段思考再来一次：候选不重复
  h.svc.captureReasoning('sid-1', event(text));
  h.svc.flushReasoning('sid-1', { failed: true });
  const rows2 = h.state.files.get('lesson-candidates.jsonl').trim().split('\n').map(JSON.parse);
  assert.equal(rows2.length, 1, '同文候选不重复写');
});

test('renderLessonCandidates：7 天过期，只取最后 N 条', () => {
  const h = makeCtx();
  const now = Date.now();
  h.state.files.set('lesson-candidates.jsonl', [
    { at: new Date(now - 8 * 86400000).toISOString(), text: '过期了' },
    { at: new Date(now - 1000).toISOString(), text: '新鲜的' },
    { at: new Date(now - 500).toISOString(), text: '更新的' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const text = h.svc.renderLessonCandidates(1);
  assert.ok(text.includes('更新的'));
  assert.ok(!text.includes('新鲜的'), '只取最后 1 条');
  assert.ok(!text.includes('过期了'));
  assert.ok(text.includes('lesson_write'));
});

test('renderLessonCandidates：没有候选返回空串', () => {
  assert.equal(makeCtx().svc.renderLessonCandidates(), '');
});

test('groupFeedbackRate：样本不足 4 / 窗口过期 / 正常比例', () => {
  const h = makeCtx();
  const now = Date.now();
  assert.equal(h.svc.groupFeedbackRate(null, now), null);
  assert.equal(h.svc.groupFeedbackRate({ groupFeedback: { sent: 3, replied: 2, windowStart: now } }, now), null);
  assert.equal(h.svc.groupFeedbackRate({ groupFeedback: { sent: 5, replied: 3, windowStart: now - 25 * 3600000 } }, now), null);
  assert.equal(h.svc.groupFeedbackRate({ groupFeedback: { sent: 5, replied: 2, windowStart: now } }, now), 0.4);
});

test('computeProactivity：自己说得越多越低（负反馈，防刷屏），值域被夹住', () => {
  const h = makeCtx();
  const now = Date.now();
  const quiet = h.svc.computeProactivity({ recentMessages: Array.from({ length: 20 }, () => ({ isSelf: false, time: now })) }, now);
  const chatty = h.svc.computeProactivity({
    recentMessages: [
      ...Array.from({ length: 20 }, () => ({ isSelf: false, time: now })),
      ...Array.from({ length: 10 }, () => ({ isSelf: true, time: now })),
    ],
  }, now);
  assert.ok(chatty < quiet, '说得越多主动度越低');
  assert.ok(quiet >= 0.01 && quiet <= 0.5);
  assert.ok(chatty >= 0.01 && chatty <= 0.5);
  assert.equal(h.svc.computeProactivity({}, now) >= 0.01, true, '空状态也返回合法值');
});

test('computeProactivity：情绪读不到时回落中性 0.4，不抛错', () => {
  const h = makeCtx({ loadMoodState: () => { throw new Error('情绪文件坏了'); } });
  const v = h.svc.computeProactivity({ recentMessages: [] }, Date.now());
  assert.ok(Number.isFinite(v) && v >= 0.01 && v <= 0.5);
});

test('echoNorm / isPlusOneText：去标记与标点、认「加一」类', () => {
  const h = makeCtx();
  assert.equal(h.svc.echoNorm('[图片] 好 笑 死 了！'), '好笑死了');
  assert.equal(h.svc.echoNorm('[表情]'), '');
  assert.equal(h.svc.isPlusOneText('加一'), true);
  assert.equal(h.svc.isPlusOneText('+1'), true);
  assert.equal(h.svc.isPlusOneText('1'), true);
  assert.equal(h.svc.isPlusOneText('加一啊'), false);
});

test('detectEchoChain：同一句连发 3 次才 ready；「加一」类 2 次就 ready', () => {
  const h = makeCtx();
  const st = {};
  const now = Date.now();
  h.svc.detectEchoChain('group:1', st, { text: '好耶' });
  assert.equal(st.echoState.count, 1);
  assert.equal(st.echoState.ready, undefined);
  h.svc.detectEchoChain('group:1', st, { text: '好耶' });
  h.svc.detectEchoChain('group:1', st, { text: '好耶' });
  assert.equal(st.echoState.count, 3);
  assert.equal(st.echoState.ready, true);

  const st2 = {};
  h.svc.detectEchoChain('group:1', st2, { text: '加一' });
  h.svc.detectEchoChain('group:1', st2, { text: '附议' });
  assert.equal(st2.echoState.ready, true, '加一 + 附议同属 plus 类');

  const st3 = {};
  h.svc.detectEchoChain('group:1', st3, { text: '好耶' });
  h.svc.detectEchoChain('group:1', st3, { text: '完全不同的话' });
  assert.equal(st3.echoState.count, 1, '换了一句就重新计数');
  assert.equal(h.svc.detectEchoChain('private:1', {}, { text: '好耶' }), undefined, '私聊不检测');
});
