// test-skill-lifecycle.mjs · 错误/无效技能：改进与删除（归档保留）
import assert from 'node:assert';
import fs from 'node:fs';
import { load, drop } from '../src/domain/leaves/inori-skills.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

check('drop：摘掉指定技能，返回整条（失败史随条目带走）', () => {
  const store = { version: 1, items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  const removed = drop(store, 'a');
  assert.equal(removed.id, 'a');
  assert.deepEqual(store.items.map((x) => x.id), ['b']);
});

check('drop：找不到 id 返回 null，不动库', () => {
  const store = { version: 1, items: [{ id: 'a' }] };
  assert.equal(drop(store, 'nope'), null);
  assert.equal(store.items.length, 1);
});

const mcp = fs.readFileSync(`${PROJECT_ROOT}/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js`, 'utf8');

check('注册 skill_list / skill_delete', () => {
  assert.ok(mcp.includes("'skill_list'"), '没有 skill_list');
  assert.ok(mcp.includes("'skill_delete'"), '没有 skill_delete');
  assert.ok(mcp.includes('skills-archive.jsonl'), '没有归档文件');
  assert.ok(mcp.includes('force !== true'), '没有 force 保护');
});

check('skill_find 会显示停用状态', () => {
  assert.ok(mcp.includes('已停用'), '没有停用状态展示');
  assert.ok(mcp.includes('deprecatedReason'), '没带停用原因');
});

check('删除前先提示：成功过的要 force', () => {
  assert.ok(mcp.includes('成功过 ${s.success} 次'), '没有成功过提示');
});

check('真实技能库当前状态（>=8 条，判据可机检或人工）', () => {
  const store = load();
  assert.ok(Array.isArray(store.items) && store.items.length >= 8, '技能库为空');
  for (const s of store.items) {
    // 技能允许“人工判据”（如手画线条），但必须保留 verifyHuman；有机器判据的仍必须是命令。
    assert.ok(/^命令:/.test(String(s.verify)) || String(s.verifyHuman || '').trim(), `${s.name} 既没有机器判据也没有人工判据`);
  }
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
