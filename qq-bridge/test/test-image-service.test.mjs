// image-service 金标：发图参数校验/顺序、生图落盘与日志、发不出去要说实话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageService } from '../src/domain/send/image-service.mjs';

function makeCtx(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-img-'));
  const state = { sent: [], logs: [] };
  const svc = createImageService({
    cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000/', accessToken: 'tok' } },
    captureSendGuard: () => () => { state.guardAt = Date.now(); },
    getOutgoing: () => ({ enqueue: (fn) => fn() }),
    sleep: async () => { state.slept = true; },
    randInt: (a) => a,
    fetch: async (url, init) => {
      state.sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9527 } }) };
    },
    oneBotError: (action, res, body) => `${action} 失败: ${body?.retcode ?? 'unknown'}`,
    imagegen: {
      generate: async () => ({ buffer: Buffer.from('PNGDATA'), seed: 42, width: 512, height: 512, steps: 8, elapsedMs: 1234, cold: true }),
      status: async () => ({ running: true }),
      stop: () => 'stopped',
    },
    freeMemMB: () => 4096,
    projectPath: (...p) => path.join(root, ...p),
    stateDataPath: (...p) => path.join(root, 'state', ...p),
    ...overrides,
  });
  return { svc, state, root };
}

test('sendImageV2：空图直接拒绝，不发请求', async () => {
  const h = makeCtx();
  await assert.rejects(() => h.svc.sendImageV2('group:1', Buffer.alloc(0)), /图片是空的/);
  assert.equal(h.state.sent.length, 0);
});

test('sendImageV2：replyToMessageId / atUserId 校验（不接受 all）', async () => {
  const h = makeCtx();
  await assert.rejects(() => h.svc.sendImageV2('group:1', Buffer.from('x'), { replyToMessageId: 'abc' }), /非零整数/);
  await assert.rejects(() => h.svc.sendImageV2('group:1', Buffer.from('x'), { atUserId: 'all' }), /正整数 QQ 号/);
  assert.equal(h.state.sent.length, 0);
});

test('sendImageV2：群/私聊端点、引用+@+图片段、发送前先过 guard', async () => {
  const h = makeCtx();
  const out = await h.svc.sendImageV2('group:123456789', Buffer.from('x'), { replyToMessageId: -123, atUserId: '9' });
  assert.equal(out.messageId, 9527);
  const sent = h.state.sent[0];
  assert.equal(sent.url, 'http://127.0.0.1:3000/send_group_msg');
  assert.equal(sent.body.group_id, 123456789);
  assert.deepEqual(sent.body.message.map((s) => s.type), ['reply', 'at', 'image']);
  assert.equal(sent.body.message[0].data.id, '-123');
  assert.equal(sent.headers.authorization, 'Bearer tok');
  assert.ok(h.state.guardAt, '发送前必须过 guard');
  assert.ok(h.state.slept, '出图后要顿一下');

  const priv = await h.svc.sendImageV2('private:10001', Buffer.from('y'));
  assert.equal(priv.messageId, 9527);
  assert.equal(h.state.sent[1].url, 'http://127.0.0.1:3000/send_private_msg');
  assert.equal(h.state.sent[1].body.user_id, 10001);
});

test('sendImageV2：网关返回非 ok 就抛 oneBotError 文案', async () => {
  const h = makeCtx({
    fetch: async () => ({ ok: false, json: async () => ({ status: 'failed', retcode: 120 }) }),
  });
  await assert.rejects(() => h.svc.sendImageV2('group:1', Buffer.from('x')), /send_group_msg 失败: 120/);
});

test('imageForV2：生图失败要落一条 ok:false 日志并把错误抛出去', async () => {
  const h = makeCtx({
    imagegen: {
      generate: async () => { throw new Error('后端没起来'); },
      status: async () => ({}), stop: () => {},
    },
  });
  await assert.rejects(() => h.svc.imageForV2('group:1', { prompt: '猫' }), /后端没起来/);
  const logFile = path.join(h.root, 'state', 'imagegen.jsonl');
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].error, '后端没起来');
});

