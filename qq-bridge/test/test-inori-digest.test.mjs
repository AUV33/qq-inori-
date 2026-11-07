// inori-digest 金标：一天一条摘要——去重、分三段取样、按分数挑、硬上限、不编内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, digestDay, alreadyDigested } from '../src/domain/leaves/inori-digest.js';

const msg = (text, at, extra = {}) => ({ sender: 'A', text, at, ...extra });
const many = (n, opts = {}) => Array.from({ length: n }, (_, i) => msg(`第${i}条消息内容`, Date.now() + i, opts));

test('消息太少不值得摘要（默认 6 条）', () => {
  const r = digestDay([msg('a', 1), msg('b', 2)]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-few');
  assert.equal(r.total, 2);
});

test('去重：同一句话刷屏只留一次', () => {
  const msgs = [
    ...Array.from({ length: 6 }, () => msg('复制粘贴同一句', 1)),
    msg('另一句', 2),
  ];
  const r = digestDay(msgs, { minMessages: 2 });
  assert.equal(r.ok, true);
  assert.equal((r.text.match(/复制粘贴同一句/g) || []).length, 1);
});

test('摘要格式是「谁：说了什么」并用 / 连接', () => {
  const msgs = many(9);
  const r = digestDay(msgs);
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('A：'));
  assert.ok(r.text.includes(' / '));
});

test('按时间分三段取样，保留「一天的走向」', () => {
  const msgs = [
    ...Array.from({ length: 3 }, (_, i) => msg(`早上第${i}件事`, 1000 + i)),
    ...Array.from({ length: 3 }, (_, i) => msg(`中午第${i}件事`, 2000 + i)),
    ...Array.from({ length: 3 }, (_, i) => msg(`晚上第${i}件事`, 3000 + i)),
  ];
  const r = digestDay(msgs, { maxLines: 9 });
  assert.ok(r.text.includes('早上'), r.text);
  assert.ok(r.text.includes('晚上'), r.text);
});

test('打分偏好：提到她的、带问号的更容易被选中', () => {
  const msgs = [
    ...many(6),
    msg('小满你觉得这个怎么样？', 9999),
  ];
  const r = digestDay(msgs, { maxLines: 3, perLineChars: 60 });
  assert.ok(r.text.includes('小满'), `实际：${r.text}`);
});

test('硬上限：总长不超过 maxChars，单条不超过 perLineChars', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => msg(`${'长'.repeat(100)}${i}`, i));
  const r = digestDay(msgs, { maxChars: 120, perLineChars: 10, maxLines: 9 });
  assert.ok(r.text.length <= 120, `实际长度 ${r.text.length}`);
  for (const line of r.text.split(' / ')) assert.ok([...line].length <= 10 + 3, line);
});

test('她的发言标注为「我」；没名字的标「某人」', () => {
  const msgs = [
    ...many(6),
    msg('我说的', 9000, { isSelf: true }),
    { sender: '', text: '没名字的一句', at: 9001 },
  ];
  const r = digestDay(msgs, { maxLines: 9, perLineChars: 40 });
  assert.ok(r.text.includes('我：'), r.text);
  assert.ok(r.text.includes('某人：'), r.text);
});

test('表情占位符被清掉；全被清空时返回 empty', () => {
  const msgs = Array.from({ length: 6 }, () => msg('[表情]', 1));
  const r = digestDay(msgs, { minMessages: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-few', '清理后没内容就算不够');
});

test('alreadyDigested：按 kind=day-digest 且文本含日期判定', () => {
  const entries = [
    { kind: 'day-digest', text: '2026-11-01 这天：……' },
    { kind: 'fact', text: '2026-11-02 随口一句' },
  ];
  assert.equal(alreadyDigested(entries, '2026-11-01'), true);
  assert.equal(alreadyDigested(entries, '2026-11-02'), false, '非 day-digest 不算');
  assert.equal(alreadyDigested(null, '2026-11-01'), false);
  assert.equal(DEFAULTS.maxChars, 400);
});
