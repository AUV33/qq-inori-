// [NAME-CALL] 喊名字必须叫得醒：全名 / 别名 / 单字名 / 误触发防护
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWakeTriggerV2, matchNameCall } from '../src/domain/conversation/wake-trigger.mjs';

// 夹具角色「小满」：别名和单字名排除词都显式传，不依赖默认值——
// 默认配置里不含任何角色名（人格卡是私有的，见 docs/PUBLISHING.md）。
const ALIASES = ['小满', '满满', '满宝', '满酱', '阿满', '满子'];
const BLOCK = ['满意', '满足', '满屏', '满分'];

const st = { wakeConfig: { triggers: { atMention: true, nameMention: true, question: false, probability: 0, keywords: [] } } };
const cfg = { socialV2: { aboutSelf: { enabled: true, aliases: ALIASES, singleCharBlock: BLOCK } } };
const nick = '小满';
const call = (text, extra = {}) => evaluateWakeTriggerV2(
  'group:1', st, { user_id: 42, self_id: 99, message: [{ type: 'text', data: { text } }] },
  'group', text, text, false,
  { cfg, selfNickname: nick, random: () => 1, ...extra },
);

test('全名与别名都能叫醒', () => {
  for (const t of ['小满', '小满在吗', '满满', '满宝', '满酱', '阿满', '满子']) {
    assert.equal(call(t), 'nameMention', `「${t}」应该 nameMention`);
  }
});

test('单字名「满」在短消息里算叫（以前这条直接静音）', () => {
  assert.equal(call('满'), 'nameMention');
  assert.equal(call('满，在吗'), 'nameMention');
  assert.equal(call('满？'), 'nameMention');
});

test('单字名重复叫不会被 aboutSelf 冷却吃掉', () => {
  const denied = { aboutSelfAllowed: () => false };
  assert.equal(call('满', denied), 'nameMention');
  assert.equal(call('满满', denied), 'nameMention');
});

test('误触发防护：满意/满足这类词不算叫她', () => {
  for (const t of ['满意一下', '满足好运', '满屏都是', '满分通过']) {
    assert.notEqual(call(t), 'nameMention', `「${t}」不该被当成叫名字`);
  }
});

test('长句里夹一个「满」不算叫她', () => {
  const long = '这个游戏里那个满屏的爆率是不是有点低啊兄弟们';
  assert.notEqual(call(long), 'nameMention');
});

test('matchNameCall 直接测：空文本/无昵称不误报', () => {
  assert.equal(matchNameCall(''), '');
  assert.equal(matchNameCall('随便说说', { nickname: '' }), '');
  assert.equal(matchNameCall('满', { nickname: '小满', aliases: ALIASES, singleCharBlock: BLOCK }), '满');
});
