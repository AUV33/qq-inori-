// [PERSON-MEMORY] 按人翻记忆的匹配规则：昵称出现在 who 或正文里才算；单字/空不算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPerson, filterEntriesByPerson } from '../src/domain/memory/memory-retrieve.js';

test('昵称出现在正文里 → 命中（群摘要格式「昵称：内容」）', () => {
  assert.equal(matchesPerson({ text: '群友丙：我还没吃饭' }, ['群友丙']), true);
  assert.equal(matchesPerson({ text: '别人：随便聊聊' }, ['群友丙']), false);
});

test('who 字段命中；多个昵称任一命中即可', () => {
  assert.equal(matchesPerson({ who: '群友丙', text: '…' }, ['群友丙']), true);
  assert.equal(matchesPerson({ text: '阿辞说了句什么' }, ['群友丙', '阿辞']), true);
});

test('单字/空昵称不参与匹配（避免误伤）；无别名 → 不命中', () => {
  assert.equal(matchesPerson({ text: '王仆：你的大名' }, ['王']), false);
  assert.equal(matchesPerson({ text: '随便' }, []), false);
  assert.equal(matchesPerson({ text: '随便' }, ['', ' ']), false);
});

test('filterEntriesByPerson 保持顺序、丢掉不相干条目', () => {
  const entries = [
    { time: 't3', text: '群友丙：三' },
    { time: 't2', text: '别人：二' },
    { time: 't1', text: '群友丙：一' },
  ];
  const hit = filterEntriesByPerson(entries, ['群友丙']);
  assert.deepEqual(hit.map((e) => e.time), ['t3', 't1']);
  assert.deepEqual(filterEntriesByPerson(null, ['x']), []);
});
