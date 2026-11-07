// test-scaffold-meter.test.mjs · 宪章 §5.7/G1：脚手架计量必须可解释、可汇总、可比较。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { meter, aggregate, trend, SCAFFOLD_PHRASES } from '../src/domain/life/scaffold-meter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('meter：许可/建议/命令/提醒四类都能识别，占比按非空白字符算', () => {
  const text = '【你现在可以】先看看。建议你先查一下。请你记得回来。提醒你别忘。';
  const m = meter(text);
  assert.ok(m.chars > 0);
  assert.ok(m.imperativeChars > 0);
  assert.ok(m.ratio > 0 && m.ratio <= 1);
  assert.ok(m.byCategory.permission >= 1);
  assert.ok(m.byCategory.advice >= 1);
  assert.ok(m.byCategory.command >= 1);
  assert.ok(m.byCategory.reminder >= 1);
});

test('meter：重叠短语只算一次（请你 + 请 不重复计字符）', () => {
  const once = meter('请你');
  const twice = meter('请你请你');
  assert.equal(once.imperativeChars, 2, '请/你两个字');
  assert.equal(twice.imperativeChars, 4, '并集而不是按命中次数累加');
});

test('meter：普通事实文本不被误判；空文本为零', () => {
  for (const text of ['', '   ', '今天 21:30，群里 3 条未读。', '他的生日是 5 月 12 日。']) {
    const m = meter(text);
    assert.equal(m.imperativeChars, 0, text);
    assert.equal(m.ratio, 0);
  }
});

test('meter：长文本不抛错，命中明细有上限且区间在界内', () => {
  const m = meter('你可以'.repeat(2000));
  assert.ok(m.imperativeChars > 0);
  assert.ok(m.hits.length <= 300);
  for (const hit of m.hits) {
    assert.ok(hit.index >= 0);
    assert.ok(hit.index + hit.length <= '你可以'.repeat(2000).length);
  }
});

test('aggregate：按字符加权，不是简单平均', () => {
  const a = aggregate([
    { chars: 1000, imperativeChars: 10, byCategory: { permission: 1 } },
    { chars: 10, imperativeChars: 10, byCategory: { command: 2 } },
  ]);
  assert.equal(a.samples, 2);
  assert.equal(a.chars, 1010);
  assert.equal(a.imperativeChars, 20);
  assert.equal(a.ratio, 0.0198);
  assert.equal(a.byCategory.permission, 1);
  assert.equal(a.byCategory.command, 2);
});

test('trend：下降=撤离有进展；上升只报告；零基线安全', () => {
  const down = trend({ ratio: 0.01 }, { ratio: 0.02 });
  assert.equal(down.direction, 'down');
  assert.equal(down.improved, true);
  assert.equal(down.percent, -50);
  const up = trend({ ratio: 0.03 }, { ratio: 0.02 });
  assert.equal(up.direction, 'up');
  assert.equal(up.improved, false);
  const flat = trend({ ratio: 0.02 }, { ratio: 0.02 });
  assert.equal(flat.direction, 'flat');
  const zero = trend({ ratio: 0.01 }, { ratio: 0 });
  assert.equal(zero.percent, 100);
});

test('短语表是稳定契约：四类都有，短语非空且唯一', () => {
  const phrases = SCAFFOLD_PHRASES.map((p) => p.phrase);
  assert.equal(new Set(phrases).size, phrases.length, '短语不得重复');
  for (const category of ['permission', 'advice', 'command', 'reminder']) {
    assert.ok(SCAFFOLD_PHRASES.some((p) => p.category === category), category);
  }
  assert.ok(phrases.every((p) => typeof p === 'string' && p.length > 0));
});

test('接线：wake-prompt-service 真的在每轮构建后记账（限流落盘）', () => {
  const service = fs.readFileSync(path.join(ROOT, 'src/domain/conversation/wake-prompt-service.mjs'), 'utf8');
  assert.match(service, /scaffold-meter\.mjs/);
  assert.match(service, /scaffold-meter\.jsonl/);
  assert.match(service, /noteScaffoldMeter\(prompt, key, reason\)/);
  assert.match(service, /SCAFFOLD_FLUSH_MS/);
});
