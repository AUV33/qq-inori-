import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPacket, purposeCaps, promptTextOf, stripKnownTokens, collectSessionTokens } from '../src/domain/conversation/context-packet.js';

test('purpose 能力表：只有 chat/task 允许令牌', () => {
  assert.equal(purposeCaps('chat').tokens, true);
  assert.equal(purposeCaps('task').tokens, true);
  assert.equal(purposeCaps('isolated').tokens, false);
  assert.equal(purposeCaps('gate').tokens, false);
  assert.equal(purposeCaps('不存在的').tokens, false, '未知 purpose 一律按最保守处理');
});

test('isolated 携带令牌 → 构造时就抛错（不静默放过）', () => {
  assert.throws(() => buildContextPacket({ purpose: 'isolated', content: 'x', tokens: { agentToken: 'abc' } }), /不允许携带令牌/);
  assert.equal(buildContextPacket({ purpose: 'isolated', content: 'x' }).tokens.agentToken, undefined);
  assert.equal(buildContextPacket({ purpose: 'chat', content: 'x', tokens: { agentToken: 'abc' } }).tokens.agentToken, 'abc');
});

test('stripKnownTokens：把已知令牌换成占位，并报告命中数', () => {
  const token = 'a'.repeat(32);
  const { text, hits } = stripKnownTokens(`前文 ${token} 后文`, [token, 'short']);
  assert.equal(hits, 1);
  assert.ok(!text.includes(token));
  assert.match(text, /令牌已隐藏/);
  assert.equal(promptTextOf({ content: 'abc' }), 'abc');
});

test('collectSessionTokens：去重收集 agent/owner/read 三类令牌', () => {
  const convs = new Map([
    ['private:1', { agentToken: 't1', ownerAgentToken: 't2' }],
    ['group:2', { agentToken: 't1', readToken: 't3' }],
  ]);
  assert.deepEqual(collectSessionTokens(convs).sort(), ['t1', 't2', 't3']);
});
