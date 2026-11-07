// send-ledger 金标：跨重启的发送幂等账本——tool→auto/tool→tool 10 分钟内挡，auto→auto 永不挡。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ledger-'));
  process.env.SEND_LEDGER_FILE = path.join(dir, 'send-ledger.json');
  const mod = await import(`../src/domain/send/send-ledger.js?t=${Date.now()}-${Math.random()}`);
  mod._resetCache();
  return { mod, file: process.env.SEND_LEDGER_FILE };
}

test('normalize：抹掉空白、markdown 记号与标点，让工具原文与自动转发能对上', async () => {
  const { mod } = await freshLedger();
  assert.equal(mod.normalize(' 你好，**世界**！ '), '你好世界');
  assert.equal(mod.normalize('`code` #tag > quote'), 'codetagquote', '空白也被抹掉（工具原文与自动转发才对得上）');
  assert.equal(mod.normalize(null), '');
});

test('fingerprint：同 key 同文本稳定，key 不同则不同', async () => {
  const { mod } = await freshLedger();
  const a = mod.fingerprint('group:1', '你好');
  assert.equal(a, mod.fingerprint('group:1', '你好 '));
  assert.notEqual(a, mod.fingerprint('group:2', '你好'));
  assert.equal(a.length, 16);
});

test('tool→auto：10 分钟内同一句 auto 让路（重复回复的主因）', async () => {
  const { mod } = await freshLedger();
  const now = Date.now();
  mod.note('group:1', '同一句话', 'tool', now);
  assert.equal(mod.shouldSkip('group:1', '同一句话', 'auto', now + 1000), true);
  assert.equal(mod.shouldSkip('group:1', '同一句话', 'auto', now + mod.TOOL_WINDOW_MS + 1), false, '过了 10 分钟不再挡');
});

test('tool→tool：10 分钟内第二次不发（重启后的重试）', async () => {
  const { mod } = await freshLedger();
  const now = Date.now();
  mod.note('group:1', '工具发过', 'tool', now);
  assert.equal(mod.shouldSkip('group:1', '工具发过', 'tool', now + 1000), true);
});

test('auto→auto：永不拦截（她想重复说一句「嗯」是自由，不是 bug）', async () => {
  const { mod } = await freshLedger();
  const now = Date.now();
  mod.note('group:1', '嗯', 'auto', now);
  assert.equal(mod.shouldSkip('group:1', '嗯', 'auto', now + 1000), false);
});

test('账本落盘并按 TTL 剪枝；空文本不记账也不拦', async () => {
  const { mod, file } = await freshLedger();
  const now = Date.now();
  mod.note('group:1', '老的', 'tool', now - mod.TTL_MS - 1000);
  mod.note('group:1', '新的', 'tool', now);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.items.map((e) => e.k), ['group:1']);

  mod.note('group:1', '', 'tool', now);
  assert.equal(mod.shouldSkip('group:1', '', 'auto', now), false);
});

test('读写失败就当没有账本（宁可重复也不能哑火）', async () => {
  const { mod } = await freshLedger();
  const now = Date.now();
  assert.equal(mod.shouldSkip('group:1', '从没记过', 'auto', now), false);
});
