#!/usr/bin/env node
// life-kernel-demo.mjs · 离线演示：不打 QQ、不连模型，让一颗心跳跑完她的一天。
// 用法：node scripts/life-kernel-demo.mjs [--hours 24]
import { createKernel } from '../src/kernel/index.mjs';
import { createMemoryPorts } from '../src/kernel/ports.mjs';

const H = 3600000;
const T = Date.UTC(2026, 10, 4, 8, 0, 0);
const arg = process.argv.indexOf('--hours');
const hours = arg >= 0 ? Math.max(1, Math.min(72, Number(process.argv[arg + 1]) || 24)) : 24;

const ports = createMemoryPorts({ at: T });
const kernel = createKernel({ ports, reflectMs: 6 * H });
const line = (h, d, s) => `${String(h).padStart(2)}h | ${String(d.selected).padEnd(11)} | energy ${s.energy.toFixed(2)} | hunger ${s.socialHunger.toFixed(2)} | lessons ${s.lessons.length} | ${d.reason}`;

console.log(`生命内核离线演示 · ${hours}h · 无外部服务`);
console.log('时刻 | 意图         | 状态摘要 | 理由');
console.log('---|---|---|---');
for (let h = 0; h <= hours; h += 1) {
  // 中午有人来过一次；其余时间完全无人打扰
  if (h === 12) ports.sense.push({ type: 'message.received', payload: { key: 'private:1' }, at: T + h * H });
  const trace = kernel.tick(T + h * H);
  if (trace.failed) console.log(`${h}h | FAILED ${trace.failed.phase}: ${trace.failed.error}`);
  else console.log(line(h, trace.decision, kernel.state));
  if (trace.reflection && !trace.reflection.empty) {
    console.log(`     └ 反思形成经验：${trace.reflection.insight}（证据 ${JSON.stringify(trace.reflection.evidence)}）`);
  }
}
const st = kernel.state;
console.log('---');
console.log(`事件 ${ports.events.size} 条；lessonRefs(经验被引用次数) ${st.lessonRefs.length}；反思 @ ${new Date(st.lastReflectAt).toISOString()}`);
console.log(`回放校验：${JSON.stringify(kernel.replayFrom()) === JSON.stringify(st) ? '一致 ✅ 她的一生可完整重建' : '不一致 ❌'}`);
console.log(`事件契约孤儿：${kernel.contractAudit().length}`);
