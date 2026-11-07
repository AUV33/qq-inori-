// memory-contradiction：矛盾检测（F2/R5，闭合全仓 0 实现的第一刀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradictions, polarityOf } from '../../ai-companion-kit/packages/memory-mcp/src/memory-contradiction.mjs';

test('polarityOf：情感极性', () => {
  assert.equal(polarityOf('我喜欢吃辣'), 'pos');
  assert.equal(polarityOf('我讨厌下雨'), 'neg');
  assert.equal(polarityOf('他今天去了公司'), 'none');
});

test('detectContradictions：同 who 态度反转被标出', () => {
  const existing = [{ who: '小明', text: '小明喜欢吃苹果', time: '2026-01-01 10:00' }];
  const e = { who: '小明', text: '小明讨厌吃苹果', theme: '' };
  const r = detectContradictions(e, existing);
  assert.equal(r.length, 1);
  assert.match(r[0].reason, /态度前后相反/);
  assert.equal(r[0].withTime, '2026-01-01 10:00');
});

test('detectContradictions：同 theme 态度反转被标出', () => {
  const existing = [{ theme: '旅行', text: '期待去旅行', time: '2026-02-02 10:00' }];
  const e = { who: '', theme: '旅行', text: '我排斥旅行' };
  const r = detectContradictions(e, existing);
  assert.equal(r.length, 1);
  assert.match(r[0].reason, /态度前后相反/);
});

test('detectContradictions：显式 conflict 标记触发冲突记录', () => {
  const existing = [{ who: '小红', text: '小红答应来', time: '2026-03-03 10:00' }];
  const e = { who: '小红', text: '和小红吵架了', claimType: 'conflict' };
  const r = detectContradictions(e, existing);
  assert.equal(r.length, 1);
  assert.match(r[0].reason, /冲突记录/);
});

test('detectContradictions：无关条目不误报', () => {
  const existing = [{ who: 'A', text: 'A 喜欢猫', time: '2026-04-04 10:00' }];
  const e = { who: 'B', text: 'B 讨厌狗', theme: '宠物' };
  assert.equal(detectContradictions(e, existing).length, 0);
});
