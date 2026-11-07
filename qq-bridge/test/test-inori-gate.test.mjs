// inori-gate 金标：注意门的纯函数层——锚点整理、批次门控、精判 prompt、回复解析、余弦与阈值调参。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_DEFAULTS, GATE_SENSITIVITY_RANGE, anchorSet, shouldBatch, shapeMessages, gatePayloadText,
  parseGateReply, cosine, maxAnchorCosine, embedChunks, clampGateSensitivity, effectiveGateThreshold,
  parseGateSensitivityOverride,
} from '../src/domain/leaves/inori-gate.js';

test('anchorSet：selfName 优先、去重、去空白、超长丢弃、限量', () => {
  const anchors = anchorSet({
    selfName: '小满',
    keywords: ['方舟', ' 方舟 ', ''],
    goalTitles: ['把群记忆整理好'],
    openLoops: ['x'.repeat(40)],
    recentTopics: ['话题A'],
  }, { maxAnchors: 3, maxChars: 10 });
  assert.deepEqual(anchors, ['小满', '方舟', '把群记忆整理好'], '第一个是名字，重复与超长被丢，maxAnchors 生效');
});

test('anchorSet：缺省/非数组输入安全', () => {
  assert.deepEqual(anchorSet({}), []);
  // 字符串清单按"一个锚点"处理（config 里写成字符串不该让门判崩掉）
  assert.deepEqual(anchorSet({ keywords: null, goalTitles: '想整理群记忆' }), ['想整理群记忆']);
});

test('shouldBatch：条数够且距上次门判够久才判', () => {
  const now = 1_000_000;
  assert.equal(shouldBatch({ pending: 4, now, lastGateAt: 0 }), false, '不到 minPending');
  assert.equal(shouldBatch({ pending: 5, now, lastGateAt: 0 }), true);
  assert.equal(shouldBatch({ pending: 9, now, lastGateAt: now - 1000 }), false, '90s 内不重复判');
  assert.equal(shouldBatch({ pending: 9, now, lastGateAt: now - 90_000 }), true);
  assert.equal(shouldBatch({ pending: 2, now, lastGateAt: 0, minPending: 2, intervalMs: 0 }), true, '参数可覆盖');
});

test('shapeMessages：过滤自己的/空的，取最后一批，编号从 1，文本与发送者截断', () => {
  const shaped = shapeMessages([
    { sender: 'A', text: ' 第一条  ', isSelf: false, seq: 11 },
    { sender: '我', text: '自己说的', isSelf: true, seq: 12 },
    { sender: 'B', text: '   ', isSelf: false, seq: 13 },
    { sender: 'C'.repeat(40), text: '正文'.repeat(100), isSelf: false, seq: 14 },
  ], { batchMax: 2, msgChars: 10 });
  assert.equal(shaped.length, 2);
  assert.deepEqual(shaped.map((x) => x.i), [1, 2]);
  assert.deepEqual(shaped.map((x) => x.seq), [11, 14], '必须保留 seq（清洗后剩两条：11 与 14）');
  assert.equal(shaped[0].sender, 'A');
  assert.equal(shaped[1].sender.length, 30);
  assert.equal(shaped[1].text.length, 10);
});

test('gatePayloadText：包含 Agent/锚点编号/消息编号；空批次有占位', () => {
  const text = gatePayloadText({
    agentName: '小满',
    anchors: ['方舟', '群记忆'],
    messages: [{ i: 1, sender: 'A', text: '在吗' }],
  });
  assert.ok(text.includes('【判定请求】'));
  assert.ok(text.includes('【Agent】小满'));
  assert.ok(text.includes('1. 方舟\n2. 群记忆'));
  assert.ok(text.includes('1. [A] 在吗'));
  assert.ok(text.includes('严格 JSON'));

  const empty = gatePayloadText({ agentName: 'x', anchors: [], messages: [] });
  assert.ok(empty.includes('（无）'));
  assert.ok(empty.includes('（空批次）'));
});

