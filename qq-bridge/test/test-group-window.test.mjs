// group-window 金标：只读 token 的生成/校验、群窗清单的过滤与排序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupWindow } from '../src/domain/social/group-window.mjs';

function makeCtx(conversations = {}) {
  const states = new Map();
  const conv = new Map(Object.entries(conversations));
  let saves = 0;
  const svc = createGroupWindow({
    getSocialV2State: (key) => {
      if (!states.has(key)) states.set(key, { ...(conversations[key] ?? {}) });
      return states.get(key);
    },
    saveSocialV2State: () => { saves += 1; },
    getSocialV2: () => ({ conversations: conv }),
    isSessionAllowedInCurrentMode: (key) => !String(key).includes('blocked'),
  });
  return { svc, states, saves: () => saves, conv };
}

test('readTokenFor：首次生成 36 位 hex，之后稳定复用，只落盘一次', () => {
  const h = makeCtx({ 'group:1': { unread: [] } });
  const t1 = h.svc.readTokenFor('group:1');
  const t2 = h.svc.readTokenFor('group:1');
  assert.match(t1, /^[0-9a-f]{36}$/);
  assert.equal(t1, t2);
  assert.equal(h.saves(), 1, '已经有 token 就不该重复落盘');
});

test('readTokenOkMain：只用 timingSafeEqual 比对本会话 token', () => {
  const h = makeCtx({ 'group:1': {}, 'group:2': {} });
  const t1 = h.svc.readTokenFor('group:1');
  h.svc.readTokenFor('group:2');
  assert.equal(h.svc.readTokenOkMain('group:1', t1), true);
  assert.equal(h.svc.readTokenOkMain('group:1', `${t1}x`), false);
  assert.equal(h.svc.readTokenOkMain('group:1', ''), false);
  assert.equal(h.svc.readTokenOkMain('group:2', t1), false, '跨群 token 不认');
  assert.equal(h.svc.readTokenOkMain('group:3', t1), false, '没有会话状态的 key 返回 false');
});

test('groupReadWindowText：只列允许的群、按最近活跃排序、最多 3 个、带 token', () => {
  const h = makeCtx({
    'group:1': { unread: [1, 2], lastIncomingAt: 300 },
    'group:2': { unread: [], lastIncomingAt: 100 },
    'group:3': { unread: [1], lastIncomingAt: 200 },
    'group:4': { unread: [], lastIncomingAt: 400 },
    'group:blocked': { unread: [], lastIncomingAt: 999 },
    'private:9': { unread: [], lastIncomingAt: 500 },
  });
  const text = h.svc.groupReadWindowText();
  const lines = text.split('\n');
  assert.ok(text.includes('【你自己的群窗（只读）】'));
  const listed = lines.filter((l) => l.startsWith('- group:'));
  assert.deepEqual(listed.map((l) => l.split('（')[0]), ['- group:4', '- group:1', '- group:3']);
  assert.equal(listed.length, 3, '最多列 3 个群');
  assert.ok(listed[1].includes('未读 2 条'));
  assert.ok(listed.every((l) => /token=[0-9a-f]{36}/.test(l)));
  assert.ok(!text.includes('group:blocked'), '当前模式不允许的群不能出现');
  assert.ok(!text.includes('private:9'), '私聊不是群窗');
});

test('groupReadWindowText：没有可用群时返回空串（调用方据此不加提示块）', () => {
  const h = makeCtx({ 'private:1': { unread: [] } });
  assert.equal(h.svc.groupReadWindowText(), '');
});
