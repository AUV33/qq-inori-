// snowluma-watchdog-service 金标：断线计数、10 分钟只拉一次、最近有心跳就不拉、脚本路径必须绝对，缺失时优雅跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSnowLumaWatchdog } from '../src/adapters/snowluma-watchdog-service.mjs';

function makeCtx(overrides = {}) {
  const out = { logs: [], spawned: [], unref: 0 };
  const fakePath = path.resolve(process.cwd(), 'src');
  const svc = createSnowLumaWatchdog({
    fs: { existsSync: () => overrides.vbsExists ?? true },
    path: { resolve: (...parts) => path.win32.resolve(...parts) },
    __dirname: fakePath,
    spawn: (cmd, args, opts) => {
      out.spawned.push({ cmd, args, opts });
      if (overrides.spawnThrows) throw new Error('wscript 不在 PATH');
      return { unref: () => { out.unref += 1; } };
    },
    log: (m) => out.logs.push(String(m)),
    ...overrides.ctxExtra,
  });
  return { svc, out };
}

test('noteClose 累计断线次数，noteOpen 归零', () => {
  const h = makeCtx();
  assert.equal(h.svc.noteClose(), 1);
  assert.equal(h.svc.noteClose(), 2);
  h.svc.noteOpen();
  assert.equal(h.svc.noteClose(), 1);
});

test('watchdog：刚有心跳（<3 分钟）不拉起', () => {
  const h = makeCtx();
  h.svc.watchdogSnowLuma('测试');
  assert.equal(h.out.spawned.length, 0);
});

test('watchdog：静默超过 3 分钟且没拉过 → 用绝对路径拉起 wscript，且 unref', () => {
  const h = makeCtx();
  // 把「上次正常」推到 5 分钟前
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60 * 1000;
  try {
    h.svc.watchdogSnowLuma('连续断线');
  } finally {
    Date.now = realNow;
  }
  assert.equal(h.out.spawned.length, 1);
  const call = h.out.spawned[0];
  assert.equal(call.cmd, 'wscript');
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.stdio, 'ignore');
  assert.ok(path.win32.isAbsolute(call.args[1]), '必须是绝对路径（相对路径会让 wscript 弹找不到文件的模态框）');
  assert.ok(call.args[1].endsWith('silent-snowluma.vbs'));
  assert.equal(h.out.unref, 1);
  assert.ok(h.out.logs.some((l) => l.includes('已尝试拉起 SnowLuma')));
});

test('watchdog：10 分钟内只拉一次（防反复弹窗/反复启动）', () => {
  const h = makeCtx();
  const realNow = Date.now;
  let offset = 5 * 60 * 1000;
  Date.now = () => realNow() + offset;
  try {
    h.svc.watchdogSnowLuma('第一次');
    offset = 6 * 60 * 1000; // 只过了 1 分钟
    h.svc.watchdogSnowLuma('第二次');
    assert.equal(h.out.spawned.length, 1, '10 分钟内不重复拉');
    offset = 16 * 60 * 1000;
    h.svc.watchdogSnowLuma('第三次');
    assert.equal(h.out.spawned.length, 2, '超过 10 分钟才允许再拉');
  } finally {
    Date.now = realNow;
  }
});

test('watchdog：脚本不存在就跳过并说明，不弹脚本错误框', () => {
  const h = makeCtx({ vbsExists: false });
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60 * 1000;
  try {
    h.svc.watchdogSnowLuma('连续断线');
  } finally {
    Date.now = realNow;
  }
  assert.equal(h.out.spawned.length, 0);
  assert.ok(h.out.logs.some((l) => l.includes('找不到') && l.includes('跳过拉起')));
});

test('watchdog：spawn 抛错只记日志', () => {
  const h = makeCtx({ spawnThrows: true });
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60 * 1000;
  try {
    assert.doesNotThrow(() => h.svc.watchdogSnowLuma('连续断线'));
  } finally {
    Date.now = realNow;
  }
  assert.ok(h.out.logs.some((l) => l.includes('拉起失败')));
});

test('silent-snowluma.vbs 路径推导稳定，且文件缺失时可降级（本机私有启动器，可不入库）', () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const vbs = path.resolve(here, '..', '..', 'silent-snowluma.vbs');
  // VBS 含作者本机绝对路径，被 .gitignore 排除：公开仓库克隆后不存在是预期的，
  // 不能再断言「文件必须存在」，否则 npm test 在干净克隆上必挂。改为验证两件与部署形态无关的事：
  assert.ok(path.win32.isAbsolute(vbs), '推导出的路径必须是绝对路径');
  assert.ok(vbs.endsWith('silent-snowluma.vbs'), '__dirname 层级漂移会改掉文件名/目录');
  // ① 存在时：推导出的是绝对路径，且确实走 wscript（上面的金标已覆盖）
  // ② 缺失时：优雅跳过、不 spawn wscript（避免反复弹「找不到脚本」模态框）
  assert.doesNotThrow(() => {
    const h = makeCtx({ vbsExists: false });
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60 * 1000;
    try { h.svc.watchdogSnowLuma('缺失降级校验'); } finally { Date.now = realNow; }
    assert.equal(h.out.spawned.length, 0, 'VBS 缺失时不能拉起');
    assert.ok(h.out.logs.some((l) => l.includes('跳过拉起')));
  });
});
