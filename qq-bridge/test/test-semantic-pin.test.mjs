// test-semantic-pin.test.mjs · 宪章 §5.11 / T1：稳定事实自动钉，情景事件带绝对日期。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  absolutizeTemporal, classifyMemory, describeOccurredOn,
} from '../src/domain/memory/semantic-pin.mjs';
import { buildMemoryEntry } from '../../ai-companion-kit/packages/memory-mcp/src/memory-entry.mjs';
import { isProtected } from '../src/domain/memory/memory-retention.mjs';
import { formatEntry } from '../src/domain/memory/memory-retrieve.js';

const T = Date.UTC(2026, 10, 5, 4); // 上海 2026-11-05 12:00
const localDay = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('时间解耦：今天/昨天/去年/显式日期都换算成绝对；多时间词取最靠前的', () => {
  assert.equal(absolutizeTemporal('今天吃了披萨', { now: T }).occurredOn, localDay(T));
  assert.equal(absolutizeTemporal('昨天去了医院', { now: T }).occurredOn, localDay(T - 86400000));
  assert.equal(absolutizeTemporal('去年发生的事', { now: T }).occurredOn, String(new Date(T).getFullYear() - 1));
  const explicit = absolutizeTemporal('2025-03-04 见的面', { now: T });
  assert.equal(explicit.occurredOn, '2025-03-04');
  assert.equal(explicit.precision, 'day');
  // 关键：不能把"去年我说今天吃了披萨"记成今天
  assert.equal(absolutizeTemporal('去年我说今天吃了披萨', { now: T }).occurredOn, String(new Date(T).getFullYear() - 1));
  assert.equal(absolutizeTemporal('没有时间词', { now: T }).occurredOn, '');
});

test('分类：owner 稳定事实自动钉；情景事件不钉；稳定事实优先于时间词', () => {
  const pref = classifyMemory({ text: '我喜欢吃披萨', isOwner: true, now: T });
  assert.equal(pref.kind, 'fact');
  assert.equal(pref.pinned, true);
  assert.equal(pref.reason, 'owner-fact');

  const episode = classifyMemory({ text: '今天吃了披萨', now: T });
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.pinned, false);
  assert.equal(episode.occurredOn, localDay(T));

  const stable = classifyMemory({ text: '他生日是 5 月 12 日', now: T });
  assert.equal(stable.pinned, true);
  assert.equal(stable.kind, 'fact');

  const datedPreference = classifyMemory({ text: '我今天发现自己其实很喜欢安静', isOwner: true, now: T });
  assert.equal(datedPreference.pinned, true, '偏好不因"今天"退化成一次性事件');

  const explicit = classifyMemory({ text: '任何内容', kind: 'fact', now: T });
  assert.equal(explicit.pinned, true);
  assert.equal(classifyMemory({ text: '' }).pinned, false);
});

test('展示：发生日期带进检索文本；没有就不加', () => {
  assert.equal(describeOccurredOn({ occurredOn: '2025-03-04' }), '（发生：2025-03-04）');
  assert.equal(describeOccurredOn({}), '');
  assert.match(formatEntry({ time: '2026-11-05 12:00', text: '吃了披萨', occurredOn: '2025-03-04' }), /发生：2025-03-04/);
  assert.equal(/发生：/.test(formatEntry({ time: 't', text: '普通' })), false);
});

test('写入：pinned/occurredOn 只在显式传入时落字段；pinned 受遗忘保护', () => {
  const withPin = buildMemoryEntry({
    text: 'x', scope: 'private', now: new Date(T), pinned: true, occurredOn: '2025-03-04', pinReason: 'owner-fact',
  });
  assert.equal(withPin.pinned, true);
  assert.equal(withPin.occurredOn, '2025-03-04');
  assert.equal(withPin.pinReason, 'owner-fact');
  assert.equal(isProtected(withPin), true);

  const plain = buildMemoryEntry({ text: 'x', scope: 'private', now: new Date(T) });
  assert.equal('pinned' in plain, false, '旧条目形状不变');
  assert.equal('occurredOn' in plain, false);
});

test('接线：memory-mcp 的 memory_save 调分类器并传 pinned/occurredOn', () => {
  const src = fs.readFileSync(path.join(ROOT, '..', 'ai-companion-kit/packages/memory-mcp/src/memory-mcp.js'), 'utf8');
  assert.match(src, /semanticPin\(\)/);
  assert.match(src, /classifyMemory/);
  assert.match(src, /pinned: pin\?\.pinned === true/);
  assert.match(src, /occurredOn: pin\?\.occurredOn/);
});
