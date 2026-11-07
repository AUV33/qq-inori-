import { readBridgeSource } from './lib/bridge-source.mjs';
// test-group-facts-llm.mjs · 群事实 JSON 解析 + bridge 接线
import assert from 'node:assert';
import fs from 'node:fs';
import { parseFactsJson } from '../src/domain/leaves/inori-group-facts.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const bridge = readBridgeSource();

check('parseFactsJson：纯数组', () => {
  assert.deepEqual(parseFactsJson('["他答应下周一买显卡","群友约了周六打球"]'), ['他答应下周一买显卡', '群友约了周六打球']);
});

check('parseFactsJson：带解释/代码块也能抠出来', () => {
  const out = parseFactsJson('好的，结果如下：\n```json\n["他喜欢喝冰美式"]\n```');
  assert.deepEqual(out, ['他喜欢喝冰美式']);
});

check('parseFactsJson：过滤太短/太长/非字符串/重复，并限 max', () => {
  const out = parseFactsJson('["短","这是一条足够长的事实描述","这是一条足够长的事实描述",123,"'+ '很'.repeat(120) + '"]', { max: 3 });
  assert.deepEqual(out, ['这是一条足够长的事实描述']);
});

check('parseFactsJson：坏 JSON 返回空数组', () => {
  assert.deepEqual(parseFactsJson('没有数组'), []);
  assert.deepEqual(parseFactsJson('[not json'), []);
});

check('bridge 接线：6h 节流、写入 group-fact、只输出 JSON 的 prompt', () => {
  assert.ok(bridge.includes('[GROUP-FACTS-LLM]'), '缺标记');
  assert.ok(bridge.includes('appendGroupFactsLlm'), '缺调用');
  assert.ok(bridge.includes("kind: 'group-fact'"), '没写 group-fact');
  assert.ok(bridge.includes('只输出 JSON 数组'), 'prompt 没限制 JSON');
  assert.ok(bridge.includes("theme: '群事实'"), 'theme 不对');
});

check('并发保护：跨群抽取串行，并绑定调度槽位到 groupfact 会话', () => {
  assert.ok(bridge.includes('let groupFactQueue = Promise.resolve()'), '缺少串行队列');
  assert.ok(bridge.includes('groupFactQueue.then('), '群事实任务未进入串行队列');
  assert.ok(bridge.includes("acquireTurnSlot('isolated:groupfact'"), '未接入并发调度器');
  assert.ok(bridge.includes('bindTurnGrant(turnGrant, sessionId)'), '槽位没有绑定到会话');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
