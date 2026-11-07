import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeeklyReview } from '../src/domain/leaves/inori-learning-review.js';

test('周报：有摘要才渲染，包含任务/练习/草稿数字', () => {
  const text = renderWeeklyReview({
    at: new Date().toISOString(),
    tasks: { success: 2, failed: 1, unknown: 3 },
    practice: { met: 2, not_met: 1 },
    items: { practicing: 1 },
    drafts: { pending: 2 },
  });
  assert.match(text, /本周学习账本/);
  assert.match(text, /成功 2/);
  assert.match(text, /过了 2/);
  assert.match(text, /待定技能草稿：2/);
});

test('周报：空/过期摘要不渲染', () => {
  assert.equal(renderWeeklyReview(null), '');
  assert.equal(renderWeeklyReview({ at: '2000-01-01T00:00:00Z' }), '');
});
