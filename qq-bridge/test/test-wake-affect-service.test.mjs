// wake-affect-service 的金标：affect 门控/缓存/群聊不注入、秘书判定放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeAffect } from '../src/domain/conversation/wake-affect-service.mjs';

function ctx(overrides = {}) {
  const saved = [];
  const logs = [];
  const st = { unread: [{ seq: 1, text: '你好', time: Date.now() }], recentMessages: [], affectCache: null };
  const base = {
    cfg: { socialV2: { affect: { enabled: true, groupInject: false, minConfidence: 0.55 }, secretary: {} } },
    log: (line) => logs.push(line),
    getSocialV2State: () => st,
    saveSocialV2State: () => saved.push(1),
    scheduleWakeV2: () => {},
    aggregateFeel: () => ({ affect: '平静', confidence: 0.8, evidence: [], note: '' }),
    renderFeelHint: () => 'feel-line',
    correctTarget: (x) => x,
    fuseJudgement: (rule) => ({ ...rule, source: 'rule' }),
    isDirectedAtAi: () => false,
    classifyAffectOnnx: async () => null,
    ensureEmotionServer: () => {},
    shouldTrustOnnx: () => false,
    onnxJudgement: () => ({}),
    pickExamples: async () => [],
    judgeByModel: async () => null,
    local3bAlive: async () => false,
    local3bBase: () => 'http://local',
    ensureLocal3b: async () => {},
    touchLocal3b: () => {},
    completeLocal3b: async () => '{"allow":true}',
    shouldJudge: () => false,
    gateEmbedTexts: async () => [],
    buildSecretaryPrompt: () => 'secretary-prompt',
    parseSecretaryVerdict: () => ({ allow: true }),
    secretaryAllows: () => true,
    shouldConsultSecretary: () => true,
    selfNickname: '祈',
  };
  Object.assign(base, overrides);
  return { svc: createWakeAffect(base), st, saved, logs };
}

test('affectWhoLabel：私聊叫他，群聊说这个人', () => {
  const h = ctx();
  assert.equal(h.svc.affectWhoLabel('private:1'), '他');
  assert.equal(h.svc.affectWhoLabel('group:1'), '这个说话的人');
});

test('prepareAffectHint：关闭时不判读', async () => {
  const h = ctx({ cfg: { socialV2: { affect: { enabled: false } } } });
  await h.svc.prepareAffectHint('private:1', 'wake');
  assert.equal(h.saved.length, 0);
});

test('prepareAffectHint：群聊默认只记日志不注入、不写缓存', async () => {
  const h = ctx();
  await h.svc.prepareAffectHint('group:1', 'wake');
  assert.equal(h.st.pendingFeel, null);
  assert.equal(h.st.affectCache, null);
  assert.equal(h.saved.length, 1);
  assert.match(h.logs.at(-1), /群聊只记日志/);
});

test('prepareAffectHint：私聊注入并写缓存', async () => {
  const h = ctx();
  await h.svc.prepareAffectHint('private:1', 'wake');
  assert.deepEqual(h.st.pendingFeel.text, 'feel-line');
  assert.equal(h.st.affectCache.seq, 1);
  assert.equal(h.saved.length, 1);
});

test('prepareAffectHint：命中缓存时不重复调模型', async () => {
  const h = ctx();
  h.st.affectCache = { seq: 1, fused: { affect: '开心', confidence: 0.9, source: 'model' }, at: Date.now() };
  await h.svc.prepareAffectHint('private:1', 'wake');
  assert.equal(h.st.pendingFeel.text, 'feel-line');
  assert.match(h.logs.at(-1), /cache/);
});

test('secretaryJudgeForWake：关闭/不该问/3B 不在 → null', async () => {
  let h = ctx({ cfg: { socialV2: { secretary: { enabled: false } } } });
  assert.equal(await h.svc.secretaryJudgeForWake({ key: 'group:1', st: {}, reason: 'probability', sender: 'a', text: 'x' }), null);
  h = ctx({ shouldConsultSecretary: () => false });
  assert.equal(await h.svc.secretaryJudgeForWake({ key: 'group:1', st: {}, reason: 'probability', sender: 'a', text: 'x' }), null);
  h = ctx();
  assert.equal(await h.svc.secretaryJudgeForWake({ key: 'group:1', st: {}, reason: 'probability', sender: 'a', text: 'x' }), null);
});

test('secretaryJudgeForWake：3B 可用 → 解析并返回判定', async () => {
  const h = ctx({ local3bAlive: async () => true });
  const r = await h.svc.secretaryJudgeForWake({ key: 'group:1', st: { recentMessages: [] }, reason: 'probability', sender: 'a', text: 'x' });
  assert.deepEqual(r, { allow: true });
});
