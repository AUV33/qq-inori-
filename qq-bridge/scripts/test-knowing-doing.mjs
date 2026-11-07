import { readBridgeSource } from './lib/bridge-source.mjs';
// test-knowing-doing.mjs · 知道→做到：注入计数 + 可执行判据 + skill_verify 接线
import assert from 'node:assert';
import fs from 'node:fs';
import { load, save, noteInjected, recordResult } from '../src/domain/leaves/inori-skills.js';
import { checkVerify } from '../src/domain/leaves/inori-skill-verify.js';
import { pickPracticeSlots, renderPracticeSlots } from '../src/domain/social/practice-slot.mjs';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };
const checkAsync = async (n, f) => { try { await f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('noteInjected：注入次数与成败分开记', () => {
  const store = { version: 1, items: [{ id: 's1', name: 'x', success: 0, fail: 0, injected: 2 }] };
  noteInjected(store, 's1');
  assert.equal(store.items[0].injected, 3);
  assert.ok(store.items[0].lastInjectedAt > 0);
  recordResult(store, 's1', true);
  assert.equal(store.items[0].success, 1);
  assert.equal(store.items[0].injected, 3);
});

check('noteInjected 找不到 id 不炸', () => {
  const store = { version: 1, items: [] };
  assert.equal(noteInjected(store, 'nope'), null);
});

await checkAsync('命令判据：默认不执行，显式 allowCommand 才跑', async () => {
  const dry = await checkVerify('命令:exit 0');
  assert.equal(dry.ok, null);
  const ok = await checkVerify('命令:exit 0', { allowCommand: true });
  assert.equal(ok.ok, true);
  const bad = await checkVerify('命令:exit 1', { allowCommand: true });
  assert.equal(bad.ok, false);
});

const mcp = fs.readFileSync(`${PROJECT_ROOT}/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js`, 'utf8');
const bridge = readBridgeSource();

check('memory-mcp 注册 skill_verify，并显示注入次数', () => {
  assert.ok(mcp.includes("'skill_verify'"), '没有 skill_verify');
  assert.ok(mcp.includes('allowCommand: true'), '没有显式允许执行命令');
  assert.ok(mcp.includes('注入 ${s.injected'), 'skill_find/record 没显示注入次数');
});

check('bridge 注入技能时记注入次数（两处）', () => {
  assert.ok(bridge.includes('noteInjected as noteSkillInjected'), '没导入 noteInjected');
  const n = (bridge.match(/noteSkillInjected\(store/g) || []).length;
  assert.ok(n >= 2, `只在 ${n} 处记账`);
});

check('独处时递「练手位」（注入过但还没做成过）', () => {
  assert.ok(bridge.includes('[PRACTICE]'), '没有 [PRACTICE]');
  assert.ok(bridge.includes('practiceSlotLine()'), '没有 practiceSlotLine');
  // 筛选口径已迁到 practice-slot.mjs（纯函数）：不再对字符串，直接验行为
  const { fresh, stuck } = pickPracticeSlots([
    { id: 'a', name: '新学', injected: 3, success: 0 },
    { id: 'b', name: '试过太多次', injected: 300, success: 0 },
    { id: 'c', name: '做成了', injected: 9, success: 2 },
  ]);
  assert.deepEqual(fresh.map((s) => s.name), ['新学'], `练手位筛选不对：${JSON.stringify(fresh.map((s) => s.name))}`);
  assert.deepEqual(stuck.map((s) => s.name), ['试过太多次'], '试过多的不该再摆到眼前');
  const block = renderPracticeSlots([{ id: 'a', name: '新学', injected: 3, success: 0, verify: '文件:README.md' }]);
  assert.ok(block.includes('skill_verify 验一下'), '没有把验证方式告诉她');
});

check('memory-mcp 注册 skill_edit（她自己改判据）', () => {
  assert.ok(mcp.includes("'skill_edit'"), '没有 skill_edit');
  assert.ok(mcp.includes('patch.verify = verify') && mcp.includes('Skills.revise(store, id, patch)'), 'skill_edit 没有把 verify 交给 revise');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
