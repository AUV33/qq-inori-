import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFreedomPolicy, classifyTrust, formatFreedomLog, renderFreedomPermission } from '../src/domain/leaves/inori-freedom.js';

const cfg = {
  ownerQQ: '10001',
  socialV2: { enabled: true, paused: false, wake: { maxWakePerHour: 2 }, tools: { groupAdmin: false } },
  ownLife: { enabled: true, maxPerDay: 3 },
};
const now = 1_800_000_000_000;

test('trust 分类：owner / group / private / isolated', () => {
  assert.equal(classifyTrust('private:10001', '10001'), 'owner');
  assert.equal(classifyTrust('private:9', '10001'), 'private');
  assert.equal(classifyTrust('group:123#owner', '10001'), 'group');
  assert.equal(classifyTrust('isolated:ownlife', '10001'), 'isolated');
  assert.equal(classifyTrust('task:abc', '10001'), 'isolated');
});

test('群会话：可回但不可自改/管群；主动开口受预算限制', () => {
  const p = buildFreedomPolicy({
    key: 'group:123', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg,
    state: { wakeTimes: [now - 1000, now - 2000] }, now,
  });
  assert.equal(p.trust, 'group');
  assert.equal(p.reply.can, true);
  assert.deepEqual(p.reply.options, ['reply', 'wait', 'silence']);
  assert.equal(p.initiate.can, false);
  assert.equal(p.initiate.remaining, 0);
  assert.equal(p.selfEdit.can, false);
  assert.equal(p.manageGroup.can, false);
  assert.equal(p.explore.can, false);
});

test('owner 私聊：可自改；groupAdmin 关闭时仍不可管群', () => {
  const p = buildFreedomPolicy({ key: 'private:10001', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg, state: {}, now });
  assert.equal(p.trust, 'owner');
  assert.equal(p.selfEdit.can, true);
  assert.equal(p.manageGroup.can, false, '默认关闭 groupAdmin 时不能管群');
  assert.equal(p.reply.can, true);
});

test('隔离会话：不能发消息/主动开口，但自己的时间可以选活动', () => {
  const p = buildFreedomPolicy({ key: 'isolated:ownlife', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg, state: { ownLifeCount: 1 }, now });
  assert.equal(p.reply.can, false);
  assert.equal(p.initiate.can, false);
  assert.equal(p.explore.can, true);
  assert.equal(p.explore.budgetLeft, 2);
});

test('许可句只给选择，不给命令', () => {
  const p = buildFreedomPolicy({ key: 'private:10001', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg, state: {}, now });
  const line = renderFreedomPermission(p);
  assert.match(line, /^【你现在可以】/);
  assert.match(line, /回、等、沉默都可以/);
  assert.doesNotMatch(line, /必须|直接回|不准/);
});

test('maxWakePerHour=0 表示不设上限，不把人锁死', () => {
  const c = { ...cfg, socialV2: { ...cfg.socialV2, wake: { maxWakePerHour: 0 } } };
  const p = buildFreedomPolicy({ key: 'group:1', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg: c, state: {}, now });
  assert.equal(p.initiate.can, true);
  assert.ok(p.initiate.remaining > 0);
});

test('maxPerDay=0 表示不设每日上限（不能被 || 6 吞成 6 次）', () => {
  // 实锤：live config 写的是 ownLife.maxPerDay=0（意图"不限"），旧代码 Number(0) || 6 ⇒ 6 次/天。
  const c = { ...cfg, ownLife: { ...cfg.ownLife, maxPerDay: 0 } };
  const p = buildFreedomPolicy({ key: 'isolated:ownlife', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg: c, state: { ownLifeCount: 99 }, now });
  assert.equal(p.explore.can, true, '用超了也不该被关掉：0 = 不限');
  assert.equal(p.explore.unlimited, true);
  assert.equal(p.explore.budgetLeft, null);
  const line = renderFreedomPermission(p);
  assert.match(line, /自己的时间不限量/);
  assert.doesNotMatch(line, /还能选/);
});

test('maxPerDay 未配置回落默认 6；负数按 0 次处理', () => {
  const c1 = { ...cfg, ownLife: { enabled: true } };
  const p1 = buildFreedomPolicy({ key: 'isolated:ownlife', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg: c1, state: { ownLifeCount: 5 }, now });
  assert.equal(p1.explore.unlimited, false);
  assert.equal(p1.explore.budgetLeft, 1);
  const c2 = { ...cfg, ownLife: { enabled: true, maxPerDay: -3 } };
  const p2 = buildFreedomPolicy({ key: 'isolated:ownlife', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg: c2, state: {}, now });
  assert.equal(p2.explore.can, false);
  assert.equal(p2.explore.budgetLeft, 0);
});

test('日志是固定字段，便于 grep 哨兵', () => {
  const p = buildFreedomPolicy({ key: 'group:123', mode: 'reserved2', ownerQQ: cfg.ownerQQ, cfg, state: {}, now });
  const line = formatFreedomLog(p);
  assert.match(line, /^\[freedom\] group:123 trust=group reply=true/);
  assert.match(line, /selfEdit=false manageGroup=false/);
});
