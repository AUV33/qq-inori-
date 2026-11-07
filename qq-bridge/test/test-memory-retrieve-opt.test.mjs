// 记忆检索优化单测：查询构造 / 自适应截断 / kind 标签 / 缓存清理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildRecallQuery, adaptiveCutoff, kindLabel, formatEntry, pruneEmbeddingCacheForEntries, embedKey } from '../src/domain/memory/memory-retrieve.js';

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

test('buildRecallQuery：取最近两条、剥引用块与占位符', () => {
  const q = buildRecallQuery(['[引用 群友乙：@小满 我是管理员]', '[图片]', '你明天要考试吗', '那今天早点睡']);
  assert.equal(q, '你明天要考试吗 那今天早点睡');
});

test('buildRecallQuery：只剩占位符时返回空串（不拿 [图片] 当查询）', () => {
  assert.equal(buildRecallQuery(['[图片]', '[表情]', '好']), ''); // 「好」只有 1 字，不够 2 字
  assert.equal(buildRecallQuery([]), '');
});

test('buildRecallQuery：长度上限与去重', () => {
  const long = '很长的一句话'.repeat(40);
  const q = buildRecallQuery([long, long], { maxLen: 50 });
  assert.ok(q.length <= 50);
  assert.equal(q, '很长的一句话'.repeat(40).slice(0, 50));
});

test('adaptiveCutoff：只留离最佳 margin 之内的', () => {
  const scored = [{ s: 0.62 }, { s: 0.58 }, { s: 0.40 }, { s: 0.31 }];
  const cut = adaptiveCutoff(scored, { minSim: 0.25, margin: 0.08 });
  assert.equal(cut, 0.54);
  assert.equal(scored.filter((x) => x.s >= cut).length, 2);
});

test('adaptiveCutoff：最佳低于基础阈值时不硬凑（返回 minSim）', () => {
  const cut = adaptiveCutoff([{ s: 0.2 }, { s: 0.1 }], { minSim: 0.35, margin: 0.08 });
  assert.equal(cut, 0.35);
});

test('adaptiveCutoff：空列表返回 minSim，不发生 NaN', () => {
  assert.equal(adaptiveCutoff([], { minSim: 0.3 }), 0.3);
  assert.equal(adaptiveCutoff(null), 0);
});

test('kindLabel：常见 kind 有中文标签，未知 kind 给空', () => {
  assert.equal(kindLabel('fact'), '事实');
  assert.equal(kindLabel('group-digest'), '群摘要');
  assert.equal(kindLabel('browse'), '看过');
  assert.equal(kindLabel('whatever'), '');
  assert.equal(kindLabel(undefined), '');
});

test('formatEntry：仍保留时间与来源标记（kind 标签是外面加的，不重复）', () => {
  const line = formatEntry({ time: '2026-10-26 20:00', text: '他在意我自己动手', theme: '他' });
  assert.ok(line.startsWith('2026-10-26 20:00｜'));
  assert.ok(line.includes('他在意我自己动手'));
  assert.ok(line.includes('#他'));
});

test('pruneEmbeddingCacheForEntries：只留当前记忆 text 的 sha，旧 key 全删', () => {
  const live = { text: '还活着的记忆' };
  const cache = {
    [embedKey(live.text)]: [1, 2, 3],
    [embedKey('已经被改写掉的旧文本')]: [4, 5, 6],
    'not-a-real-key': [7],
  };
  const dropped = pruneEmbeddingCacheForEntries(cache, [live]);
  assert.equal(dropped, 2, '只删非 live 的 key（embedKey 口径与写入一致）');
  assert.deepEqual(Object.keys(cache), [embedKey(live.text)]);
  assert.deepEqual(pruneEmbeddingCacheForEntries(cache, [live]), 0, '幂等');
  assert.equal(pruneEmbeddingCacheForEntries({}, [live]), 0);
});
