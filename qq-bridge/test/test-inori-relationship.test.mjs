// inori-relationship 金标：关系上下文只取当前 scope、只取别人的话、截断与排序符合 PROMPT-SLIM 预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import summarizeRelationshipDefault, { summarizeRelationship, renderRelationship } from '../src/domain/leaves/inori-relationship.js';

const msg = (text, extra = {}) => ({ text, sender: 'A', time: 1000, isSelf: false, ...extra });

test('summarizeRelationship：自己的发言不算互动，空的也不算', () => {
  const out = summarizeRelationship({ messages: [msg('你好'), msg('我说的', { isSelf: true }), { text: '   ' }] });
  assert.equal(out.interactionCount, 1);
  assert.equal(out.recent.length, 1);
});

test('summarizeRelationship：记忆按 scope 过滤（不跨库读），并按时间倒序取前 N', () => {
  const memories = [
    { text: '旧事实', scope: 'private', time: '2026-01-01' },
    { text: '新事实', scope: 'private', time: '2026-03-01' },
    { text: '别的群的事', scope: 'group:999', time: '2026-04-01' },
    { text: '无 scope 也认', time: '2026-02-01' },
  ];
  const out = summarizeRelationship({ memories, scope: 'private', maxFacts: 2 });
  assert.deepEqual(out.facts, ['新事实', '无 scope 也认']);
  assert.equal(out.recentFacts, 2);
});

test('summarizeRelationship：默认预算 3 条事实×80 字 / 3 条互动×60 字', () => {
  const facts = Array.from({ length: 6 }, (_, i) => ({ text: `事实${i}` + '啊'.repeat(200), scope: 'private', time: `2026-01-0${i + 1}` }));
  const messages = Array.from({ length: 6 }, (_, i) => msg(`互动${i}` + '呀'.repeat(200), { time: 1000 + i }));
  const out = summarizeRelationship({ messages, memories: facts, scope: 'private' });
  assert.equal(out.facts.length, 3);
  assert.ok(out.facts.every((f) => f.length <= 80));
  assert.equal(out.recent.length, 3);
  assert.ok(out.recent.every((r) => r.text.length <= 60));
});

test('summarizeRelationship：lastInteractionAt 取最后一条互动时间，没有就是 0', () => {
  const out = summarizeRelationship({ messages: [msg('a', { time: 500 }), msg('b', { time: 900 })] });
  assert.equal(out.lastInteractionAt, 900);
  assert.equal(summarizeRelationship({}).lastInteractionAt, 0);
});

test('summarizeRelationship：sender 回落到 userId，再回落到「未知」', () => {
  const out = summarizeRelationship({
    messages: [{ text: 'x', userId: 123 }, { text: 'y' }],
  });
  assert.equal(out.recent[0].sender, '123');
  assert.equal(out.recent[1].sender, '未知');
});

test('renderRelationship：空内容不出块；有事实/互动时分开列', () => {
  assert.equal(renderRelationship(null), '');
  assert.equal(renderRelationship({ recent: [], facts: [] }), '');
  const text = renderRelationship({ facts: ['喜欢猫'], recent: [{ sender: 'A', text: '在吗' }] });
  assert.ok(text.startsWith('最近关系上下文'));
  assert.ok(text.includes('- 已记录事实：喜欢猫'));
  assert.ok(text.includes('- 最近互动（A）：在吗'));
});

test('默认导出就是 summarizeRelationship', () => {
  assert.equal(summarizeRelationshipDefault, summarizeRelationship);
});
