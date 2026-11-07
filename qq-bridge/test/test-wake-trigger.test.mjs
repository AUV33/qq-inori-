import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWakeTriggerV2, messageAtsSelf } from '../src/domain/conversation/wake-trigger.mjs';

const baseState = (triggers = {}) => ({ wakeConfig: { triggers } });
const noCfg = { cfg: { socialV2: {} }, selfNickname: '小满' };

test('私聊永远唤醒；群聊默认不唤醒', () => {
  assert.equal(evaluateWakeTriggerV2('private:1', baseState(), {}, 'private', 'x', 'x', false, noCfg), 'private');
  assert.equal(evaluateWakeTriggerV2('group:1', baseState(), {}, 'group', '随便聊聊', '随便聊聊', false, noCfg), null);
});

test('anyMessage 优先于其它规则', () => {
  const st = baseState({ anyMessage: true, atMention: true });
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', 'hi', 'hi', false, noCfg), 'anyMessage');
});

test('@ 她：at 段命中或引用了她', () => {
  const st = baseState({ atMention: true });
  const atEvent = { self_id: 42, message: [{ type: 'at', data: { qq: '42' } }] };
  assert.equal(evaluateWakeTriggerV2('group:1', st, atEvent, 'group', '在吗', '在吗', false, noCfg), 'atMention');
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '引用', '引用', true, noCfg), 'atMention');
});

test('@ 别人不会误判', () => {
  const st = baseState({ atMention: true });
  const atOther = { self_id: 42, message: [{ type: 'at', data: { qq: '99' } }] };
  assert.equal(evaluateWakeTriggerV2('group:1', st, atOther, 'group', 'hi', 'hi', false, noCfg), null);
});

test('nameMention：昵称大小写/带 @ 都算', () => {
  const st = baseState({ nameMention: true });
  const deps = { cfg: { socialV2: {} }, selfNickname: '阿满' };
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '@阿满 在吗', '@阿满 在吗', false, deps), 'nameMention');
});

test('keywords：短英文用词边界，长词用包含', () => {
  const st = baseState({ keywords: ['DS', '小鲸鱼'] });
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '这画质 ADS 了吧', '这画质 ADS 了吧', false, noCfg), null, 'ADS 不该命中 DS');
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', 'DS 又崩了', 'DS 又崩了', false, noCfg), 'keyword:DS');
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '小鲸鱼在吗', '小鲸鱼在吗', false, noCfg), 'keyword:小鲸鱼');
});

test('question：只在像"冲她问"时命中', () => {
  const st = baseState({ question: true });
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '你这模型行不行？', '你这模型行不行？', false, noCfg), 'question');
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '今天天气不错', '今天天气不错', false, noCfg), null);
});

test('aboutSelf：议论她时命中，且优先于关键词', () => {
  const st = baseState({ keywords: ['DS'] });
  assert.equal(
    evaluateWakeTriggerV2('group:1', st, {}, 'group', '那个 bot 刚才说的不对', '那个 bot 刚才说的不对', false, noCfg),
    'aboutSelf:thirdParty',
  );
});

test('@ 她时 atMention 优先于 aboutSelf（提示词该说「有人@你」，不是「他们在说你」）', () => {
  const st = baseState({ atMention: true, nameMention: true });
  const atEvent = { self_id: 42, message: [{ type: 'at', data: { qq: '42' } }] };
  const text = '@小满 你今天不困吗';
  assert.equal(evaluateWakeTriggerV2('group:1', st, atEvent, 'group', text, text, false, noCfg), 'atMention');
});

test('aboutSelf 冷却：同一人冷却期内不再重复叫醒', () => {
  const st = baseState({});
  const ev = { user_id: 9 };
  assert.equal(
    evaluateWakeTriggerV2('group:1', st, ev, 'group', '那个 bot 刚才说的不对', '那个 bot 刚才说的不对', false, { ...noCfg, aboutSelfAllowed: () => false }),
    null,
  );
});

test('aboutSelf 被关掉时不再命中', () => {
  const st = baseState({});
  const cfg = { socialV2: { aboutSelf: { enabled: false } } };
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', '小满在吗', '小满在吗', false, { cfg, selfNickname: '小满' }), null);
});

test('speakerIds：指定发言人才唤醒，返回显示名', () => {
  const st = baseState({ speakerIds: ['777'] });
  const ev = { user_id: 777, sender: { card: '老张' } };
  assert.equal(evaluateWakeTriggerV2('group:1', st, ev, 'group', '随便', '随便', false, noCfg), 'speaker:老张');
  assert.equal(evaluateWakeTriggerV2('group:1', st, { user_id: 888 }, 'group', '随便', '随便', false, noCfg), null);
});

test('probability：用注入的 random，不碰真随机', () => {
  const st = baseState({ probability: 0.5 });
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', 'x', 'x', false, { ...noCfg, random: () => 0.1 }), 'probability');
  assert.equal(evaluateWakeTriggerV2('group:1', st, {}, 'group', 'x', 'x', false, { ...noCfg, random: () => 0.9 }), null);
});

test('messageAtsSelf：按 self_id 比对 at 段', () => {
  assert.equal(messageAtsSelf({ self_id: 42, message: [{ type: 'at', data: { qq: 42 } }] }), true);
  assert.equal(messageAtsSelf({ self_id: 42, message: [{ type: 'at', data: { qq: 7 } }] }), false);
  assert.equal(messageAtsSelf({ self_id: 42, message: 'not-an-array' }), false);
  assert.equal(messageAtsSelf(null), false);
});
