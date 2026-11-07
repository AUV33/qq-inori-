// inori-browse 单测：冲浪记录可读化（2026-10-27 修：记忆里塞满工具入参 JSON）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeBrowseArg, humanizeBrowseHead, newBrowseEntry, renderBrowseDigest } from '../src/domain/leaves/inori-browse.js';

test('humanizeBrowseArg：JSON 入参 → 人话（取 query/keyword）', () => {
  assert.equal(humanizeBrowseArg('{"query": "vmok 是什么 含义"}'), 'vmok 是什么 含义');
  assert.equal(humanizeBrowseArg('{"keyword": "明日方舟 JT8-3", "limit": 10}'), '明日方舟 JT8-3');
  assert.equal(humanizeBrowseArg('{"url": "https://zh.moegirl.org.cn/x"}'), 'https://zh.moegirl.org.cn/x');
});

test('humanizeBrowseArg：非 JSON 回退到第一个引号片段，空串给空', () => {
  assert.equal(humanizeBrowseArg('随便搜「傻鱼 什么意思」这种'), '傻鱼 什么意思');
  assert.equal(humanizeBrowseArg(''), '');
});

test('humanizeBrowseHead：空结果 → 没找到；标题 → 标题', () => {
  assert.equal(humanizeBrowseHead('{ "query": "x", "results": [] }'), '没找到');
  assert.equal(humanizeBrowseHead('{"results":[{"title":"【明日方舟】JT8-3 单核攻略"}]}'), '【明日方舟】JT8-3 单核攻略');
});

test('humanizeBrowseHead：半截/认不出的 JSON 不往记忆里塞', () => {
  assert.equal(humanizeBrowseHead('{ "query": "x", "results": [ { "tit'), '');
  assert.equal(humanizeBrowseHead('看完了：https://rsshub.app/hupu/bbs'), 'https://rsshub.app/hupu/bbs');
});

test('newBrowseEntry：记录时就归一，不存原始 JSON', () => {
  const e = newBrowseEntry({ tool: 'web_search', arg: '{"query":"活人感 是什么"}', head: '{"results":[]}' });
  assert.equal(e.arg, '活人感 是什么');
  assert.equal(e.head, '没找到');
  assert.ok(!JSON.stringify(e).includes('{"query"'));
});

test('renderBrowseDigest：输出人话、没有 JSON 花括号、有长度上限', () => {
  const e1 = newBrowseEntry({ tool: 'web_search', arg: '{"query":"活人感 是什么"}', head: '{"results":[]}' });
  const e2 = newBrowseEntry({ tool: 'web_fetch', arg: 'https://zhihu.com/q/1', head: 'AI 活人感是什么意思？' });
  const text = renderBrowseDigest([e1, e2], { maxItems: 8 });
  assert.ok(text.startsWith('今天网上看过：'));
  assert.ok(!text.includes('{'), '不许再有 JSON');
  assert.ok(text.includes('没找到'));
  assert.ok(text.length <= 340);
});

test('renderBrowseDigest：全是空条目就返回空串（不写空记忆）', () => {
  const e = newBrowseEntry({ tool: 'web_search', arg: '', head: '' });
  assert.equal(renderBrowseDigest([e], { maxItems: 8 }), '');
});
