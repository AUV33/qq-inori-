// forward 金标：合并转发——forward id 清洗/提取、节点文本化、媒体与嵌套转发元数据、限量与代理对安全截断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForwardId, forwardIdFromData, extractForwardIds, nodeText, formatForwardResponse } from '../src/domain/conversation/forward.js';

test('sanitizeForwardId：只允许安全字符、限长 256，其余返回空串', () => {
  assert.equal(sanitizeForwardId('abc123'), 'abc123');
  assert.equal(sanitizeForwardId('a:b/c=d+e@f-g_h.i'), 'a:b/c=d+e@f-g_h.i');
  assert.equal(sanitizeForwardId('  abc  '), 'abc');
  assert.equal(sanitizeForwardId('a b'), '', '空白拒绝');
  assert.equal(sanitizeForwardId('a\nb'), '', '控制字符拒绝');
  assert.equal(sanitizeForwardId('x'.repeat(257)), '', '超长拒绝');
  assert.equal(sanitizeForwardId(''), '');
  assert.equal(sanitizeForwardId(null), '');
});

test('forwardIdFromData：id/res_id/file_id/forward_id 四种字段名都认', () => {
  assert.equal(forwardIdFromData({ id: 'a1' }), 'a1');
  assert.equal(forwardIdFromData({ res_id: 'b2' }), 'b2');
  assert.equal(forwardIdFromData({ file_id: 'c3' }), 'c3');
  assert.equal(forwardIdFromData({ forward_id: 'd4' }), 'd4');
  assert.equal(forwardIdFromData({ id: '坏 id' }), '');
  assert.equal(forwardIdFromData(null), '');
});

test('extractForwardIds：只取 forward 段、去重、保持顺序', () => {
  const ids = extractForwardIds([
    { type: 'text', data: { text: 'x' } },
    { type: 'forward', data: { id: 'f1' } },
    { type: 'forward', data: { id: 'f1' } },
    { type: 'forward', data: { id: 'f2' } },
    { type: 'forward', data: { id: '坏 id' } },
  ]);
  assert.deepEqual(ids, ['f1', 'f2']);
  assert.deepEqual(extractForwardIds(null), []);
});

test('nodeText：标准转发节点的文本化（text/at/face/image/video/file/reply/forward/json）', () => {
  const node = {
    type: 'node',
    data: {
      name: '小明', uin: '123',
      content: [
        { type: 'text', data: { text: '你好' } },
        { type: 'at', data: { qq: 'all' } },
        { type: 'face', data: { id: 14 } },
        { type: 'image', data: { file: 'a.jpg' } },
        { type: 'video', data: { title: '视频标题过长'.slice(0, 4), duration: 12.6 } },
        { type: 'file', data: { name: 'a.txt' } },
        { type: 'reply', data: { id: '1' } },
        { type: 'forward', data: { id: 'f1' } },
        { type: 'json', data: {} },
      ],
    },
  };
  const text = nodeText(node);
  assert.ok(text.includes('你好'));
  assert.ok(text.includes('@全体成员'));
  assert.ok(text.includes('[表情14]'));
  assert.ok(text.includes('[图片]'));
  assert.ok(text.includes('[视频 '));
  assert.ok(text.includes('（13s）'), '时长四舍五入');
  assert.ok(text.includes('[文件a.txt]'));
  assert.ok(text.includes('[引用]'));
  assert.ok(text.includes('[转发]'));
  assert.ok(text.includes('[卡片消息]'));
});

test('nodeText：字符串内容里的 CQ 码被替换成占位，不原样喂给模型', () => {
  assert.equal(nodeText({ message: '看[CQ:image,file=x]这个' }), '看[媒体]这个');
  assert.equal(nodeText({ message: [{ type: 'text', data: { text: '纯文本' } }] }), '纯文本');
  assert.equal(nodeText(null), '');
  assert.equal(nodeText({}), '');
});

test('formatForwardResponse：逐条给出 sender/userId/time/文本，条数受 maxMessages 限制', () => {
  const data = { messages: Array.from({ length: 5 }, (_, i) => ({ data: { name: `人${i}`, uin: String(100 + i), time: 1000 + i, content: [{ type: 'text', data: { text: `第${i}条` } }] } })) };
  const r = formatForwardResponse(data, { maxMessages: 2 });
  assert.equal(r.total, 5);
  assert.equal(r.messages.length, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.messages[0].index, 1);
  assert.equal(r.messages[0].sender, '人0');
  assert.equal(r.messages[0].userId, '100');
  assert.equal(r.messages[0].time, 1000);
  assert.equal(r.messages[0].text, '第0条');
});

test('formatForwardResponse：单条文本超限会截断并标 textTruncated，且不切开 emoji', () => {
  const emoji = '😀';
  const long = 'a'.repeat(4) + emoji + 'b'.repeat(20);
  const r = formatForwardResponse({ messages: [{ data: { content: [{ type: 'text', data: { text: long } }] } }] }, { maxCharsPerMessage: 5 });
  assert.equal(r.textTruncated, true);
  assert.equal(r.truncated, true);
  const text = r.messages[0].text;
  assert.ok(!/[\uD800-\uDBFF]$/.test(text), `不能以孤立高代理结尾：${JSON.stringify(text)}`);
  assert.ok(text.length <= 5);
});

test('formatForwardResponse：媒体与嵌套转发 id 从内容里提取（图片/表情/视频封面/嵌套转发）', () => {
  const node = {
    data: {
      name: 'A',
      content: [
        { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
        { type: 'face', data: { id: 3 } },
        { type: 'video', data: { thumbUrl: 'https://x/t.jpg', duration: 5 } },
        { type: 'forward', data: { id: 'inner1' } },
        { type: 'forward', data: { id: 'inner1' } },
      ],
    },
  };
  const r = formatForwardResponse([node]);
  const m = r.messages[0];
  assert.deepEqual(m.media.map((x) => x.kind), ['image', 'face', 'video-thumb']);
  assert.equal(m.media[0].file, 'a.jpg');
  assert.equal(m.media[1].faceId, '3');
  assert.equal(m.media[2].duration, '5');
  assert.deepEqual(m.nestedForwardIds, ['inner1'], '嵌套转发 id 去重');
});

test('formatForwardResponse：单个消息段对象内容也能提取（兼容非数组）', () => {
  const r = formatForwardResponse([{ data: { content: { type: 'image', data: { file: 'only.jpg' } } } }]);
  assert.equal(r.messages[0].text, '[图片]');
  assert.deepEqual(r.messages[0].media, [{ kind: 'image', file: 'only.jpg', url: undefined }], '没有 url 时字段是 undefined');
});

test('formatForwardResponse：参数夹取（maxMessages 1..100，maxChars 1..2000）', () => {
  const many = { messages: Array.from({ length: 120 }, () => ({ data: { content: 'x' } })) };
  assert.equal(formatForwardResponse(many, { maxMessages: 9999 }).messages.length, 100);
  assert.equal(formatForwardResponse(many, { maxMessages: -5 }).messages.length, 1);
  const r = formatForwardResponse([{ data: { content: 'y'.repeat(3000) } }], { maxCharsPerMessage: 99999 });
  assert.equal(r.messages[0].text.length, 2000);
});

test('formatForwardResponse：空输入/非数组安全', () => {
  assert.deepEqual(formatForwardResponse(null), { total: 0, truncated: false, textTruncated: false, messages: [] });
  assert.equal(formatForwardResponse({}).total, 0);
  assert.equal(formatForwardResponse('x').total, 0);
});
