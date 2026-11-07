import test from 'node:test';
import assert from 'node:assert/strict';
import { ignoredCatch, catchStats } from '../src/domain/shared/best-effort.js';

test('ignoredCatch：任何值都不抛，并按位置计数', () => {
  const before = catchStats()['unit:test'] || 0;
  assert.doesNotThrow(() => ignoredCatch(new Error('x'), 'unit:test'));
  assert.doesNotThrow(() => ignoredCatch(null, 'unit:test'));
  assert.equal(catchStats()['unit:test'], before + 2);
});

test('ignoredCatch：可选全局出口已挂上', () => {
  assert.equal(typeof globalThis.__ignoredCatch, 'function');
});
