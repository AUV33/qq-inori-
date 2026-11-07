// inori-outbox 金标：没发出去的话有界沉淀——去重、TTL、容量上限、提示只给许可。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TTL_MS, MAX_ITEMS, appendUndelivered, listUndelivered, clearUndelivered, renderUndeliveredLine,
} from '../src/domain/leaves/inori-outbox.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-outbox-')), 'undelivered.jsonl');
const NOW = 1_800_000_000_000;

test('appendUndelivered：记一条并落盘；空文件/空文本不记', () => {
  const file = tmpFile();
  const row = appendUndelivered({ file, key: 'group:1', text: ' 没发出去的话 ', now: NOW });
  assert.equal(row.text, '没发出去的话');
  assert.equal(row.key, 'group:1');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);

  assert.equal(appendUndelivered({ file: '', key: 'x', text: 'y', now: NOW }), null);
  assert.equal(appendUndelivered({ file, key: 'x', text: '   ', now: NOW }), null);
});

test('appendUndelivered：同 key 同文本只刷新时间，不重复占位', () => {
  const file = tmpFile();
  appendUndelivered({ file, key: 'group:1', text: '同一句', now: NOW - 1000 });
  appendUndelivered({ file, key: 'group:1', text: '同一句', now: NOW });
  const rows = listUndelivered({ file, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].at, NOW);
});

test('listUndelivered：只给 TTL 内的；过期自动不返回', () => {
  const file = tmpFile();
  appendUndelivered({ file, key: 'g', text: '老的', now: NOW - DEFAULT_TTL_MS - 1000 });
  appendUndelivered({ file, key: 'g', text: '新的', now: NOW - 1000 });
  const rows = listUndelivered({ file, now: NOW });
  assert.deepEqual(rows.map((r) => r.text), ['新的']);
});

test('容量上限：超过 MAX_ITEMS 只留最新的一批', () => {
  const file = tmpFile();
  for (let i = 0; i < MAX_ITEMS + 10; i += 1) appendUndelivered({ file, key: 'g', text: `第${i}句`, now: NOW + i });
  const rows = listUndelivered({ file, now: NOW + MAX_ITEMS + 20 });
  assert.equal(rows.length, MAX_ITEMS);
  assert.equal(rows[rows.length - 1].text, `第${MAX_ITEMS + 9}句`);
});

test('文本截断 200 字（账本有界）', () => {
  const file = tmpFile();
  const row = appendUndelivered({ file, key: 'g', text: '啊'.repeat(300), now: NOW });
  assert.equal(row.text.length, 200);
});

test('坏行/缺文件都当空，不炸', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '坏行\n{"text":"好的一条","at":' + NOW + '}\n', 'utf8');
  assert.deepEqual(listUndelivered({ file, now: NOW }).map((r) => r.text), ['好的一条']);
  assert.deepEqual(listUndelivered({ file: path.join(path.dirname(file), 'nope.jsonl'), now: NOW }), []);
});

test('clearUndelivered 清空；renderUndeliveredLine 只给事实+许可，最多 3 条', () => {
  const file = tmpFile();
  for (let i = 0; i < 5; i += 1) appendUndelivered({ file, key: `group:${i}`, text: `第${i}句`, now: NOW + i });
  const line = renderUndeliveredLine(listUndelivered({ file, now: NOW + 10 }));
  assert.ok(line.includes('【上次没发出去的话】'));
  assert.ok(line.includes('没送到（5 条）'));
  assert.equal((line.match(/^- /gm) || []).length, 3, '最多列 3 条');
  assert.ok(line.includes('想补就直接再说一遍'));
  assert.ok(line.includes('不想补就让它过去'), '许可语气，不催');

  clearUndelivered({ file });
  assert.deepEqual(listUndelivered({ file, now: NOW }), []);
});

test('renderUndeliveredLine：空容器返回 null（不造暗示）', () => {
  assert.equal(renderUndeliveredLine([]), null);
  assert.equal(renderUndeliveredLine(null), null);
  assert.equal(renderUndeliveredLine([{ text: '' }]), null);
});
