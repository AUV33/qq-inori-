import { readBridgeSource } from './lib/bridge-source.mjs';
// test-memory-order.mjs · 记忆按时间倒序 + 跨库来源标注
import assert from 'node:assert';
import fs from 'node:fs';
import { sortByTimeDesc, formatEntry } from '../src/domain/memory/memory-retrieve.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('sortByTimeDesc：新的在前，无时间的排最后，稳定', () => {
  const out = sortByTimeDesc([
    { time: '2026-10-20 10:00', text: 'a' },
    { time: '2026-10-27 05:00', text: 'b' },
    { text: 'no-time' },
    { time: '2026-10-22 09:00', text: 'c' },
  ]);
  assert.deepEqual(out.map((e) => e.text), ['b', 'c', 'a', 'no-time']);
});

check('formatEntry：群里的事有来源标注', () => {
  const line = formatEntry({ time: '2026-10-27 05:00', text: '群里的事', _groupSource: true });
  assert.ok(line.includes('（群里的事）'), line);
});

check('formatEntry：私聊里的事有来源标注（群聊也能想起）', () => {
  const line = formatEntry({ time: '2026-10-27 05:00', text: '私聊的事', _fromPrivate: true });
  assert.ok(line.includes('（私聊里的事）'), line);
});

check('bridge：群聊注入默认共享私聊库（她说才说）', () => {
  const src = readBridgeSource();
  assert.ok(src.includes('[SHARE-PRIVATE-GROUP]'), '缺 SHARE-PRIVATE-GROUP');
  assert.ok(src.includes("sharePrivate: true"), '没传 sharePrivate');
});

check('MCP 侧：跨库标来源 + 时间倒序', () => {
  const src = fs.readFileSync(`${PROJECT_ROOT}/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js`, 'utf8');
  assert.ok(src.includes('[MEM-TIME]'), '缺 MEM-TIME');
  assert.ok(src.includes('（私聊里记的）'), '缺跨库来源标注');
  assert.ok(src.includes('sortByTimeDesc(all.slice(-n))'), 'recent 未按时间排序');
  assert.ok(src.includes('sortByTimeDesc(top)'), '检索结果未按时间排序');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
