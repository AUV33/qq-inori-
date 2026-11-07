import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSelfSnapshot } from '../src/domain/leaves/inori-self-snapshot.js';

test('输出与旧的三段 join 逐字节一致', () => {
  const parts = { narrative: '【自述】A', profile: '【档案】B', model: '【样子】C' };
  const old = [parts.narrative, parts.profile, parts.model].filter(Boolean).join('\n\n');
  assert.equal(composeSelfSnapshot(parts).text, old);
});

test('trend/learning/behavior 按旧 prepend 的最终顺序拼接', () => {
  const parts = {
    narrative: 'N', profile: 'P', model: 'M',
    behavior: 'B', learning: 'L', trend: 'T',
  };
  // 旧代码依次 prepend trend → learning → behavior → selfModel，最终是 S/B/L/T。
  const old = [parts.narrative, parts.profile, parts.model, parts.behavior, parts.learning, parts.trend]
    .filter(Boolean).join('\n\n');
  assert.equal(composeSelfSnapshot(parts).text, old);
  assert.deepEqual(composeSelfSnapshot(parts).blocks.map((b) => b.id), ['narrative', 'profile', 'model', 'behavior', 'learning', 'trend']);
});

test('空块被跳过，顺序固定 narrative → profile → model', () => {
  const r = composeSelfSnapshot({ model: 'M', narrative: 'N' });
  assert.equal(r.text, 'N\n\nM');
  assert.deepEqual(r.blocks.map((b) => b.id), ['narrative', 'model']);
});

test('全空返回空串', () => {
  assert.deepEqual(composeSelfSnapshot({}), { text: '', blocks: [] });
});
