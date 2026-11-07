import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldConsultSecretary,
  buildSecretaryPrompt,
  parseSecretaryVerdict,
  secretaryAllows,
} from '../src/domain/conversation/secretary.mjs';

test('只对非定向唤醒问秘书：@/名字/被拍她本人直接放行', () => {
  for (const r of ['question', 'aboutSelf:alias', 'probability', 'continueChat', 'joinTopic']) {
    assert.equal(shouldConsultSecretary(r), true, r);
  }
  for (const r of ['atMention', 'nameMention', 'poke', 'recovery', 'bootstrap', 'private']) {
    assert.equal(shouldConsultSecretary(r), false, r);
  }
  assert.equal(shouldConsultSecretary('question', { enabled: false }), false);
});

test('prompt 带上她、唤醒原因、最近消息、最后一条和少样本', () => {
  const p = buildSecretaryPrompt({
    selfName: '阿满',
    reason: 'question',
    sender: '老张',
    text: '你们觉得这个怎么弄？',
    recent: [
      { sender: '小王', text: '先别急' },
      { sender: '老李', text: '我看行' },
    ],
  });
  assert.match(p, /阿满/);
  assert.match(p, /question/);
  assert.match(p, /小王：先别急/);
  assert.match(p, /最后一条】老张：你们觉得这个怎么弄/);
  assert.match(p, /should_reply/);
  assert.match(p, /你看我的多可爱/, '少样本里要教它「你」不等于「她」');
});

test('解析：容忍代码块与前后废话；字段不合法返回 null；「你」归一成「她」', () => {
  assert.deepEqual(
    parseSecretaryVerdict('```json\n{"addressed":"别人","topic":"点外卖","should_reply":false,"why":"在跟老张说"}\n```'),
    { addressed: '别人', topic: '点外卖', shouldReply: false, why: '在跟老张说' },
  );
  assert.equal(parseSecretaryVerdict('{"addressed":"你","should_reply":true}').addressed, '她');
  assert.equal(parseSecretaryVerdict('随便说点什么'), null);
  assert.equal(parseSecretaryVerdict('{"addressed":"大家","should_reply":true}'), null);
  assert.equal(parseSecretaryVerdict('{"addressed":"她","should_reply":"yes"}'), null);
});

test('放行规则：判不了放行；should_reply=false 拦；其余放行', () => {
  assert.equal(secretaryAllows(null), true);
  assert.equal(secretaryAllows({ addressed: '别人', shouldReply: false }), false);
  assert.equal(secretaryAllows({ addressed: '她', shouldReply: false }), false);
  assert.equal(secretaryAllows({ addressed: '她', shouldReply: true }), true);
  assert.equal(secretaryAllows({ addressed: '别人', shouldReply: true }), true, '开放问大家这类按模型判断放行');
  assert.equal(secretaryAllows({ addressed: '群里', shouldReply: true }), true);
});
