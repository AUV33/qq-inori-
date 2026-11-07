// model-catalog-service 金标：优先新接口，只在"接口不存在"时回落老接口，其它错误照抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalog } from '../src/domain/persona/model-catalog-service.mjs';

function makeCtx(handlers) {
  const calls = [];
  const svc = createModelCatalog({
    cfg: {}, log: () => {}, state: {},
    api: {
      callUnary: async (method, payload) => {
        calls.push({ method, payload });
        return handlers[method]();
      },
    },
    TOKEN_USAGE_FILE: 'token-usage.jsonl',
    createTurnCollector: () => ({}),
    createSessionTelemetry: () => ({}),
    createTokenLedger: () => ({}),
    resolvePriceTable: () => ({}),
  });
  return { svc, calls };
}

test('新接口可用：只调一次 session.modelCatalog', async () => {
  const h = makeCtx({ 'session.modelCatalog': async () => ({ models: [{ id: 'm1' }] }) });
  assert.deepEqual(await h.svc.fetchModelCatalog(), { models: [{ id: 'm1' }] });
  assert.deepEqual(h.calls.map((c) => c.method), ['session.modelCatalog']);
});

test('接口不存在（not found / unsupported / 404）→ 回落 session.models', async () => {
  for (const message of ['method not found', 'unsupported method', 'HTTP 404', 'invalid server-response']) {
    const h = makeCtx({
      'session.modelCatalog': async () => { throw new Error(message); },
      'session.models': async () => ({ models: [{ id: 'legacy' }] }),
    });
    assert.deepEqual(await h.svc.fetchModelCatalog(), { models: [{ id: 'legacy' }] }, message);
    assert.deepEqual(h.calls.map((c) => c.method), ['session.modelCatalog', 'session.models']);
  }
});

test('其它错误照抛（不能把网络故障伪装成"模型列表为空"）', async () => {
  const h = makeCtx({ 'session.modelCatalog': async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => h.svc.fetchModelCatalog(), /ECONNREFUSED/);
  assert.equal(h.calls.length, 1, '不该继续试老接口');
});