test('parseGateReply：容忍代码块/前后缀，取第一个 JSON；非法则空', () => {
  const ok = parseGateReply('好的：\n```json\n{"hits":[{"i":2,"why":"叫他"}]}\n```');
  assert.deepEqual(ok.hits, [{ i: 2, why: '叫他' }]);

  assert.deepEqual(parseGateReply('').hits, []);
  assert.deepEqual(parseGateReply('没有 JSON').hits, []);
  assert.deepEqual(parseGateReply('{坏 JSON').hits, []);
});

test('parseGateReply：过滤非法编号，why 截断 40 字', () => {
  const r = parseGateReply(JSON.stringify({ hits: [{ i: 0 }, { i: -1 }, { i: 'x' }, { i: 3, why: '啊'.repeat(60) }] }));
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].i, 3);
  assert.equal(r.hits[0].why.length, 40);
});

test('cosine：等长向量算相似度；长度不齐/含零向量返回 -1（按不命中处理）', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0, 0], [1, 0]), -1);
  assert.equal(cosine([0, 0], [1, 0]), -1);
  assert.equal(cosine(null, [1]), -1);
});

test('maxAnchorCosine：返回一批文本对锚点的最高分', () => {
  const r = maxAnchorCosine([[1, 0], [0.6, 0.8]], [[1, 0]]);
  assert.equal(r.best, 1);
  assert.equal(r.anchor, null, '锚点是纯数组，没有 name 字段（目前不解析锚点名）');
  assert.equal(maxAnchorCosine([], [[1, 0]]).best, -1);
});

test('embedChunks：按 embedBatch 切块，最后一块允许不满', () => {
  const chunks = embedChunks(Array.from({ length: 20 }, (_, i) => `t${i}`), { batch: 16 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 16);
  assert.equal(chunks[1].length, 4);
  assert.deepEqual(embedChunks([], { batch: 3 }), []);
});

test('clampGateSensitivity / effectiveGateThreshold：范围 0.4~0.8，覆盖值优先但也要夹', () => {
  assert.deepEqual(GATE_SENSITIVITY_RANGE, { min: 0.4, max: 0.8 });
  assert.equal(clampGateSensitivity(0.1), 0.4);
  assert.equal(clampGateSensitivity(0.9), 0.8);
  assert.equal(clampGateSensitivity('abc'), null);

  assert.equal(effectiveGateThreshold(0.6, null), 0.6, '没覆盖就用基线');
  assert.equal(effectiveGateThreshold(0.6, 0.7), 0.7, '覆盖值优先');
  assert.equal(effectiveGateThreshold(0.6, 9), 0.8, '覆盖值也要夹');
  assert.equal(effectiveGateThreshold(0.6, ''), 0.6, '空串等于没覆盖');
  assert.equal(effectiveGateThreshold('x', 'y'), GATE_DEFAULTS.cosThreshold, '都非法回落默认');
});

test('parseGateSensitivityOverride：BOM/坏 JSON/数组都当无效；合法时只留安全字段', () => {
  assert.equal(parseGateSensitivityOverride(''), null);
  assert.equal(parseGateSensitivityOverride('不是 JSON'), null);
  assert.equal(parseGateSensitivityOverride('[1,2]'), null);
  const ok = parseGateSensitivityOverride('\ufeff' + JSON.stringify({ cosThreshold: 0.7, by: '她', reason: '太吵', at: '2026-11-02', extra: '丢掉' }));
  assert.deepEqual(ok, { cosThreshold: 0.7, by: '她', reason: '太吵', at: '2026-11-02' });
  const partial = parseGateSensitivityOverride(JSON.stringify({ by: 'x'.repeat(40) }));
  assert.equal(partial.by.length, 16);
  assert.equal(partial.cosThreshold, undefined);
});
