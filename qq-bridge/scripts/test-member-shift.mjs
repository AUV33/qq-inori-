// 群成员「有点不一样」判定（detectMemberShift）单元测试
// 只锁事实判定：什么算和档案不一样、什么不算。印象更不更新是她的事，这里不测。
import assert from 'node:assert/strict';
import { detectMemberShift } from '../src/domain/leaves/inori-groupmembers.js';

const base = (over = {}) => ({
  count: 30,
  repliesToMe: 5,
  lastSeenBefore: Date.now() - 60_000,
  voice: { n: 30, chars: 300 }, // 平均 10 字
  ...over,
});

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log('PASS', name); };

ok('平时说话，不算不一样', () => {
  assert.deepEqual(detectMemberShift(base(), '还行吧今天', {}), []);
});

ok('第一次回她：算', () => {
  const m = base({ count: 30, repliesToMe: 1 });
  assert.deepEqual(detectMemberShift(m, '嗯', { quoteTargetIsSelf: true }), ['第一次回你']);
});

ok('不是回复，即使 repliesToMe=1 也不算', () => {
  const m = base({ repliesToMe: 1 });
  assert.deepEqual(detectMemberShift(m, '还行吧今天', { quoteTargetIsSelf: false }), []);
});

ok('突然说很长：算（>3 倍平均）', () => {
  const m = base({ voice: { n: 30, chars: 200 } }); // 平均 6.7 字
  const kinds = detectMemberShift(m, '我这两天其实一直在想这个事，觉得还是得把话说清楚比较好', {});
  assert.equal(kinds.length, 1);
  assert.match(kinds[0], /长很多/);
});

ok('突然只说几个字：算', () => {
  const m = base({ voice: { n: 30, chars: 600 } }); // 平均 20 字
  const kinds = detectMemberShift(m, '哦', {});
  assert.deepEqual(kinds, ['突然只说几个字']);
});

ok('样本太少不下判断（<10 条）', () => {
  const m = base({ count: 5, voice: { n: 5, chars: 25 } });
  assert.deepEqual(detectMemberShift(m, '我这两天其实一直在想这个事觉得还是得把话说清楚比较好', {}), []);
});

ok('隔了一周以上又出现：算', () => {
  const m = base({ lastSeenBefore: Date.now() - 9 * 24 * 3600 * 1000 });
  const kinds = detectMemberShift(m, '回来了', {});
  assert.deepEqual(kinds, ['很久没出现，又来了']);
});

ok('最多 3 条', () => {
  const m = base({ repliesToMe: 1, lastSeenBefore: Date.now() - 9 * 24 * 3600 * 1000 });
  const kinds = detectMemberShift(m, '我这两天其实一直在想这个事觉得还是得把话说清楚比较好', { quoteTargetIsSelf: true });
  assert.ok(kinds.length <= 3);
});

console.log(`member shift: ${pass}/${pass} passed`);
