import assert from 'node:assert/strict';
import { summarizeSelfTrend, renderSelfTrend } from '../src/domain/leaves/inori-self-trend.js';

let passed = 0;
const DAY = 86400000;
const now = Date.parse('2026-10-26T12:00:00Z');
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

const style = (daysAgo, avgLen, shortRatio, verdict = 'ok') => ({ at: new Date(now - daysAgo * DAY).toISOString(), mine: { avgLen, shortRatio }, gap: 2, verdict });
const action = (daysAgo, t, trigger = '') => ({ ts: new Date(now - daysAgo * DAY).toISOString(), t, trigger });

ok('近 7 天 vs 上周：字数/短句/回合数', () => {
  const s = [
    style(1, 8, 0.5), style(3, 9, 0.45),
    style(9, 11, 0.4), style(12, 12, 0.35),
  ];
  const a = [action(1, 'turn'), action(2, 'turn'), action(10, 'turn')];
  const sum = summarizeSelfTrend({ styleRows: s, actionRows: a, now });
  const line = renderSelfTrend(sum);
  assert.ok(line.includes('说话字数'));
  assert.ok(line.includes('11.5→8.5'));
  assert.ok(line.includes('回合 1→2'));
});

ok('没数据返回 null', () => {
  assert.equal(renderSelfTrend(summarizeSelfTrend({ now })), null);
});

ok('经验统计进趋势（+N）', () => {
  const l = [{ at: new Date(now - 1 * DAY).toISOString(), text: 'a' }, { at: new Date(now - 9 * DAY).toISOString(), text: 'b' }];
  const line = renderSelfTrend(summarizeSelfTrend({ lessonsRows: l, now }));
  assert.ok(line.includes('新经验 +1'));
});

console.log(`🎉 自我趋势测试通过（${passed} 项）`);
