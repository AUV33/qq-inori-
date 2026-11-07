// qq-model-view 金标：只压缩「给模型看」的视图——省略假值/空值、去重文本、媒体按可否按消息取用裁剪。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactModelMessage, compactModelData, serializeModelData } from '../src/domain/persona/qq-model-view.js';

const msg = (over = {}) => ({
  seq: 12, messageId: 'm1', sender: 'A', userId: '9', text: '你好', plain: '你好', tail: '你好',
  quoteTargetIsSelf: false, isOwner: false, isSelf: false, hasMedia: false, hasForward: false,
  ...over,
});

test('compactModelMessage：false 的布尔标记与空字段被省略；text/plain/tail 相同的只留一个', () => {
  const out = compactModelMessage(msg());
  assert.equal(out.quoteTargetIsSelf, undefined);
  assert.equal(out.isOwner, undefined);
  assert.equal(out.isSelf, undefined);
  assert.equal(out.hasMedia, undefined);
  assert.equal(out.hasForward, undefined);
  assert.equal(out.text, '你好');
  assert.equal(out.plain, undefined, '与 text 相同的 plain 去掉');
  assert.equal(out.tail, undefined);
});

test('compactModelMessage：true 的标记保留；不同的 plain/tail 不能被吃（引用上下文/长尾）', () => {
  const out = compactModelMessage(msg({ isOwner: true, plain: '带引用上下文的正文', tail: '长消息的结尾' }));
  assert.equal(out.isOwner, true);
  assert.equal(out.plain, '带引用上下文的正文');
  assert.equal(out.tail, '长消息的结尾');
});

test('媒体：有可用 seq 时删掉 file/url（按 message 取图），并补一基序号', () => {
  const out = compactModelMessage(msg({
    hasMedia: true,
    media: [{ kind: 'image', file: 'a.jpg', url: 'https://x/a.jpg' }, { kind: 'image', file: 'b.jpg', index: 7 }],
  }));
  assert.equal(out.media[0].file, undefined);
  assert.equal(out.media[0].url, undefined);
  assert.equal(out.media[0].index, 1, '序号按 1 基对齐取图工具');
  assert.equal(out.media[1].index, 7, '已有 index 不覆盖');
});

test('媒体：没有可用 seq 时保留传输引用；file===url 时去掉重复的 file', () => {
  const out = compactModelMessage(msg({
    seq: 0,
    media: [
      { kind: 'image', file: 'a.jpg', url: 'https://x/a.jpg' },
      { kind: 'image', file: 'same', url: 'same' },
      { kind: 'face', faceId: '' },
    ],
  }));
  assert.equal(out.media[0].file, 'a.jpg', '转发节点只能靠 file/url，不能删');
  assert.equal(out.media[1].file, undefined, 'file 与 url 相同时去掉冗余');
  assert.equal(out.media[2].faceId, undefined, '空 faceId 去掉');
});

test('compactModelMessage：非对象原样返回（数组中可能混着字符串）', () => {
  assert.equal(compactModelMessage(null), null);
  assert.equal(compactModelMessage('x'), 'x');
  assert.equal(compactModelMessage([1, 2]).length, 2);
});

test('compactModelMessage：不改原对象', () => {
  const original = msg({ media: [{ kind: 'image', file: 'a.jpg' }] });
  const snapshot = JSON.stringify(original);
  compactModelMessage(original);
  assert.equal(JSON.stringify(original), snapshot);
});

test('compactModelData：只压缩 messages/newMessages 数组，其它字段原样递归', () => {
  const data = {
    key: 'group:1',
    messages: [msg()],
    newMessages: [msg({ seq: 13 })],
    other: [{ keep: true, isSelf: false }],
    nested: { messages: [msg({ seq: 14 })] },
  };
  const out = compactModelData(data);
  assert.equal(out.messages[0].isSelf, undefined, 'messages 里的消息要被压缩');
  assert.equal(out.newMessages[0].isSelf, undefined);
  assert.deepEqual(out.other, [{ keep: true, isSelf: false }], '非 messages 数组不按消息压缩');
  assert.equal(out.nested.messages[0].isSelf, undefined, '嵌套里的 messages 也要压缩');
  assert.equal(out.key, 'group:1');
});

test('compactModelData：数组/标量直接递归透传', () => {
  assert.deepEqual(compactModelData([1, 'a', null]), [1, 'a', null]);
  assert.equal(compactModelData('x'), 'x');
  assert.equal(compactModelData(null), null);
});

test('serializeModelData：输出是 JSON 字符串，且已压缩（false 标记不出现）', () => {
  const text = serializeModelData({ messages: [msg()] });
  assert.equal(typeof text, 'string');
  const parsed = JSON.parse(text);
  assert.equal(parsed.messages[0].isSelf, undefined);
  assert.ok(!text.includes('"isSelf"'));
});
