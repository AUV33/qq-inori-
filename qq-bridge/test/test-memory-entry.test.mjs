// memory-entry：情景记忆条目构造含 provenance（F2/M3 可溯源）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryEntry, claimTypeOf, today, stamp } from '../../ai-companion-kit/packages/memory-mcp/src/memory-entry.mjs';

test('buildMemoryEntry：provenance 字段齐备', () => {
  const e = buildMemoryEntry({ text: '今天和他去了海边', scope: 'group_123', now: new Date('2026-11-04T20:30:00') });
  assert.equal(e.src, 'group_123');
  assert.equal(e.embedModel, 'bge-m3@1024');
  assert.match(e.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.day, '2026-11-04');
  assert.equal(e.time, '2026-11-04 20:30');
  assert.equal(e.mentions, 1);
});

test('buildMemoryEntry：可选字段裁剪 + 默认 private 来源', () => {
  const e = buildMemoryEntry({ text: 'x', who: '  小明  ', felt: '开心', theme: '旅行', scope: 'private' });
  assert.equal(e.who, '小明'); // 去空格 + 20 字上限
  assert.equal(e.felt, '开心');
  assert.equal(e.theme, '旅行');
  assert.equal(e.src, 'private');
});

test('claimTypeOf：结构化声明类型', () => {
  assert.equal(claimTypeOf('我答应他周末去看展'), 'promise');
  assert.equal(claimTypeOf('我讨厌吃香菜'), 'preference');
  assert.equal(claimTypeOf('我们吵架了'), 'conflict');
  assert.equal(claimTypeOf('我打算换工作'), 'plan');
  assert.equal(claimTypeOf('今天天气不错'), '');
});

test('buildMemoryEntry：embedModel 可覆盖', () => {
  const e = buildMemoryEntry({ text: 'x', scope: 'private', embedModel: 'bge-large@1024' });
  assert.equal(e.embedModel, 'bge-large@1024');
});
