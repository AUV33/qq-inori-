import test from 'node:test';
import assert from 'node:assert/strict';
import { createSendGuard, shouldBlockSilentReply } from '../src/domain/send/send-guard.mjs';

test('守卫：一切没变时放行', () => {
  const guard = createSendGuard({
    key: 'group:1', policy: 'reserved2', sessionId: 's1',
    isAllowed: () => true, policyNow: () => 'reserved2', sessionNow: () => 's1',
  });
  assert.doesNotThrow(() => guard());
});

test('守卫：会话被移出白名单 → 取消发送', () => {
  let allowed = true;
  const guard = createSendGuard({
    key: 'group:1', policy: 'reserved2', sessionId: 's1',
    isAllowed: () => allowed, policyNow: () => 'reserved2', sessionNow: () => 's1',
  });
  allowed = false;
  assert.throws(() => guard(), /发送已取消/);
});

test('守卫：模式在发送前被切走 → 取消发送', () => {
  let policy = 'reserved2';
  const guard = createSendGuard({
    key: 'group:1', policy: 'reserved2', sessionId: 's1',
    isAllowed: () => true, policyNow: () => policy, sessionNow: () => 's1',
  });
  policy = 'chat';
  assert.throws(() => guard(), /模式/);
});

test('守卫：DSH 会话被轮换 → 取消发送', () => {
  let sid = 's1';
  const guard = createSendGuard({
    key: 'group:1', policy: 'reserved2', sessionId: 's1',
    isAllowed: () => true, policyNow: () => 'reserved2', sessionNow: () => sid,
  });
  sid = 's2';
  assert.throws(() => guard(), /会话/);
});

test('守卫：捕获时还没建会话（sessionId 空）→ 不因会话变化取消', () => {
  let sid = 's9';
  const guard = createSendGuard({
    key: 'group:1', policy: 'reserved2', sessionId: '',
    isAllowed: () => true, policyNow: () => 'reserved2', sessionNow: () => sid,
  });
  sid = 's10';
  assert.doesNotThrow(() => guard());
});

test('静默模式：只放行主人私聊', () => {
  const args = { mode: 'silent', ownerQQ: 10001 };
  assert.equal(shouldBlockSilentReply('private:10001', args), false);
  assert.equal(shouldBlockSilentReply('private:999', args), true);
  assert.equal(shouldBlockSilentReply('group:1', args), true);
});

test('非静默模式：一律不拦', () => {
  assert.equal(shouldBlockSilentReply('group:1', { mode: 'chat', ownerQQ: 1 }), false);
});
