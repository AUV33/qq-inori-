// [PLAN-STORE] 计划条目「一条一个文件」的回归锁。
//
// 要钉住的其实是两件事：
// 1) 并发创建不会互相覆盖 / id 不撞；
// 2) 「完成」是 append-only 的流水，不重写历史。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlan, listPlans, readPlan, setStatus, parseEntry } from '../scripts/plan.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-store-'));
}

test('创建 → 列出 → 读回，字段完整', async () => {
  const root = tmpRoot();
  const r = await createPlan({ title: '测试计划 A', body: '## 改什么\n改一点点', root });
  const items = listPlans({ root });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '测试计划 A');
  assert.equal(items[0].status, 'todo');
  assert.match(items[0].body, /改一点点/);

  const one = readPlan(r.id, { root });
  assert.equal(one.title, '测试计划 A');
  assert.equal(one.id, r.id);
});

test('空标题被拒', async () => {
  const root = tmpRoot();
  await assert.rejects(() => createPlan({ title: '   ', root }), /title/);
});

test('连续创建 30 条：id 全不同、文件都在、不互相覆盖', async () => {
  const root = tmpRoot();
  const created = [];
  for (let i = 0; i < 30; i += 1) created.push(await createPlan({ title: `并发计划 ${i}`, root }));
  const ids = new Set(created.map((c) => c.id));
  assert.equal(ids.size, 30);
  const items = listPlans({ root, includeDone: true });
  assert.equal(items.length, 30);
  for (const c of created) assert.ok(fs.existsSync(c.file));
});

test('done：状态置为 done，且 DONE.md 记一条（append-only，旧的还在）', async () => {
  const root = tmpRoot();
  const a = await createPlan({ title: '先完成的', root });
  const b = await createPlan({ title: '后完成的', root });
  await setStatus(a.id, 'done', { root });
  await setStatus(b.id, 'done', { root });

  const doneFile = path.join(root, 'data', 'state', 'plans', 'DONE.md');
  const lines = fs.readFileSync(doneFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /先完成的/);
  assert.match(lines[1], /后完成的/);

  // 默认列表不显示已完成的，--all 才显示
  assert.equal(listPlans({ root }).length, 0);
  assert.equal(listPlans({ root, includeDone: true }).length, 2);
  assert.equal(readPlan(a.id, { root }).status, 'done');
});

test('搁置（shelved）：不算进行中，不进完成流水，--all 才看得到', async () => {
  const root = tmpRoot();
  const a = await createPlan({ title: '要搁置的', root });
  const b = await createPlan({ title: '还在做的', root });
  await setStatus(a.id, 'shelved', { root });

  // 默认列表只剩进行中的那条
  const active = listPlans({ root });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, b.id);

  // --all 能看到，状态正确
  const all = listPlans({ root, includeDone: true });
  assert.equal(all.length, 2);
  assert.equal(readPlan(a.id, { root }).status, 'shelved');

  // 搁置不写完成流水
  const doneFile = path.join(root, 'data', 'state', 'plans', 'DONE.md');
  assert.equal(fs.existsSync(doneFile), false);
});

test('非法状态被拒；不存在的 id 报错', async () => {
  const root = tmpRoot();
  const r = await createPlan({ title: '随便', root });
  await assert.rejects(() => setStatus(r.id, 'finished', { root }), /status/);
  await assert.rejects(() => setStatus('no-such-plan', 'done', { root }), /找不到/);
});

test('坏文件不会把 parse 炸掉（返回 null）', () => {
  assert.equal(parseEntry('没有分隔符'), null);
  assert.equal(parseEntry('status: todo\n---\n没标题'), null);
  const ok = parseEntry('status: doing\ntitle: 有标题\nid: x\n---\n正文');
  assert.equal(ok.title, '有标题');
  assert.equal(ok.status, 'doing');
});
