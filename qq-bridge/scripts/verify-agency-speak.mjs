// verify-agency-speak.mjs · 她「主动开口」的机检指标：非被叫醒的唤醒后，是否真的发了消息
import fs from 'node:fs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
const base = `${PROJECT_ROOT}/qq-bridge/state/`;
const read = (f) => { try { return fs.readFileSync(base + f, 'utf8'); } catch { return ''; } };
const lines = (read('bridge.log') + '\n' + read('bridge.log.1') + '\n' + read('bridge.log.2'))
  .split(/\r?\n/).filter(Boolean);

// 唤醒行 → 往后 12 行内是否有「工具统一发送 <属于同 key>」
const wakeRe = /唤醒\s+(group:\d+|private:\d+)（([a-zA-Z]+)[^）]*）/;
const sendRe = /工具统一发送\s+(group:\d+|private:\d+)/;
const initiators = new Set(['joinTopic', 'continueChat', 'probability', 'anyMessage', 'proactiveCheck', 'speaker']);
const stats = {};
for (let i = 0; i < lines.length; i++) {
  const m = wakeRe.exec(lines[i]);
  if (!m) continue;
  const key = m[1];
  const reason = m[2];
  const row = stats[reason] ?? (stats[reason] = { wakes: 0, spoke: 0 });
  row.wakes += 1;
  for (let j = i + 1; j < Math.min(lines.length, i + 14); j++) {
    const s = sendRe.exec(lines[j]);
    if (s && s[1] === key) { row.spoke += 1; break; }
    if (wakeRe.test(lines[j])) break; // 下一次唤醒截断
  }
}
const rows = Object.entries(stats).sort((a, b) => b[1].wakes - a[1].wakes);
console.log('唤醒原因            唤醒次数  其中开口');
for (const [r, v] of rows) {
  const tag = initiators.has(r) ? ' [自主/半自主]' : '';
  console.log(`${r.padEnd(18)} ${String(v.wakes).padStart(6)} ${String(v.spoke).padStart(6)}${tag}`);
}
// 工具统一发送总数
console.log('\n工具统一发送总数:', (lines.join('\n').match(/工具统一发送/g) || []).length);
