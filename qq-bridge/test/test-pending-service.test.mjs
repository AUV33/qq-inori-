// pending-service 的契约金标：提问/审批回执、拍一拍过滤、挂起覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingService } from '../src/domain/conversation/pending-service.mjs';

function ctx(overrides = {}) {
  const pending = new Map();
  const calls = { respond: [], notices: [], sent: [], activity: [], wakes: [], pokes: [] };
  const state = { mode: 'reserved2', paused: false, st: { bootstrapSent: true, wakeConfig: { triggers: { poke: true } } } };
  const base = {
    api: { respond: async (payload) => { calls.respond.push(payload); return { ok: true }; } },
    withTimeout: (p) => p,
    log: () => {},
    pending,
    sendNotice: async (key, text) => { calls.notices.push([key, text]); },
    sendToQQ: async (key, text) => { calls.sent.push([key, text]); },
    APPROVE_WORDS: ['通过', '同意'],
    REJECT_WORDS: ['拒绝'],
    cfg: { ownerQQ: 123, questionTimeoutMs: 60000 },
    getCurrentMode: () => state.mode,
    modeAllowed: () => true,
    convKey: (kind, id) => `${kind}:${id}`,
    appendActivity: (line) => calls.activity.push(line),
    cleanMemberName: (s) => s,
    resolveGroupMemberName: async () => '群友',
    appendSocialV2Poke: (key, poke) => { calls.pokes.push({ key, poke }); return { text: '拍一拍' }; },
    socialV2: { get paused() { return state.paused; } },
    getSocialV2State: () => state.st,
    saveSocialV2State: () => {},
    scheduleWakeV2: (key, reason) => calls.wakes.push([key, reason]),
  };
  Object.assign(base, overrides);
  return { svc: createPendingService(base), pending, calls, state };
}

test('提问：命中选项按 label 回执并删除挂起', async () => {
  const h = ctx();
  const p = { kind: 'question', clientId: 'c', eventId: 'e', questions: [{ id: 'q1', options: [{ label: 'A' }, { label: 'B' }] }] };
  h.pending.set('group:1', p);
  await h.svc.handlePendingAnswer(p, 'a', 'group:1');
  assert.equal(h.calls.respond[0].outcome.value.answers[0].selected[0], 'A');
  assert.equal(h.pending.has('group:1'), false);
});

test('提问：未命中选项走 custom，仍回执', async () => {
  const h = ctx();
  const p = { kind: 'question', clientId: 'c', eventId: 'e', questions: [{ id: 'q1', options: [{ label: 'A' }] }] };
  h.pending.set('private:1', p);
  await h.svc.handlePendingAnswer(p, '随便说点', 'private:1');
  const ans = h.calls.respond[0].outcome.value.answers[0];
  assert.deepEqual(ans.selected, []);
  assert.equal(ans.custom, '随便说点');
});

test('审批：非 owner 直接拒绝，不回执', async () => {
  const h = ctx();
  const p = { kind: 'approval', clientId: 'c', eventId: 'e' };
  await h.svc.handlePendingAnswer(p, '通过', 'group:1', false);
  assert.equal(h.calls.respond.length, 0);
  assert.match(h.calls.sent[0][1], /仅管理员/);
});

test('审批：owner 通过/拒绝/无效词', async () => {
  const h = ctx();
  const p = { kind: 'approval', clientId: 'c', eventId: 'e' };
  await h.svc.handlePendingAnswer(p, '通过', 'private:123', true);
  assert.equal(h.calls.respond[0].outcome.value, 'allowed-once');
  assert.match(h.calls.sent.at(-1)[1], /已通过/);
  await h.svc.handlePendingAnswer(p, '拒绝', 'private:123', true);
  assert.equal(h.calls.respond[1].outcome.value, 'rejected');
  const before = h.calls.respond.length;
  await h.svc.handlePendingAnswer(p, '随便', 'private:123', true);
  assert.equal(h.calls.respond.length, before);
  assert.match(h.calls.sent.at(-1)[1], /请回复/);
});

test('取消挂起：审批/提问都回 DSH 回执', async () => {
  const h = ctx();
  await h.svc.cancelPendingEntry({ kind: 'approval', clientId: 'c', eventId: 'e' });
  await h.svc.cancelPendingEntry({ kind: 'question', clientId: 'c', eventId: 'e2' });
  assert.equal(h.calls.respond[0].outcome.value, 'rejected');
  assert.deepEqual(h.calls.respond[1].outcome.value, { answers: [] });
});

test('registerPending：覆盖旧挂起并清理旧 timer', async () => {
  const h = ctx();
  const old = { kind: 'question', eventId: 'old' };
  h.svc.registerPending('group:1', old);
  assert.equal(h.pending.get('group:1'), old);
  const next = { kind: 'question', eventId: 'new' };
  h.svc.registerPending('group:1', next);
  assert.equal(h.pending.get('group:1'), next);
  clearTimeout(next.timer);
});

test('拍一拍：非 poke/自己拍自己 直接忽略', async () => {
  const h = ctx();
  await h.svc.handlePokeNotice({ sub_type: 'notify' });
  await h.svc.handlePokeNotice({ sub_type: 'poke', self_id: 123, sender_id: 123 });
  assert.equal(h.calls.pokes.length, 0);
});

test('拍一拍：非 reserved2 只记活动，不写消息/不唤醒', async () => {
  const h = ctx();
  h.state.mode = 'chat';
  await h.svc.handlePokeNotice({ sub_type: 'poke', self_id: 999, group_id: 1, sender_id: 456, target_id: 999 });
  assert.equal(h.calls.pokes.length, 0);
  assert.equal(h.calls.wakes.length, 0);
  assert.match(h.calls.activity[0], /非 reserved2/);
});

test('拍一拍：reserved2 首拍 bootstrap，之后被拍才 poke 唤醒', async () => {
  const h = ctx();
  h.state.st = { bootstrapSent: false, wakeConfig: { triggers: { poke: true } } };
  await h.svc.handlePokeNotice({ sub_type: 'poke', self_id: 999, group_id: 1, sender_id: 456, target_id: 999 });
  assert.deepEqual(h.calls.wakes[0], ['group:1', 'bootstrap']);
  h.state.st.bootstrapSent = true;
  await h.svc.handlePokeNotice({ sub_type: 'poke', self_id: 999, group_id: 1, sender_id: 456, target_id: 999 });
  assert.deepEqual(h.calls.wakes[1], ['group:1', 'poke']);
  // 别人互拍不唤醒
  await h.svc.handlePokeNotice({ sub_type: 'poke', self_id: 999, group_id: 1, sender_id: 456, target_id: 789 });
  assert.equal(h.calls.wakes.length, 2);
});
