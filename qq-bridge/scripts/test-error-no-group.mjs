import { readBridgeSource } from './lib/bridge-source.mjs';
// test-error-no-group.mjs · 报错/提示类消息不投递到群里（静态接线锁）
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const src = readBridgeSource();

check('sendNotice 存在且群会话只记日志', () => {
  assert.ok(src.includes('[ERR-NO-GROUP]'), '没有 [ERR-NO-GROUP]');
  assert.ok(src.includes('function sendNotice(key, text)'), '没有 sendNotice');
  assert.ok(src.includes('[notice-suppressed]'), '没有抑制日志标记');
});

check('报错/提示类文案全部改走 sendNotice', () => {
  const needles = [
    "sendNotice(key, '⚠️ 本条回复因疑似包含敏感信息",
    'sendNotice(key, `⚠️ 消息未被接受',
    'sendNotice(key, `⚠️ agent 处理出错',
    "sendNotice(key, '⏳ 系统服务重启中",
    "sendNotice(key, '⚠️ 回答提交失败",
    "sendNotice(key, '⚠️ 审批回执提交失败",
    "sendNotice(key, '⏰ 等待回答超时",
  ];
  for (const s of needles) assert.ok(src.includes(s), `没有改走 sendNotice：${s}`);
});

check('同一批文案没有残留 sendToQQ 直发', () => {
  const bad = [
    'sendToQQ(key, `⚠️ 消息未被接受',
    'sendToQQ(key, `⚠️ agent 处理出错',
    "sendToQQ(key, '⏳ 系统服务重启中",
    "sendToQQ(key, '⚠️ 回答提交失败",
    "sendToQQ(key, '⚠️ 审批回执提交失败",
    "sendToQQ(key, '⏰ 等待回答超时",
    "sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息",
  ];
  for (const s of bad) assert.ok(!src.includes(s), `仍有 sendToQQ 直发：${s}`);
});

check('sendNotice 调用至少 8 处', () => {
  const cnt = (src.match(/sendNotice\(/g) || []).length;
  assert.ok(cnt >= 8, `sendNotice 只有 ${cnt} 处`);
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
