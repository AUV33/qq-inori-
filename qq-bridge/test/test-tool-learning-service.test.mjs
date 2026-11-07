// tool-learning-service 金标：反馈表裁剪/脱敏、工具日志读取、回合结束的技能成败自动记账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolLearning } from '../src/domain/memory/tool-learning-service.mjs';

function makeCtx(overrides = {}) {
  const state = {
    feedback: [],
    skills: { items: [{ id: 's1', verify: '文件:out.txt' }, { id: 's2' }] },
    outcomes: [],
    savedSkills: 0,
    savedSocial: 0,
    logs: [],
    feedbackFile: null,
    toolLog: '',
  };
  const turnToolStats = new Map();
  const svc = createToolLearning({
    fs: { readFileSync: (f) => { if (f === 'tool-log.jsonl') return state.toolLog; throw new Error('ENOENT'); } },
    cfg: { socialV2: { skills: { file: 'skills.json' } } },
    log: (m) => state.logs.push(String(m)),
    readJsonSafe: (f, dflt) => (state.feedbackFile === null ? dflt : state.feedbackFile),
    atomicWriteJson: (f, v) => { state.feedback = v; state.feedbackFile = v; },
    FEEDBACK_FILE: 'feedback.json',
    TOOL_LOG_FILE: 'tool-log.jsonl',
    redactSensitiveText: (s) => String(s).replace(/sk-[a-z0-9]+/gi, '***'),
    turnToolStats,
    getSocialV2State: (key) => (state.conv ??= { $skillIds: [] }),
    takeTaskSkillIds: () => state.taskIds ?? [],
    recordSkillAttempt: (ids, outcome) => state.logs.push(`attempt:${ids.join(',')}:${outcome}`),
    loadSkills: () => ({ items: state.skills.items.map((x) => ({ ...x })) }),
    checkVerify: async (spec) => ({ ok: state.verifyOk ?? true, evidence: '文件存在' }),
    applyOutcome: (store, id, payload) => { state.outcomes.push({ id, ...payload }); return true; },
    saveSkills: () => { state.savedSkills += 1; },
    saveSocialV2State: () => { state.savedSocial += 1; },
    ...overrides,
  });
  return { svc, state, turnToolStats };
}

test('readFeedbackEntries：非数组/读不到都回落空数组', () => {
  const h = makeCtx();
  assert.deepEqual(h.svc.readFeedbackEntries(), []);
  h.state.feedbackFile = { not: 'array' };
  assert.deepEqual(h.svc.readFeedbackEntries(), []);
  h.state.feedbackFile = [{ a: 1 }];
  assert.deepEqual(h.svc.readFeedbackEntries(), [{ a: 1 }]);
});

test('appendFeedbackEntry：脱敏 message，且最多保留 500 条（丢最旧的）', () => {
  const h = makeCtx();
  h.state.feedbackFile = Array.from({ length: 500 }, (_, i) => ({ i }));
  h.svc.appendFeedbackEntry({ message: '用 sk-abc123 调一下' });
  assert.equal(h.state.feedback.length, 500, '上限 500');
  const last = h.state.feedback[h.state.feedback.length - 1];
  assert.equal(last.message, '用 *** 调一下');
  assert.equal(h.state.feedback[0].i, 1, '最旧的一条被丢掉');
});

test('readToolLog：只解析最后 N 行，坏行跳过、文件不存在返回空', () => {
  const h = makeCtx();
  h.state.toolLog = ['{"n":1}', '坏行', '{"n":3}', '{"n":4}'].join('\n');
  assert.deepEqual(h.svc.readToolLog(2), [{ n: 3 }, { n: 4 }]);
  assert.deepEqual(h.svc.readToolLog(), [{ n: 1 }, { n: 3 }, { n: 4 }], '坏行跳过');
  h.state.toolLog = '';
  assert.deepEqual(makeCtx({ fs: { readFileSync: () => { throw new Error('ENOENT'); } } }).svc.readToolLog(), []);
});

test('applyTurnToolLearning：没有统计就什么都不做（也不会清会话状态）', async () => {
  const h = makeCtx();
  await h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'completed' } });
  assert.equal(h.state.outcomes.length, 0);
  assert.equal(h.state.savedSocial, 0);
});

test('applyTurnToolLearning：消费统计并删除；taskIds 优先于会话里的 $skillIds', async () => {
  const h = makeCtx();
  h.turnToolStats.set('sid', { names: ['qq_send'], ok: 1, fail: 0 });
  h.state.taskIds = ['s1'];
  h.state.conv = { $skillIds: ['s2'] };
  await h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'completed' } });
  assert.equal(h.turnToolStats.has('sid'), false, '统计只能消费一次');
  assert.ok(h.state.logs.includes('attempt:s1:completed'));
  assert.equal(h.state.conv.$skillIds.length, 0, '会话里的技能 id 要清空');
  assert.equal(h.state.savedSocial, 1);
});

test('applyTurnToolLearning：工具全失败 → 记失败并带 hint', async () => {
  const h = makeCtx();
  h.turnToolStats.set('sid', { names: ['qq_send'], ok: 0, fail: 2, lastError: '权限不足'.repeat(50) });
  h.state.taskIds = ['s2'];
  await h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'completed' } });
  const out = h.state.outcomes[0];
  assert.equal(out.id, 's2');
  assert.equal(out.ok, false);
  assert.ok(out.hint.length <= 160, 'hint 要截断');
  assert.equal(h.state.savedSkills, 1);
});

test('applyTurnToolLearning：回合完成 + 文件判据通过 → 算 verify 成功', async () => {
  const h = makeCtx();
  h.turnToolStats.set('sid', { names: ['qq_send'], ok: 1, fail: 0 });
  h.state.taskIds = ['s1'];
  h.state.verifyOk = true;
  await h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'completed' } });
  const out = h.state.outcomes[0];
  assert.equal(out.ok, true);
  assert.equal(out.verifiedBy, 'verify');
  assert.equal(out.evidence, '文件存在');
});

test('applyTurnToolLearning：没有判据的完成回合只记 attempt（ok=null），不冒充成功', async () => {
  const h = makeCtx();
  h.turnToolStats.set('sid', { names: ['qq_send'], ok: 2, fail: 0 });
  h.state.taskIds = ['s2'];
  await h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'completed' } });
  const out = h.state.outcomes[0];
  assert.equal(out.ok, null);
  assert.equal(out.source, 'turn');
});

test('applyTurnToolLearning：未完成的回合不算 attempt，也不写结果', async () => {
  const h = makeCtx();
  h.turnToolStats.set('sid', { names: ['qq_send'], ok: 1, fail: 0 });
  h.state.taskIds = ['s2'];
  await h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'aborted' } });
  assert.equal(h.state.outcomes.length, 0);
  assert.ok(h.state.logs.includes('attempt:s2:aborted'));
});

test('applyTurnToolLearning：技能库读取抛错被吞掉，但会话状态仍清空', async () => {
  const h = makeCtx({ loadSkills: () => { throw new Error('库坏了'); } });
  h.turnToolStats.set('sid', { names: ['qq_send'], ok: 1, fail: 0 });
  h.state.taskIds = ['s1'];
  await assert.doesNotReject(() => h.svc.applyTurnToolLearning('group:1', 'sid', { reason: { kind: 'completed' } }));
  assert.equal(h.state.conv.$skillIds.length, 0);
  assert.equal(h.state.savedSocial, 1);
});
