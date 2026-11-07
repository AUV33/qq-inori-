import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_MAP, categoryOf, groupTools, renderCatalog, renderCategory } from '../src/domain/persona/tool-catalog.js';

test('categoryOf：已知工具归对应分类，未知归"其他"', () => {
  assert.equal(categoryOf('qq_group_ban'), '群管理');
  assert.equal(categoryOf('memory_list'), '记忆整理');
  assert.equal(categoryOf('qq_send_sticker'), '表情包');
  assert.equal(categoryOf('qq_quant_buy'), '量化');
  assert.equal(categoryOf('qq_send_image_file'), '生图');
  assert.equal(categoryOf('不存在的工具'), '其他');
});

test('groupTools：只保留实际存在的，空分类不出现', () => {
  const g = groupTools(['qq_group_ban', 'qq_memory_query', '未知工具']);
  assert.deepEqual(Object.keys(g).sort(), ['其他', '群管理', '记忆整理'].sort());
  assert.deepEqual(g['群管理'], ['qq_group_ban']);
  assert.deepEqual(g['其他'], ['未知工具']);
  assert.equal(g['语音'], undefined);
});

test('renderCatalog：列出分类与数量，并给出两层用法', () => {
  const text = renderCatalog(['qq_recall', 'qq_memory_query', 'qq_send_voice']);
  assert.match(text, /【工具分类】/);
  assert.match(text, /群管理（1）/);
  assert.match(text, /记忆整理（1）/);
  assert.match(text, /qq_tools\(category=/);
  assert.match(text, /qq_tools\(tool=/);
  assert.equal(renderCatalog([]), '（没有需要按需展开的工具）');
});

test('renderCategory：有分类给详情，无分类给可用列表', () => {
  const describe = (n) => `这是 ${n} 的说明`;
  const ok = renderCategory(['qq_recall'], '群管理', describe);
  assert.match(ok, /【群管理】1 个/);
  assert.match(ok, /qq_recall：这是 qq_recall 的说明/);
  const miss = renderCategory(['qq_recall'], '语音', describe);
  assert.match(miss, /没有「语音」这个分类/);
  assert.match(miss, /可用分类：群管理/);
});

test('CATEGORY_MAP：每个分类至少一个工具，且没有重复归类', () => {
  const seen = new Map();
  for (const [cat, tools] of Object.entries(CATEGORY_MAP)) {
    assert.ok(tools.length > 0, `${cat} 是空分类`);
    for (const t of tools) {
      assert.ok(!seen.has(t), `${t} 同时属于 ${seen.get(t)} 和 ${cat}`);
      seen.set(t, cat);
    }
  }
});
