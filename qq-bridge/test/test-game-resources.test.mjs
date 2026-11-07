// [RESOURCES] 游戏内资源账本（2026-10-30）
//
// 为什么：她进方舟只会做基建，一半原因是手里没有家底（理智/龙门币/源石），谈不上规划怎么花。
// 纪律：只收数字 + 账号标签；密码/验证码/token 类键、字符串型数值一律丢弃——凭据物理上进不来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSnapshot,
  readActivityResources,
  mergeSnapshot,
  formatNumber,
  formatAge,
  renderResourceLine,
} from '../../ai-companion-kit/packages/shared/game-resources.mjs';

test('normalizeSnapshot：只收数字，密码/验证码/token 类键与字符串值一律丢弃', () => {
  const s = normalizeSnapshot({
    account: '  示例的号  ',
    updatedAt: '2026-10-30T06:00:00.000Z',
    values: {
      理智: 205,
      龙门币: '12000', // 字符串数字也不收（只认 number，避免把凭据当数值）
      源石: 3,
      密码: 123456,
      access_token: 999,
      验证码: 8888,
      空键: NaN,
    },
  });
  assert.equal(s.account, '示例的号');
  assert.deepEqual(Object.keys(s.values).sort(), ['源石', '理智'].sort());
  assert.equal(s.values.理智, 205);
  assert.ok(!JSON.stringify(s).includes('123456'));
  assert.ok(!JSON.stringify(s).includes('999'));
});

test('normalizeSnapshot：坏输入降级为空结构', () => {
  assert.deepEqual(normalizeSnapshot(null), { account: '', updatedAt: '', values: {} });
  assert.deepEqual(normalizeSnapshot({ values: 'x' }), { account: '', updatedAt: '', values: {} });
  assert.deepEqual(normalizeSnapshot({ account: 123 }).account, '123');
});

test('formatNumber：万位与小数', () => {
  assert.equal(formatNumber(205), '205');
  assert.equal(formatNumber(9999), '9999');
  assert.equal(formatNumber(12000), '1.2 万');
  assert.equal(formatNumber(20000), '2 万');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(NaN), '?');
});

test('formatAge：相对时间与未知时间', () => {
  const now = Date.parse('2026-10-30T10:00:00.000Z');
  assert.equal(formatAge('2026-10-30T09:59:30.000Z', now), '刚才');
  assert.equal(formatAge('2026-10-30T09:30:00.000Z', now), '30 分钟前');
  assert.equal(formatAge('2026-10-30T08:00:00.000Z', now), '2 小时前');
  assert.equal(formatAge('2026-10-28T10:00:00.000Z', now), '2 天前');
  assert.equal(formatAge('', now), '');
  assert.equal(formatAge('不是时间', now), '');
  assert.equal(formatAge('2026-10-31T10:00:00.000Z', now), '刚才'); // 未来时间按"刚才"
});

test('renderResourceLine：有数值才渲染，敏感键不出现', () => {
  const now = Date.parse('2026-10-30T10:00:00.000Z');
  const line = renderResourceLine(
    { account: '示例的号', updatedAt: '2026-10-30T08:00:00.000Z', values: { 理智: 205, 龙门币: 12000, 密码: 42 } },
    now,
  );
  assert.ok(line.includes('理智 205'), line);
  assert.ok(line.includes('龙门币 1.2 万'), line);
  assert.ok(line.includes('2 小时前记的'), line);
  assert.ok(line.includes('示例的号'), line);
  assert.ok(!line.includes('密码'), line);

  assert.equal(renderResourceLine({ values: {} }, now), '');
  assert.equal(renderResourceLine(null, now), '');
});

test('readActivityResources：按活动名读；缺文件/坏 JSON/没这个活动都返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'));
  const file = path.join(dir, 'game-resources.json');
  fs.writeFileSync(file, JSON.stringify({ 明日方舟: { account: '示例的号', values: { 理智: 5 } } }), 'utf8');
  const r = readActivityResources('明日方舟', file);
  assert.equal(r.account, '示例的号');
  assert.equal(r.values.理智, 5);
  assert.equal(readActivityResources('别的游戏', file), null);
  assert.equal(readActivityResources('明日方舟', path.join(dir, 'nope.json')), null);
  fs.writeFileSync(file, '{坏', 'utf8');
  assert.equal(readActivityResources('明日方舟', file), null);
});

test('phone-mcp：打开成功后把家底拼在活动提示后面（源码接线）', () => {
  const src = fs.readFileSync(new URL('../../ai-companion-kit/packages/phone-mcp/src/phone-mcp.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from '../../shared/game-resources.mjs'"), '缺少家底模块 import');
  assert.ok(src.includes('renderResourceLine(readActivityResources(activity))'), '缺少家底渲染接线');
});

// ── 第 2 段：写入工具（qq_resources + 桥接端点）──────────────────────────────
test('mergeSnapshot：只改传进来的项，其余保留，updatedAt 自动更新', () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  const cur = { account: '示例的号', updatedAt: '2026-10-30T06:00:00.000Z', values: { 理智: 205, 龙门币: 12000 } };
  const next = mergeSnapshot(cur, { values: { 理智: 90, 源石: 3 } }, { now });
  assert.equal(next.values.理智, 90, '传了就要覆盖');
  assert.equal(next.values.龙门币, 12000, '没传的要保留');
  assert.equal(next.values.源石, 3, '新项要加上');
  assert.equal(next.account, '示例的号');
  assert.equal(next.updatedAt, '2026-10-30T12:00:00.000Z');
});

test('mergeSnapshot：补丁里的敏感键与字符串照样被丢弃', () => {
  const next = mergeSnapshot({ values: { 理智: 5 } }, { values: { 密码: 123456, 龙门币: '9999' } }, { now: 0 });
  assert.deepEqual(Object.keys(next.values), ['理智']);
  assert.ok(!JSON.stringify(next).includes('123456'));
});

test('源码：桥接端点和 qq_resources 工具都接上了', () => {
  const cs = fs.readFileSync(new URL('../src/adapters/console-server.mjs', import.meta.url), 'utf8');
  assert.ok(cs.includes("url.pathname === '/api/socialV2/game-resources'"), '缺少 game-resources 端点');
  assert.ok(cs.includes('__deps.mergeGameResources('), '端点没用纯函数合并');
  // qq_resources 工具已随二代仿真组拆到 mcp-reserved2-tools.js；源码契约需同时检索两个文件。
  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    + '\n' + fs.readFileSync(new URL('../src/mcp-reserved2-tools.js', import.meta.url), 'utf8');
  assert.ok(mcp.includes("'qq_resources'"), '缺少 qq_resources 工具');
  assert.ok(mcp.includes('/api/socialV2/game-resources'), '工具没打端点');
  assert.ok(mcp.includes('qq_resources') && mcp.includes('CORE_TOOLS'), 'CORE_TOOLS 未包含或未登记');
});