test('imageForV2：成功后按日期落盘、写 ok:true 日志、send:false 不发送', async () => {
  const h = makeCtx();
  const out = await h.svc.imageForV2('group:1', { prompt: 'a cat, sitting', send: false });
  assert.equal(out.sent, false);
  assert.equal(out.messageId, null);
  assert.ok(fs.existsSync(out.absPath), '图片文件要真的写出来');
  assert.equal(fs.readFileSync(out.absPath, 'utf8'), 'PNGDATA');
  assert.match(path.basename(out.absPath), /^\d{6}_a-cat-sitting\.png$/, 'slug 取前两段 prompt');
  assert.equal(out.seed, 42);
  const rows = fs.readFileSync(path.join(h.root, 'state', 'imagegen.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].seed, 42);
  assert.equal(h.state.sent.length, 0);
});

test('imageForV2：同名文件不覆盖（加 _2/_3 后缀）', async (t) => {
  // [FLAKY] 文件名前缀是 HHmmss。两次调用一旦跨秒，第二次会拿到新的时间戳而不是 _2，
  // 旧断言因此在并发跑测试时偶发失败。固定 Date 让「同秒」成为确定条件。
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(new Date('2026-11-07T12:00:00').getTime());
  try {
    const h = makeCtx();
    const a = await h.svc.imageForV2('group:1', { prompt: 'same', send: false });
    const b = await h.svc.imageForV2('group:1', { prompt: 'same', send: false });
    assert.notEqual(a.absPath, b.absPath);
    assert.match(path.basename(b.absPath), /_2\.png$/);
  } finally {
    t.mock.timers.reset();
  }
});

test('imageForV2：图出好了发不出去要说清楚（带已落盘路径）', async () => {
  const h = makeCtx({ fetch: async () => ({ ok: false, json: async () => ({ status: 'failed', retcode: 500 }) }) });
  await assert.rejects(() => h.svc.imageForV2('group:1', { prompt: 'cat' }), /图出好了（.*）但发不出去/);
});

test('imageStatusV2 / imageStopV2 / imagePaths：原样透传 + 空闲内存', async () => {
  const h = makeCtx();
  const st = await h.svc.imageStatusV2();
  assert.equal(st.running, true);
  assert.equal(st.freeMemMB, 4096);
  assert.equal(h.svc.imageStopV2(), 'stopped');
  const paths = h.svc.imagePaths();
  assert.ok(paths.outDir.endsWith(path.join('media', 'pics')));
  assert.ok(paths.logFile.endsWith('imagegen.jsonl'));
});

// 1x1 GIF（合法魔数，满足 looksLikeImageBuffer）
const GIF_ONE = 'R0lGODdhCgAKAIEAAAljxwAAAAAAAAAAACwAAAAACgAKAAAIEgABCBxIsKDBgwgTKlzIsGHCgAA7';

test('resolveLocalImageFile：只允许 media/、data/pics/、data/workshop/（真实路径校验）', () => {
  const h = makeCtx();
  const pics = path.join(h.root, 'media', 'pics');
  fs.mkdirSync(pics, { recursive: true });
  const ok = path.join(pics, 'a.gif');
  fs.writeFileSync(ok, Buffer.from(GIF_ONE, 'base64'));
  const r = h.svc.resolveLocalImageFile('media/pics/a.gif');
  assert.equal(r.name, 'a.gif');
  assert.equal(r.bytes, fs.statSync(ok).size);

  const secret = path.join(h.root, 'secret.gif');
  fs.writeFileSync(secret, Buffer.from(GIF_ONE, 'base64'));
  assert.throws(() => h.svc.resolveLocalImageFile('secret.gif'), /只能发送/);
  assert.throws(() => h.svc.resolveLocalImageFile('https://x/a.gif'), /只接受本地文件路径/);
  assert.throws(() => h.svc.resolveLocalImageFile('media/pics/missing.gif'), /文件不存在/);

  fs.writeFileSync(path.join(pics, 'bad.gif'), 'not an image');
  assert.throws(() => h.svc.resolveLocalImageFile('media/pics/bad.gif'), /不是可识别的图片/);
});

test('sendImageFileV2：读到原字节并发到会话（GIF 原样，不转码）', async () => {
  const h = makeCtx();
  const pics = path.join(h.root, 'media', 'pics');
  fs.mkdirSync(pics, { recursive: true });
  const file = path.join(pics, 'meme.gif');
  const bytes = Buffer.from(GIF_ONE, 'base64');
  fs.writeFileSync(file, bytes);

  const out = await h.svc.sendImageFileV2('group:123456789', 'media/pics/meme.gif');
  assert.equal(out.messageId, 9527);
  assert.equal(out.name, 'meme.gif');
  assert.equal(out.bytes, bytes.length);
  const sent = h.state.sent.at(-1);
  assert.equal(sent.url, 'http://127.0.0.1:3000/send_group_msg');
  assert.equal(sent.body.message[0].type, 'image');
  assert.equal(sent.body.message[0].data.file, 'base64://' + bytes.toString('base64'));
});
