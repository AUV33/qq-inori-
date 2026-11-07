// 群记忆 group-fact：发言者聚合纯函数自检（确定性、零 LLM）
// 对应 [GROUP-FACT] 群记忆「原料→认知」轻改造（2026-10-26）
import assert from 'node:assert/strict';
import { summarizeGroupSpeakers } from '../src/domain/leaves/inori-activity.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('带时间窗前缀的 digest 能取到发言者', () => {
  const r = summarizeGroupSpeakers(['[22:44–22:50] 群里在聊：群友乙：什么情况 / 群友丙：摸摸']);
  assert.equal(r.speakers.length, 2);
  assert.equal(r.speakers[0].name, '群友乙');
  assert.equal(r.total, 2);
});

ok('纯数字发言者（时间冒号）不计数', () => {
  const r = summarizeGroupSpeakers(['[23:08–23:44] 群里在聊：23：别聊了 / 苏猫：哈哈']);
  assert.deepEqual(r.speakers.map((s) => s.name), ['苏猫']);
  assert.equal(r.total, 1);
});

ok('limit 生效（默认取前 3）', () => {
  const r = summarizeGroupSpeakers(['[10:00–10:05] 群里在聊：A：1 / B：2 / C：3 / D：4']);
  assert.equal(r.speakers.length, 3);
});

ok('空输入返回空结构', () => {
  const r = summarizeGroupSpeakers([]);
  assert.equal(r.speakers.length, 0);
  assert.equal(r.total, 0);
});

ok('多段 digest 累计计数并按次数排序', () => {
  const r = summarizeGroupSpeakers([
    '[10:00–10:05] 群里在聊：A：1 / B：2',
    '[10:05–10:10] 群里在聊：A：3 / C：4',
  ]);
  assert.deepEqual(r.speakers.map((s) => [s.name, s.count]), [['A', 2], ['B', 1], ['C', 1]]);
});

ok('非字符串项安全跳过', () => {
  const r = summarizeGroupSpeakers([null, undefined, 123, '[10:00–10:05] 群里在聊：A：x']);
  assert.equal(r.speakers.length, 1);
  assert.equal(r.speakers[0].name, 'A');
});

console.log(`🎉 群记忆 group-fact 聚合测试通过（${passed} 项）`);
