// [ROLE-COND] 角色卡条件注入（世界书式）的解析契约：支持嵌套（套娃）。
//
// 背景：人格卡里用 `[[?关键词|关键词2]] … [[/?]]` 标记"只有上下文命中才注入"的块。
// 旧实现用非贪婪正则配对，内层的 `[[/?]]` 会被外层当成结束符——一旦套娃就错位，
// 表现为"父块没命中、子块内容却漏出来"或"整段被吞"。本文件锁住栈式解析的语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionedRoleText } from '../src/domain/leaves/inori-works.js';

const CARD = (() => {
  // 三层：外层 干活 → 子层 手机（叶子）、子层 记忆 → 孙层 词库（叶子）
  return [
    'A',
    '[[?干活]]',
    'B',
    '[[?手机]]C[[/?]]',
    'D',
    '[[?记忆]]E',
    '[[?词库]]F[[/?]]',
    'G',
    '[[/?]]',
    '[[/?]]',
    'Z',
  ].join('');
})();

test('无标记：原样返回（老卡片兼容）', () => {
  assert.equal(conditionedRoleText('纯人格文本', '干活'), '纯人格文本');
  assert.equal(conditionedRoleText('', '干活'), '');
});

test('单层：命中保留、未命中原样剔除', () => {
  assert.equal(conditionedRoleText('a[[?干活]]b[[/?]]c', '帮我干活'), 'abc');
  assert.equal(conditionedRoleText('a[[?干活]]b[[/?]]c', '今天好累'), 'ac');
});

test('多层：父块不命中 ⇒ 整棵子树都不注入（子块命中也没用）', () => {
  // 只提手机、不提干活：外层 干活 不命中，手机内容不能漏出来
  assert.equal(conditionedRoleText(CARD, '手机没电了'), 'AZ');
});

test('多层：父块命中、子块不命中 ⇒ 只注入父层直属内容', () => {
  // 干活命中；手机/记忆两个子块都不命中 ⇒ 只剩 B D G? 注意 G 属于记忆块，不注入
  assert.equal(conditionedRoleText(CARD, '帮我干活'), 'ABDZ');
});

test('多层：子块命中 ⇒ 注入该子块（但不越过父层）', () => {
  assert.equal(conditionedRoleText(CARD, '帮我干活 手机在哪'), 'ABCDZ');
});

test('三层：孙块按自己的关键词判断，不继承兄弟块', () => {
  assert.equal(conditionedRoleText(CARD, '干活 记忆里找'), 'ABDEGZ');
  assert.equal(conditionedRoleText(CARD, '干活 记忆里找 词库'), 'ABDEFGZ');
  // 只命中孙层、父层不命中 ⇒ 仍然整体不注入
  assert.equal(conditionedRoleText(CARD, '词库里有这个词'), 'AZ');
});

test('残缺标记：多余闭合不吞内容、未闭合按可显示处理', () => {
  assert.equal(conditionedRoleText('x[[/?]]y', '干活'), 'x[[/?]]y');
  assert.equal(conditionedRoleText('X[[?干活]]Y', '干活'), 'XY');
  assert.equal(conditionedRoleText('X[[?干活]]Y', '闲聊'), 'X');
});

test('空关键词块 = 无条件注入（世界书里的 constant）', () => {
  assert.equal(conditionedRoleText('a[[?]]b[[/?]]c', '随便'), 'abc');
});
