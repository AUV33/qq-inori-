// onebot-transport 金标：令牌拦截、段序与端点、网关错误翻译、图片类型/尺寸识别。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOneBotTransport } from '../src/adapters/onebot-transport.mjs';

function makeCtx(overrides = {}) {
  const state = { calls: [], logs: [] };
  const svc = createOneBotTransport({
    cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000/', accessToken: 'tok' } },
    log: (m) => state.logs.push(String(m)),
    knownAgentTokens: new Set(['secret-token']),
    escapeCqText: (s) => s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;'),
    fetch: async (url, init) => {
      state.calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
    ...overrides,
  });
  return { svc, state };
}

test('onebotSend：内容里有会话令牌就拦截，不发请求', async () => {
  const h = makeCtx();
  await assert.rejects(() => h.svc.onebotSend('group', 1, '看这个 secret-token'), /包含会话令牌/);
  assert.equal(h.state.calls.length, 0);
  assert.ok(h.state.logs.some((l) => l.includes('已阻止发送')));
});

test('onebotSend：reply/at 参数校验（不许 @all）', async () => {
  const h = makeCtx();
  await assert.rejects(() => h.svc.onebotSend('group', 1, 'x', 'abc'), /非零整数/);
  await assert.rejects(() => h.svc.onebotSend('group', 1, 'x', undefined, 'all'), /正整数 QQ 号/);
  await assert.rejects(() => h.svc.onebotSend('group', 1, 'x', undefined, '-5'), /正整数 QQ 号/);
  assert.equal(h.state.calls.length, 0);
});

test('onebotSend：群/私聊端点正确，段序 reply→at→text，CQ 转义生效', async () => {
  const h = makeCtx();
  await h.svc.onebotSend('group', 123456789, 'a&b[c]', 99, '12345');
  const call = h.state.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:3000/send_group_msg');
  assert.equal(call.body.group_id, 123456789);
  assert.deepEqual(call.body.message.map((s) => s.type), ['reply', 'at', 'text']);
  assert.equal(call.body.message[2].data.text, 'a&amp;b&#91;c]');
  assert.equal(call.headers.authorization, 'Bearer tok');

  await h.svc.onebotSend('private', 10001, 'hi');
  const priv = h.state.calls[1];
  assert.equal(priv.url, 'http://127.0.0.1:3000/send_private_msg');
  assert.equal(priv.body.user_id, 10001);
  assert.deepEqual(priv.body.message.map((s) => s.type), ['text'], '没有引用/@ 时只有文本段');
});

test('onebotSend：网关失败要把 wording/retcode 翻成人话；426 额外提示 httpUrl', async () => {
  const bad = makeCtx({
    fetch: async () => ({ ok: false, status: 200, json: async () => ({ status: 'failed', retcode: 120, wording: '权限不足' }) }),
  });
  await assert.rejects(() => bad.svc.onebotSend('group', 1, 'x'), /OneBot send_group_msg 失败: 权限不足/);

  const wrongPort = makeCtx({
    fetch: async () => ({ ok: false, status: 426, json: async () => ({}) }),
  });
  await assert.rejects(() => wrongPort.svc.onebotSend('group', 1, 'x'), /HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口/);
});

test('setInputStatus：成功发 event_type 1/0，失败只记日志', async () => {
  const h = makeCtx();
  await h.svc.setInputStatus(10001, true);
  assert.equal(h.state.calls[0].url, 'http://127.0.0.1:3000/set_input_status');
  assert.deepEqual(h.state.calls[0].body, { user_id: 10001, event_type: 1 });
  await h.svc.setInputStatus(10001, false);
  assert.equal(h.state.calls[1].body.event_type, 0);

  const broken = makeCtx({ fetch: async () => { throw new Error('网关没起'); } });
  await assert.doesNotReject(() => broken.svc.setInputStatus(1, true));
  assert.ok(broken.state.logs.some((l) => l.includes('输入状态切换失败')));
});

test('mimeFromBuffer：认 PNG/JPEG/GIF/WebP，太短或未知回落 jpeg', () => {
  const h = makeCtx();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a' + '\0'.repeat(6), 'ascii');
  const webp = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii');
  assert.equal(h.svc.mimeFromBuffer(png), 'image/png');
  assert.equal(h.svc.mimeFromBuffer(jpeg), 'image/jpeg');
  assert.equal(h.svc.mimeFromBuffer(gif), 'image/gif');
  assert.equal(h.svc.mimeFromBuffer(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
  assert.equal(h.svc.mimeFromBuffer(Buffer.from([1, 2, 3])), 'image/jpeg');
  assert.equal(h.svc.mimeFromBuffer(null), 'image/jpeg');
});

test('mimeFromUrl：扩展名优先，坏 URL 用 fallback', () => {
  const h = makeCtx();
  assert.equal(h.svc.mimeFromUrl('https://a/x.PNG'), 'image/png');
  assert.equal(h.svc.mimeFromUrl('https://a/x.webp?size=1'), 'image/webp');
  assert.equal(h.svc.mimeFromUrl('https://a/x.jpeg'), 'image/jpeg');
  assert.equal(h.svc.mimeFromUrl('不是URL', 'image/gif'), 'image/gif');
});

function pngBuffer(w, h) {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

test('getImageDimensions：PNG / GIF 宽高', () => {
  const h = makeCtx();
  assert.deepEqual(h.svc.getImageDimensions(pngBuffer(800, 600)), { width: 800, height: 600 });
  const gif = Buffer.alloc(24); // 实现要求 >=24 字节才解析
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  assert.deepEqual(h.svc.getImageDimensions(gif), { width: 320, height: 240 });
});

test('getImageDimensions：JPEG 的 SOF0 段（跳过 DHT 之类）', () => {
  const h = makeCtx();
  const b = Buffer.alloc(26); // 实现要求 >=24 字节才解析
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0;
  b.writeUInt16BE(17, 4);          // 段长
  b[6] = 8;                        // 精度
  b.writeUInt16BE(480, 7);         // height
  b.writeUInt16BE(640, 9);         // width
  assert.deepEqual(h.svc.getImageDimensions(b), { width: 640, height: 480 });
});

test('getImageDimensions：WebP 三种容器（VP8X / VP8L / VP8）', () => {
  const h = makeCtx();
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'ascii'); vp8x.write('WEBP', 8, 'ascii'); vp8x.write('VP8X', 12, 'ascii');
  vp8x[24] = 63; vp8x[25] = 2; vp8x[26] = 0;  // width = 1 + 63 + 512 = 576
  vp8x[27] = 87; vp8x[28] = 1; vp8x[29] = 0;  // height = 1 + 87 + 256 = 344
  assert.deepEqual(h.svc.getImageDimensions(vp8x), { width: 576, height: 344 });

  const vp8l = Buffer.alloc(25);
  vp8l.write('RIFF', 0, 'ascii'); vp8l.write('WEBP', 8, 'ascii'); vp8l.write('VP8L', 12, 'ascii');
  vp8l[21] = 0x2f; vp8l[22] = 0x01; vp8l[23] = 0x10; vp8l[24] = 0x02;
  const dims = h.svc.getImageDimensions(vp8l);
  assert.ok(dims && dims.width > 0 && dims.height > 0);

  const vp8 = Buffer.alloc(30);
  vp8.write('RIFF', 0, 'ascii'); vp8.write('WEBP', 8, 'ascii'); vp8.write('VP8 ', 12, 'ascii');
  vp8.writeUInt16LE(400, 26); vp8.writeUInt16LE(300, 28);
  assert.deepEqual(h.svc.getImageDimensions(vp8), { width: 400, height: 300 });
});

test('getImageDimensions：太短/未知格式返回 null，不抛错', () => {
  const h = makeCtx();
  assert.equal(h.svc.getImageDimensions(Buffer.alloc(10)), null);
  assert.equal(h.svc.getImageDimensions(null), null);
  assert.equal(h.svc.getImageDimensions(Buffer.alloc(64)), null);
});
