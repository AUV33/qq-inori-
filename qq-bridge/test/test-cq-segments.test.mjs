// 行为级测试：cq-segments.mjs（从 app.mjs 拆出的 OneBot 段工具）。
// 不同于部分旧测试只断言"不抛"，这里断言真实产出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsToText, extractMediaFromSegments, canonicalV2Key } from '../src/domain/shared/cq-segments.mjs';
import { sanitizeForwardId, forwardIdFromData } from '../src/domain/shared/forward-id.mjs';

test('segmentsToText: 纯文本段', async () => {
  assert.equal(await segmentsToText([{ type: 'text', data: { text: '你好 world' } }]), '你好 world');
});

test('segmentsToText: string 直接返回', async () => {
  assert.equal(await segmentsToText('纯字符串消息'), '纯字符串消息');
});

test('segmentsToText: @全体成员 / @具体人 解析', async () => {
  assert.equal(await segmentsToText([{ type: 'at', data: { qq: 'all' } }]), '@全体成员');
  // 有 resolveAtName 时解析成昵称，否则回退 QQ 号
  assert.equal(await segmentsToText([{ type: 'at', data: { qq: '12345' } }], { resolveAtName: async () => '小明' }), '@小明');
  assert.equal(await segmentsToText([{ type: 'at', data: { qq: '12345' } }]), '@12345');
});

test('segmentsToText: 各类段转为占位文本并拼接', async () => {
  const segs = [
    { type: 'text', data: { text: '看' } },
    { type: 'face', data: { id: '12' } },
    { type: 'image', data: {} },
    { type: 'record', data: {} },
    { type: 'video', data: {} },
    { type: 'file', data: { name: 'a.zip' } },
    { type: 'json', data: {} },
    { type: 'forward', data: { id: 'fwd-99' } },
    { type: 'unknownX', data: {} },
  ];
  assert.equal(
    await segmentsToText(segs),
    '看[表情12][图片][语音][视频][文件a.zip][卡片消息][转发消息 id=fwd-99][unknownX]'
  );
});

test('segmentsToText: reply 解析（includeReply=false 跳过）', async () => {
  const segs = [
    { type: 'reply', data: { id: 'r1' } },
    { type: 'text', data: { text: '在吗' } },
  ];
  assert.equal(await segmentsToText(segs, { resolveReply: async () => ({ sender: '小红', text: '你好' }) }), '[引用 小红：你好]在吗');
  // includeReply=false：只拿到当前消息自身文字
  assert.equal(await segmentsToText(segs, { resolveReply: async () => ({ sender: '小红', text: '你好' }), includeReply: false }), '在吗');
});

test('extractMediaFromSegments: image / face / video-thumb', () => {
  const media = extractMediaFromSegments([
    { type: 'image', data: { file: 'a.b64', url: 'http://x/a.png', summary: '猫' } },
    { type: 'face', data: { id: '7' } },
    { type: 'video', data: { thumbUrl: 'http://x/thumb.jpg', url: 'http://x/v.mp4', file: 'v.mp4', duration: 12 } },
    { type: 'text', data: { text: '忽略' } },
  ]);
  assert.deepEqual(media, [
    { kind: 'image', file: 'a.b64', url: 'http://x/a.png', subType: '', summary: '猫' },
    { kind: 'face', faceId: '7' },
    { kind: 'video-thumb', url: 'http://x/thumb.jpg', duration: '12', videoUrl: 'http://x/v.mp4', videoFile: 'v.mp4' },
  ]);
});

test('canonicalV2Key: 规范化与拒绝非法', () => {
  assert.equal(canonicalV2Key('group:123'), 'group:123');
  assert.equal(canonicalV2Key('private:007'), 'private:7'); // 去前导零
  assert.equal(canonicalV2Key(' group:5 '), 'group:5'); // 去空格
  assert.equal(canonicalV2Key('group:0'), null); // 非正
  assert.equal(canonicalV2Key('group:-3'), null);
  assert.equal(canonicalV2Key('guild:9'), null); // 非 group/private
  assert.equal(canonicalV2Key('group:1.5'), null);
  assert.equal(canonicalV2Key(null), null);
});


// [LAYER-FIX] R4 修复后，forward id 清洗规则下沉到 shared，单一真相、可被 shared 同层复用。
test('forward-id: 清洗规则与四种字段名', () => {
  assert.equal(sanitizeForwardId('abc_1'), 'abc_1');
  assert.equal(sanitizeForwardId('  abc  '), 'abc');
  assert.equal(sanitizeForwardId('a b'), '', '空白拒绝');
  assert.equal(sanitizeForwardId('x'.repeat(257)), '', '超长拒绝');
  assert.equal(sanitizeForwardId(null), '');
  assert.equal(forwardIdFromData({ id: 'a1' }), 'a1');
  assert.equal(forwardIdFromData({ res_id: 'b2' }), 'b2');
  assert.equal(forwardIdFromData({ file_id: 'c3' }), 'c3');
  assert.equal(forwardIdFromData({ forward_id: 'd4' }), 'd4');
  assert.equal(forwardIdFromData({ id: '坏 id' }), '');
  assert.equal(forwardIdFromData(null), '');
});