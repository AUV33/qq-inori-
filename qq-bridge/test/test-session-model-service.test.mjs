// session-model-service 金标：跟随 DSH / 固定模型 / 思考档回退 / 终态 not-found 记 epoch。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionModel } from '../src/domain/conversation/session-model-service.mjs';

function makeCtx(overrides = {}) {
  const calls = [];
  const applied = new Map();
  let epoch = 1;
  const svcCtx = {
    cfg: { dsh: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } },
    log: () => {},
    api: {
      sessions: {
        selectModel: async (payload) => {
          calls.push(payload);
          if (overrides.fail) return overrides.fail(payload);
          return { selected: { provider: payload.provider, model: payload.model, reasoningEffort: payload.reasoningEffort } };
        },
      },
    },
    unwrap: (v) => v,
    sleep: async () => {},
    modelAppliedSessions: applied,
    getModelSelectionEpoch: () => epoch,
    REASONING_EFFORT_DEFAULT: 'max',
    ...overrides,
  };
  return {
    svc: createSessionModel(svcCtx),
    calls,
    applied,
    bumpEpoch: () => { epoch += 1; },
  };
}

test('已应用过且 epoch 未变 → 直接 applied，不重复调 API', async () => {
  const h = makeCtx();
  assert.equal(await h.svc.ensureChatModel('s1'), 'applied');
  assert.equal(h.calls.length, 1);
  assert.equal(await h.svc.ensureChatModel('s1'), 'applied');
  assert.equal(h.calls.length, 1, '同 epoch 不重复设置');
});

test('epoch 变了要重新设置（控制台换模型后能让旧会话跟上）', async () => {
  const h = makeCtx();
  await h.svc.ensureChatModel('s1');
  h.bumpEpoch();
  await h.svc.ensureChatModel('s1');
  assert.equal(h.calls.length, 2);
});

test('followDshModel=true：不 selectModel，直接 applied（DSH 换模型她自动跟着换）', async () => {
  const h = makeCtx({ cfg: { dsh: { followDshModel: true } } });
  assert.equal(await h.svc.ensureChatModel('s1'), 'applied');
  assert.equal(h.calls.length, 0, '跟随模式不能去写 DSH 全局默认模型');
  assert.equal(h.applied.get('s1'), 1);
});

test('思考档不被支持 → 回退 high 再试一次', async () => {
  let first = true;
  const h = makeCtx({
    fail: (payload) => {
      if (first && payload.reasoningEffort === 'max') {
        first = false;
        throw new Error('model does not support reasoning effort max');
      }
      return { selected: { provider: payload.provider, model: payload.model, reasoningEffort: payload.reasoningEffort } };
    },
  });
  assert.equal(await h.svc.ensureChatModel('s1'), 'applied');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].reasoningEffort, 'max');
  assert.equal(h.calls[1].reasoningEffort, 'high', '回退到 high');
});

test('not found 是终态：返回 not-found 并记 epoch（避免刷屏重试）', async () => {
  const h = makeCtx({
    fail: () => { throw new Error('session not found'); },
  });
  assert.equal(await h.svc.ensureChatModel('s1'), 'not-found');
  assert.equal(h.applied.get('s1'), 1, '终态也要记 epoch');
  assert.equal(h.calls.length, 2, '重试到第 2 次为止，之后按终态收口');
  // 记了 epoch 之后同一会话再问就是 applied，不会无限重试
  assert.equal(await h.svc.ensureChatModel('s1'), 'applied');
});

test('其它错误重试两次后返回 failed，且不记 epoch', async () => {
  const h = makeCtx({ fail: () => { throw new Error('boom'); } });
  assert.equal(await h.svc.ensureChatModel('s1'), 'failed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.applied.has('s1'), false);
});
