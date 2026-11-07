import { readBridgeSource } from './lib/bridge-source.mjs';
// test-failure-digest.mjs · 失败原因实时归纳：分类 / 去重 / 聚合 / 唤醒接线
import assert from 'node:assert';
import fs from 'node:fs';
import { classifyFailure, noteFailure, summarizeFailures, renderFailureDigest } from '../src/domain/leaves/inori-failures.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('分类：禁言 / 网络 / 模型 400 / 权限 / 限流 / 不存在 / 设备 / 配置 / 其他', () => {
  assert.equal(classifyFailure('result=120 被禁言').key, 'mute');
  assert.equal(classifyFailure('fetch failed: ETIMEDOUT').key, 'network');
  assert.equal(classifyFailure('Messages request failed (400)').key, 'model');
  assert.equal(classifyFailure('403 agent token 无效').key, 'auth');
  assert.equal(classifyFailure('429 限流').key, 'rate');
  assert.equal(classifyFailure('ENOENT no such file').key, 'missing');
  assert.equal(classifyFailure('throughSeq 必须是不超过已展示水位的非负安全整数').key, 'validation');
  assert.equal(classifyFailure('adb: no devices').key, 'device');
  assert.equal(classifyFailure('invalid config: missing required value').key, 'config');
  assert.equal(classifyFailure('随便什么别的错误').key, 'unknown');
});

check('noteFailure：同一工具同一原因 60 秒内只记一次', () => {
  const log = { events: [] };
  noteFailure(log, { at: 1000, tool: 'web_search', text: 'ETIMEDOUT' });
  noteFailure(log, { at: 2000, tool: 'web_search', text: 'ETIMEDOUT' });
  assert.equal(log.events.length, 1);
  noteFailure(log, { at: 3000, tool: 'web_search', text: '403' });
  assert.equal(log.events.length, 2);
});

check('noteFailure：上限 300 条，且保留最新', () => {
  const log = { events: [] };
  for (let i = 0; i < 305; i += 1) noteFailure(log, { at: i * 1000, tool: 't' + i, text: 'boom unknown' });
  assert.equal(log.events.length, 300);
  assert.equal(log.events[log.events.length - 1].tool, 't304');
});

check('summarize：只算窗口内，按次数降序', () => {
  const now = 10_000_000;
  const log = { events: [
    { at: now - 1000, tool: 'a', cause: 'network' },
    { at: now - 2000, tool: 'a', cause: 'network' },
    { at: now - 3000, tool: 'b', cause: 'mute' },
    { at: now - 50 * 60_000, tool: 'c', cause: 'model' },
  ] };
  const s = summarizeFailures(log, { now, windowMs: 30 * 60_000 });
  assert.equal(s.total, 3);
  assert.equal(s.causes[0].key, 'network');
  assert.equal(s.causes[0].n, 2);
  assert.equal(s.tools[0].tool, 'a');
});

check('render：一句话摘要含次数与原因；没失败返回空', () => {
  const now = 10_000_000;
  const log = { events: [{ at: now - 1000, tool: 'web_search', cause: 'network', text: 'fetch failed' }] };
  const line = renderFailureDigest(log, { now });
  assert.match(line, /最近 30 分钟失败 1 次/);
  assert.match(line, /网络/);
  assert.equal(renderFailureDigest({ events: [] }, { now }), '');
});

const bridge = readBridgeSource();

check('bridge 接线：失败记账 2 处 + 唤醒摘要', () => {
  assert.ok(bridge.includes("from './inori-failures.js'"), '没导入');
  assert.ok((bridge.match(/noteToolFailure\(/g) || []).length >= 3, '记账点不够（定义+两处调用）');
  assert.ok(bridge.includes('wakeFailureLine'), '没有唤醒行');
  // [PARTS-ARRAY] wake-prompt 改成 parts 数组拼装了；契约不变：failureLine 仍排在 encounterLine 后面进基底。
  assert.match(bridge, /encounterLine,\s*\n?\s*failureLine,/, '摘要没拼进唤醒');
  assert.ok(bridge.includes('20 * 60_000'), '没有节流');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
