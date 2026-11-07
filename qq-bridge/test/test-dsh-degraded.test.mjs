// dsh-degraded 单测：错误分类 + 缓冲/重投闭环（策略 B 的离线验证）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isDshUpstreamDown, bufferDshDown, loadDshDownQueue, replayDshDownQueue, DshUpstreamDownError,
} from '../src/domain/conversation/dsh-degraded.mjs';

function tmpSdp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
  return (...p) => path.join(dir, ...p);
}

test('isDshUpstreamDown：网络/超时/5xx/429 判为不可达', () => {
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { status: 500 })), true);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { status: 503 })), true);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isDshUpstreamDown(new Error('fetch failed')), true);
  assert.equal(isDshUpstreamDown(new Error('连接被拒绝 ECONNREFUSED')), true);
});

test('isDshUpstreamDown：鉴权失败(401/403/鉴权文案) 不算不可达', () => {
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { status: 401 })), false);
  assert.equal(isDshUpstreamDown(Object.assign(new Error('x'), { status: 403 })), false);
  assert.equal(isDshUpstreamDown(new Error('DSH 鉴权失败，请检查 token')), false);
  assert.equal(isDshUpstreamDown(new Error('401 Unauthorized')), false);
  assert.equal(isDshUpstreamDown(new Error('unauthorized access')), false);
});

test('isDshUpstreamDown：普通错误/空值 保守返回 false，超时文案命中 true', () => {
  assert.equal(isDshUpstreamDown(new Error('some random error')), false);
  assert.equal(isDshUpstreamDown(null), false);
  assert.equal(isDshUpstreamDown(undefined), false);
  assert.equal(isDshUpstreamDown(new Error('请求超时，请稍后重试')), true); // 文案命中
});

test('DshUpstreamDownError 是 Error 子类且带 name/cause', () => {
  const e = new DshUpstreamDownError('boom', { cause: new Error('c') });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'DshUpstreamDownError');
  assert.equal(e.cause?.message, 'c');
});

test('buffer + load + replay 闭环（仅重投 kind:chat）', async () => {
  const sdp = tmpSdp();
  bufferDshDown({ stateDataPath: sdp, entry: { key: 'private:1', kind: 'chat', sessionId: 's1', text: 'hi' } });
  bufferDshDown({ stateDataPath: sdp, entry: { key: 'group:2', kind: 'background', sessionId: 's2', text: 'bg' } });
  let q = loadDshDownQueue({ stateDataPath: sdp });
  assert.equal(q.length, 2);
  assert.equal(q[0].status, 'pending');
  assert.equal(q[1].status, 'pending');

  let replayed = 0;
  let seenKind = null;
  await replayDshDownQueue({ stateDataPath: sdp, replayOne: (k, t, kd) => { replayed++; seenKind = kd; } });
  q = loadDshDownQueue({ stateDataPath: sdp });
  assert.equal(replayed, 1);
  assert.equal(seenKind, 'chat');
  assert.equal(q[0].status, 'replayed');
  assert.equal(q[1].status, 'skip-non-chat'); // 后台任务不误当聊天重发
});

test('replay 跳过无 key 的坏条目', () => {
  const sdp = tmpSdp();
  bufferDshDown({ stateDataPath: sdp, entry: { kind: 'chat', text: 'x' } }); // 无 key
  let q = loadDshDownQueue({ stateDataPath: sdp });
  assert.equal(q[0].status, 'pending');
  replayDshDownQueue({ stateDataPath: sdp, replayOne: () => {} });
  q = loadDshDownQueue({ stateDataPath: sdp });
  assert.equal(q[0].status, 'skip-no-key');
});
