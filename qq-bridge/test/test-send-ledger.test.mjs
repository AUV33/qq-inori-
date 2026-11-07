// 发送幂等账本的单测：跨重启去重的三条规则必须成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-ledger-'));
process.env.SEND_LEDGER_FILE = path.join(dir, 'ledger.json');
const ledger = await import('../src/domain/send/send-ledger.js');

const KEY = 'private:10001';
const T0 = 1_800_000_000_000;

test('tool 发过之后，auto 在 10 分钟内让路（重复回复的主因）', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '我去看看', 'tool', T0);
  assert.equal(ledger.shouldSkip(KEY, '我去看看', 'auto', T0 + 1000), true);
  assert.equal(ledger.shouldSkip(KEY, '我去看看', 'auto', T0 + 11 * 60 * 1000), false);
});

test('auto→auto 永不拦截：她想重复说一句是自由', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '嗯', 'auto', T0);
  assert.equal(ledger.shouldSkip(KEY, '嗯', 'auto', T0 + 500), false);
});

test('tool→tool 10 分钟内挡第二次（重启后重试）', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '好', 'tool', T0);
  assert.equal(ledger.shouldSkip(KEY, '好', 'tool', T0 + 5000), true);
});

test('auto 发过之后，tool 不被挡（规则表只声明 tool→auto / tool→tool）', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '嗯', 'auto', T0);
  assert.equal(ledger.shouldSkip(KEY, '嗯', 'tool', T0 + 500), false);
});

test('归一化：markdown 与空白差异算同一句', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '**好的**，我去', 'tool', T0);
  assert.equal(ledger.shouldSkip(KEY, '好的, 我去', 'auto', T0 + 100), true);
});

test('不同会话/不同内容不误伤', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '晚安', 'tool', T0);
  assert.equal(ledger.shouldSkip('group:20002', '晚安', 'auto', T0 + 100), false);
  assert.equal(ledger.shouldSkip(KEY, '早安', 'auto', T0 + 100), false);
});

test('落盘可跨进程重启读回', () => {
  ledger._resetCache();
  fs.rmSync(process.env.SEND_LEDGER_FILE, { force: true });
  ledger.note(KEY, '记一下', 'tool', T0);
  ledger._resetCache(); // 模拟桥接重启后从磁盘重读
  assert.equal(ledger.shouldSkip(KEY, '记一下', 'auto', T0 + 60_000), true);
});

test('账本文件损坏时不挡发送', () => {
  ledger._resetCache();
  fs.writeFileSync(process.env.SEND_LEDGER_FILE, '{not json', 'utf8');
  assert.equal(ledger.shouldSkip(KEY, '随便', 'auto', T0), false);
});
