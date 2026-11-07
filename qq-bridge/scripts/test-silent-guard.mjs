// [SILENT-GUARD] 回复侧「连续缺席」软护栏自检（纯函数）：
// 纪律同图片/表情包提示——只递事实+许可；空窗必须 null；不上「必须回复」硬提示；不唠叨。
import assert from 'node:assert/strict';
import { silentGuardLine } from '../src/domain/leaves/inori-silent-guard.js';

let passed = 0;
function ok(name) { passed += 1; console.log(`✅ ${name}`); }

const now = Date.parse('2026-10-25T18:00:00+08:00'); // 周六 18:00，非深夜

// 1. 连击不足 2 → 不递
assert.equal(silentGuardLine({ silentStreak: 1, silentReminders: 0, lastAiReplyAt: now - 120 * 60000 }, now), null);
ok('streak<2 不递提示');

// 2. 基本出句：事实（连续次数+距上次）+ 许可（可以/继续静着），无硬指令
{
  const st = { silentStreak: 2, silentReminders: 0, lastAiReplyAt: now - 95 * 60000 };
  const line = silentGuardLine(st, now);
  assert.ok(line, '必须出句');
  assert.match(line, /连续 2 次/, '陈述连续缺席次数');
  assert.match(line, /95 分钟/, '陈述距上次说话时长');
  assert.ok(line.includes('也可以'), '含许可（想说可以说）');
  assert.ok(line.includes('继续静着'), '也许可静（不强制开口）');
  assert.ok(!/必须|一定|立刻|马上/.test(line), '无硬指令词');
  ok('事实+许可软提示');
}

// 3. 本连击已提醒 2 次 → 不唠叨
assert.equal(silentGuardLine({ silentStreak: 4, silentReminders: 2, lastAiReplyAt: now - 300 * 60000 }, now), null);
ok('已提醒 2 次不再唠叨');

// 4. 距上次说话 60 分钟内 → 不催（这条只是不想接，正当）
assert.equal(silentGuardLine({ silentStreak: 3, silentReminders: 0, lastAiReplyAt: now - 30 * 60000 }, now), null);
ok('60 分钟内说过话不催');

// 5. 深夜/清晨 → 加「安静着也正常」软化
{
  const late = Date.parse('2026-10-25T03:00:00+08:00');
  const line = silentGuardLine({ silentStreak: 2, silentReminders: 0, lastAiReplyAt: late - 120 * 60000 }, late);
  assert.ok(line && line.includes('安静着也正常'), '深夜加软化');
  ok('深夜软化条款');
}

// 6. 状态缺失/脏值 → null 不炸
assert.equal(silentGuardLine(null, now), null);
assert.equal(silentGuardLine({}, now), null);
assert.equal(silentGuardLine({ silentStreak: 'x', silentReminders: 'y', lastAiReplyAt: 'z' }, now), null);
ok('缺失/脏状态不炸');

console.log(`\n${passed} passed`);
