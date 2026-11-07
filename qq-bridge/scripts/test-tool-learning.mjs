import { readBridgeSource } from './lib/bridge-source.mjs';
// test-tool-learning.mjs · 工具→学习自动闭环的接线锁 + recordResult 语义
import assert from 'node:assert';
import fs from 'node:fs';
import { recordResult, load as loadSkills } from '../src/domain/leaves/inori-skills.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const src = readBridgeSource();

check('桥接接了 [TOOL-LEARN]（回合结束自动记账）', () => {
  assert.ok(src.includes('[TOOL-LEARN]'), '没有 [TOOL-LEARN] 标记');
  assert.ok(src.includes('applyTurnToolLearning('), '没有 applyTurnToolLearning');
  assert.ok(src.includes('turnToolStats'), '没有回合工具统计');
});

check('回合完成不再冒充 success trace（只在有证据时显式写）', () => {
  assert.ok(src.includes('[TRACE-TRUTH]'), '缺少 TRACE-TRUTH 标记');
  assert.ok(!src.includes('桥接自动打点（回合完成）'), '旧的假成功文案还在');
  assert.ok(src.includes('任务证据：'), '缺少“任务证据”显式成功轨迹');
});

check('技能成败自动记（她不用手动 skill_record）', () => {
  assert.ok(src.includes('applyOutcome'), '没有 recordSkillOutcome');
  assert.ok(src.includes('自动记了'), '没有自动记账日志');
  assert.ok(src.includes('$skillIds'), '没有注入技能 id 记录');
});

check('recordResult：成功/失败分别计数，连续失败只降级不删除', () => {
  const store = { items: [{ id: 's1', name: 'x', success: 0, fail: 0, retired: false }, { id: 's2', name: 'y', success: 0, fail: 0, retired: false }] };
  const a = recordResult(store, 's1', true);
  assert.strictEqual(a.success, 1);
  assert.strictEqual(a.lastOk, true);
  const b = recordResult(store, 's2', false);
  assert.strictEqual(b.fail, 1);
  assert.strictEqual(b.lastOk, false);
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
