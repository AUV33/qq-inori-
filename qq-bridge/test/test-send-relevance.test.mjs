// send-relevance 金标：拿不到向量一律放行（null），算得出就给最大余弦；只做否决不改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relevanceCos } from '../src/domain/send/send-relevance.js';

const realFetch = globalThis.fetch;
function withFetch(impl) {
  globalThis.fetch = impl;
  return () => { globalThis.fetch = realFetch; };
}

test('没有正文或没有最近消息 → null（调用方放行）', async () => {
  assert.equal(await relevanceCos('', ['a', 'b']), null);
  assert.equal(await relevanceCos('要说的话', []), null);
  assert.equal(await relevanceCos('要说的话', ['  ', null]), null);
});

test('接口非 2xx → null（宁可让她说，不因工程故障堵嘴）', async () => {
  const restore = withFetch(async () => ({ ok: false, status: 500 }));
  try { assert.equal(await relevanceCos('话', ['别人的话']), null); } finally { restore(); }
});

test('向量条数对不上 → null', async () => {
  const restore = withFetch(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) }));
  try { assert.equal(await relevanceCos('话', ['别人的话']), null); } finally { restore(); }
});

test('正常返回：取与最近几条里最相似的那条的余弦', async () => {
  const restore = withFetch(async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }, { embedding: [0.8, 0.2] }] }),
  }));
  try {
    const r = await relevanceCos('要说的话', ['无关的话', '相关的话']);
    assert.ok(r && r.cos > 0.9, `期望接近 1，实际 ${r && r.cos}`);
    assert.equal(typeof r.cos, 'number');
  } finally { restore(); }
});

test('请求抛错/超时 → null', async () => {
  const restore = withFetch(async () => { throw new Error('ECONNREFUSED'); });
  try { assert.equal(await relevanceCos('话', ['别人的话']), null); } finally { restore(); }
});

test('只取最近 6 条别人的话（避免长上下文拖慢发送）', async () => {
  let seenInput = null;
  const restore = withFetch(async (url, init) => {
    seenInput = JSON.parse(init.body).input;
    return { ok: true, json: async () => ({ data: seenInput.map(() => ({ embedding: [1, 0] })) }) };
  });
  try {
    await relevanceCos('话', Array.from({ length: 10 }, (_, i) => `第${i}条`), { url: 'http://x', model: 'm' });
    assert.equal(seenInput.length, 7, '1 条正文 + 6 条最近');
    assert.equal(seenInput[0], '话');
    assert.deepEqual(seenInput.slice(1), ['第4条', '第5条', '第6条', '第7条', '第8条', '第9条']);
  } finally { restore(); }
});
