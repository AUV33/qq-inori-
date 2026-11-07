import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDailyCap } from '../src/domain/memory/usage-cap.js';

test('日闸：cap=0 表示关闭，所有回合都放行', () => {
  const r = evaluateDailyCap({ spent: 999, cap: 0, kind: 'background' });
  assert.equal(r.exceeded, false);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, null);
});

test('日闸：没到上限时聊天与后台都放行', () => {
  const chat = evaluateDailyCap({ spent: 10, cap: 40, kind: 'chat' });
  const bg = evaluateDailyCap({ spent: 10, cap: 40, kind: 'background' });
  assert.equal(chat.allowed, true);
  assert.equal(bg.allowed, true);
  assert.equal(bg.remaining, 30);
});

test('日闸：达到/超过上限后只放聊天，后台拒绝', () => {
  const atCap = evaluateDailyCap({ spent: 40, cap: 40, kind: 'background' });
  assert.equal(atCap.exceeded, true);
  assert.equal(atCap.allowed, false);
  assert.equal(evaluateDailyCap({ spent: 40, cap: 40, kind: 'chat' }).allowed, true);
  assert.equal(evaluateDailyCap({ spent: 55.5, cap: 40, kind: 'background' }).allowed, false);
});

test('日闸：剩余额度不会为负，坏输入按 0 处理', () => {
  assert.equal(evaluateDailyCap({ spent: 100, cap: 40 }).remaining, 0);
  const bad = evaluateDailyCap({ spent: 'x', cap: 'y', kind: '' });
  assert.equal(bad.spent, 0);
  assert.equal(bad.cap, 0);
  assert.equal(bad.allowed, true);
  assert.equal(bad.kind, 'background');
});

test('日闸：默认 kind 是 background（拿不准时按后台收紧）', () => {
  const r = evaluateDailyCap({ spent: 50, cap: 40 });
  assert.equal(r.allowed, false);
});
