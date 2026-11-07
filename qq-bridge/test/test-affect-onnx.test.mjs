import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTrustOnnx, classifyAffectOnnx, onnxJudgement, ensureEmotionServer } from '../src/domain/memory/local-affect-classifier.js';

test('shouldTrustOnnx：置信度不够就不采信（实测只有 ~69%，阈值故意高）', () => {
  assert.equal(shouldTrustOnnx({ label: '发火', confidence: 0.5, margin: 0.3 }), false);
  assert.equal(shouldTrustOnnx({ label: '发火', confidence: 0.72, margin: 0.05 }), false, 'margin 太窄不采信');
  assert.equal(shouldTrustOnnx({ label: '发火', confidence: 0.72, margin: 0.2 }), true);
  assert.equal(shouldTrustOnnx(null), false);
  assert.equal(shouldTrustOnnx({}), false);
});

test('classifyAffectOnnx：正常返回解析成统一结构', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ ok: true, label: '倾诉', confidence: 0.8, margin: 0.3, ms: 7 }) });
  const r = await classifyAffectOnnx('我撑不住了', { fetchImpl: fake });
  assert.equal(r.label, '倾诉');
  assert.equal(r.confidence, 0.8);
  assert.equal(onnxJudgement(r).affect, '倾诉');
});

test('classifyAffectOnnx：HTTP 错误 / 空文本 / 超时异常都返回 null，调用方降级', async () => {
  assert.equal(await classifyAffectOnnx('', { fetchImpl: async () => ({ ok: true }) }), null);
  assert.equal(await classifyAffectOnnx('x', { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await classifyAffectOnnx('x', { fetchImpl: async () => { throw new Error('down'); } }), null);
});

test('shouldTrustOnnx：阈值可配；margin 缺失时只卡置信度', () => {
  const r = { label: 'joy', confidence: 0.6, margin: 0.2 };
  assert.equal(shouldTrustOnnx(r, { minConfidence: 0.5 }), true, '放宽置信阈值后采信');
  assert.equal(shouldTrustOnnx(r, { minConfidence: 0.8 }), false, '收紧置信阈值后拒信');
  assert.equal(shouldTrustOnnx({ label: 'joy', confidence: 0.9, margin: 0.1 }, { minMargin: 0.05 }), true);
  // margin 非有限数时跳过 margin 判据（ONNX 二分类有时只给 confidence）
  assert.equal(shouldTrustOnnx({ label: 'joy', confidence: 0.9 }), true);
});

test('classifyAffectOnnx：ok=false / 无 label 的响应也降级为 null', async () => {
  assert.equal(await classifyAffectOnnx('x', { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, label: 'x' }) }) }), null);
  assert.equal(await classifyAffectOnnx('x', { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, label: '' }) }) }), null);
});

test('onnxJudgement：完整字段映射；null 返回 null', () => {
  assert.equal(onnxJudgement(null), null);
  assert.deepEqual(onnxJudgement({ label: '倾诉', confidence: 0.8 }), {
    affect: '倾诉', target: '无', confidence: 0.8, intent: '', evidence: '',
  });
});

test('ensureEmotionServer：python/脚本缺失时返回 false 且不抛', () => {
  assert.equal(ensureEmotionServer({ log: () => {}, python: '/no/such/python.exe' }), false);
});
