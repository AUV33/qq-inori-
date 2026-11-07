// member-lookup-service 金标：群成员名缓存与「拍一拍目标必须是本群成员」的 fail-closed 校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberLookup } from '../src/domain/social/member-lookup-service.mjs';

function makeCtx(overrides = {}) {
  const out = { logs: [] };
  const svc = createMemberLookup({
    log: (m) => out.logs.push(String(m)),
    getBot: () => ({
      getGroupMemberList: async (gid) => {
        if (overrides.listThrows) throw new Error('网关超时');
        return overrides.members ?? [{ user_id: 1 }, { user_id: 2, card: '二号' }];
      },
      getGroupMemberInfo: async (gid, uid) => {
        if (overrides.infoThrows) throw new Error('接口没实现');
        return overrides.memberInfo?.[String(uid)] ?? { card: `成员${uid}` };
      },
    }),
    ...overrides.ctxExtra,
  });
  return { svc, out };
}

test('resolveGroupMemberName：优先精确查询单个成员，并用 card/nickname', async () => {
  const h = makeCtx({ memberInfo: { '2': { nickname: '二号昵称' } } });
  assert.equal(await h.svc.resolveGroupMemberName(100, 2), '二号昵称');
  const h2 = makeCtx({ memberInfo: { '3': { card: '三号名片' } } });
  assert.equal(await h2.svc.resolveGroupMemberName(100, 3), '三号名片');
});

test('resolveGroupMemberName：精确接口失败时回退拉整群列表建缓存', async () => {
  const h = makeCtx({ infoThrows: true, members: [{ user_id: 7, card: '七号' }] });
  assert.equal(await h.svc.resolveGroupMemberName(100, 7), '七号');
});

test('resolveGroupMemberName：整群列表也失败 → null（不编名字）', async () => {
  const h = makeCtx({ infoThrows: true, listThrows: true });
  assert.equal(await h.svc.resolveGroupMemberName(100, 7), null);
});

test('resolveGroupMemberName：查过的名字进缓存（同 key 第二次不再打网关）', async () => {
  let calls = 0;
  const h = makeCtx({
    ctxExtra: {
      getBot: () => ({
        getGroupMemberInfo: async () => { calls += 1; return { card: '缓存过的' }; },
        getGroupMemberList: async () => [],
      }),
    },
  });
  assert.equal(await h.svc.resolveGroupMemberName(100, 9), '缓存过的');
  assert.equal(await h.svc.resolveGroupMemberName(100, 9), '缓存过的');
  assert.equal(calls, 1, '第二次应命中缓存');
});

test('assertGroupMember：本群成员放行（返回 null）', async () => {
  const h = makeCtx({ members: [{ user_id: 11 }, { user_id: 12 }] });
  assert.equal(await h.svc.assertGroupMember(100, 11), null);
  assert.equal(await h.svc.assertGroupMember(100, '12'), null, '数字/字符串都认');
});

test('assertGroupMember：非本群成员拒绝（防止拿机器人探测任意 QQ）', async () => {
  const h = makeCtx({ members: [{ user_id: 11 }] });
  const msg = await h.svc.assertGroupMember(100, 999);
  assert.match(msg, /不是群 100 的成员/);
  assert.match(msg, /已拒绝拍一拍/);
});

test('assertGroupMember：拿不到成员列表时 fail-closed（宁可拍不出去）', async () => {
  const h = makeCtx({ listThrows: true });
  assert.match(await h.svc.assertGroupMember(100, 11), /无法获取群 100 的成员列表/);
});

test('assertGroupMember：成员列表为空也拒绝（无法校验）', async () => {
  const h = makeCtx({ members: [] });
  assert.match(await h.svc.assertGroupMember(100, 11), /成员列表为空/);
});

test('assertGroupMember：成员集合有缓存（60 秒内不再拉列表）', async () => {
  let calls = 0;
  const h = makeCtx({
    ctxExtra: {
      getBot: () => ({
        getGroupMemberList: async () => { calls += 1; return [{ user_id: 11 }]; },
        getGroupMemberInfo: async () => ({}),
      }),
    },
  });
  assert.equal(await h.svc.assertGroupMember(100, 11), null);
  assert.equal(await h.svc.assertGroupMember(100, 11), null);
  assert.equal(calls, 1);
});
