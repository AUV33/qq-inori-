import { readBridgeSource } from './lib/bridge-source.mjs';
// test-failure-reflect.mjs · 失败反思层：能力/策略归因 + 解决追踪 + 带建议的摘要
import assert from 'node:assert';
import fs from 'node:fs';
import { explainFailure, resolveFailure, renderReflectDigest } from '../src/domain/leaves/inori-failure-reflect.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('归因：环境（禁言/网络/限流）', () => {
  assert.equal(explainFailure('result=120 禁言').kind, 'environment');
  assert.equal(explainFailure('fetch failed ETIMEDOUT').kind, 'environment');
  assert.equal(explainFailure('429 限流').kind, 'environment');
});

check('归因：策略（参数/路径）', () => {
  assert.equal(explainFailure('throughSeq 必须是非负安全整数').kind, 'strategy');
  assert.equal(explainFailure('ENOENT no such file').kind, 'strategy');
  assert.match(explainFailure('throughSeq 必须是').fix, /先读状态|顺序/);
});

check('归因：能力（权限/配置/模型端）', () => {
  assert.equal(explainFailure('403 token 无效').kind, 'capability');
  assert.equal(explainFailure('invalid config: missing required').kind, 'capability');
  assert.equal(explainFailure('Messages request failed (400)').kind, 'capability');
});

check('归因：每条都给"可以怎么试"', () => {
  for (const text of ['禁言', 'ETIMEDOUT', '403', 'ENOENT', 'invalid config', '瞎写']) {
    assert.ok(explainFailure(text).fix && explainFailure(text).fix.length > 4, text);
  }
});

check('解决追踪：3 分钟内同工具成功 → resolved，带耗时', () => {
  const log = { events: [{ at: 1000, key: 'k', tool: 't', cause: 'network' }] };
  assert.equal(resolveFailure(log, { key: 'k', tool: 't', at: 30_000 }), log.events[0]);
  assert.equal(log.events[0].resolved, true);
  assert.equal(log.events[0].tookMs, 29_000);
});

check('解决追踪：超窗口/不同工具不误标', () => {
  const log = { events: [{ at: 0, key: 'k', tool: 't', cause: 'network' }] };
  assert.equal(resolveFailure(log, { key: 'k', tool: 't', at: 999_999 }), null);
  assert.equal(resolveFailure(log, { key: 'k', tool: 'other', at: 1000 }), null);
});

check('摘要：带归因说明、建议、已解决数；空日志返回空', () => {
  const now = 10_000_000;
  const log = { events: [
    { at: now - 1000, key: 'k', tool: 'web_search', cause: 'network', text: 'ETIMEDOUT' },
    { at: now - 2000, key: 'k', tool: 'web_search', cause: 'network', text: 'ETIMEDOUT', resolved: true, tookMs: 5000 },
  ] };
  const line = renderReflectDigest(log, { now });
  assert.match(line, /失败 2 次/);
  assert.match(line, /环境/);
  assert.match(line, /可以这样试/);
  assert.match(line, /已解决 1/);
  assert.equal(renderReflectDigest({ events: [] }, { now }), '');
});

const bridge = readBridgeSource();
check('bridge 接线：反思模块 + 解决追踪 2 处 + 摘要替换', () => {
  assert.ok(bridge.includes("from './inori-failure-reflect.js'"), '没导入');
  assert.ok((bridge.match(/resolveToolFailure\(/g) || []).length >= 3, '解决追踪点不够');
  assert.ok(bridge.includes('renderReflectDigest(loadFailures()'), '摘要没替换成带建议版');
  assert.ok(bridge.includes('explainFailure(errorText)'), '日志没带归因类型');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
