// test-assoc-activation.test.mjs · 宪章 §5.12：联想不是"检索的另一种排序"，是 node→edge→node 的扩散。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'assoc-'));
process.env.QQ_INORI_ROOT = ROOT;

const {
  buildAssociationGraph, spreadActivation, idleAssociations, renderAssociationBlock, entryKey,
} = await import('../src/domain/memory/assoc-activation.mjs');

const T = Date.UTC(2026, 10, 5, 4);
const e = (over) => ({ time: '2026-11-05 12:00', text: '一条记忆', who: '他', theme: '', recordedAt: T, ...over });

test('建图：同 who/theme、时间邻近、字面相似、显式 link 都会成边', () => {
  const a = e({ id: 'a', text: '他说喜欢披萨', theme: '吃', recordedAt: T });
  const b = e({ id: 'b', text: '意面店排队', theme: '吃', recordedAt: T + 3600000 });
  const c = e({ id: 'c', text: '完全无关的工作报表', who: '她', theme: '工作', recordedAt: T + 30 * 86400000 });
  const d = e({ id: 'd', text: '另一件事', who: '她', theme: '工作', recordedAt: T + 30 * 86400000, links: ['c'] });
  const graph = buildAssociationGraph([a, b, c, d], { now: T });
  assert.equal(graph.nodes.size, 4);
  assert.ok(graph.edges.get('a').some((x) => x.to === 'b'), '同 theme + 时间邻近');
  assert.ok(graph.edges.get('c').some((x) => x.to === 'd' && x.kind.includes('explicit')), '显式 link');
  assert.equal(graph.edges.get('a').some((x) => x.to === 'c'), false, '无关的不硬连');
  assert.equal(entryKey({ id: 'x' }), 'x');
  assert.match(entryKey({ time: 't', text: 'text' }), /^t\|/);
});

test('entryKey：同时间同 40 字前缀但正文不同，不得碰撞丢节点', () => {
  const prefix = 'A'.repeat(40);
  const a = e({ time: '2026-01-01', text: prefix + '-one' });
  const b = e({ time: '2026-01-01', text: prefix + '-two' });
  assert.notEqual(entryKey(a), entryKey(b));
  const graph = buildAssociationGraph([a, b], { now: T });
  assert.equal(graph.nodes.size, 2, '两条都必须进图');
});

test('语义边：向量相近但字面无关也能连；低于阈值/坏向量不连也不炸', () => {
  const a = e({ id: 'a', text: '他说喜欢披萨', who: '甲', theme: '吃', recordedAt: T });
  const b = e({ id: 'b', text: '意式餐厅排队', who: '乙', theme: '玩', recordedAt: T + 30 * 86400000 });
  const vec = { a: [1, 0, 0], b: [0.99, 0.01, 0], c: [0, 1, 0] };
  const semantic = buildAssociationGraph([a, b], { now: T, vectorOf: (x) => vec[x.id], semanticThreshold: 0.8 });
  assert.ok(semantic.edges.get('a').some((x) => x.to === 'b' && x.kind.includes('semantic')));

  const off = buildAssociationGraph([a, b], { now: T, vectorOf: (x) => vec[x.id], semanticThreshold: 1.1 });
  assert.equal(off.edges.get('a').some((x) => x.kind.includes('semantic')), false);

  const bad = buildAssociationGraph([a, b], { now: T, vectorOf: () => [1, 'x'], semanticThreshold: 0.8 });
  assert.ok(bad.edges.get('a').length >= 0, '坏向量不抛错');

  const vec2 = { a: [1, 0], b: [0.9, 0.1] };
  const spread = spreadActivation(buildAssociationGraph([a, b], { now: T, vectorOf: (x) => vec2[x.id] }), ['a'], { topK: 2 });
  assert.ok(spread.activated.some((x) => x.key === 'b'), '语义边也能扩散点亮');
});

test('扩散激活：从种子点亮邻域，种子自身不出现；衰减让 2 跳权重低于 1 跳', () => {
  const a = e({ id: 'a', text: '披萨', theme: '吃', recordedAt: T });
  const b = e({ id: 'b', text: '意面', theme: '吃', recordedAt: T + 3600000 });
  const c = e({ id: 'c', text: '咖啡', theme: '吃', recordedAt: T + 7200000 });
  const graph = buildAssociationGraph([a, b, c], { now: T });
  const act = spreadActivation(graph, ['a'], { steps: 2, decay: 0.5, topK: 5 });
  assert.ok(act.activated.length >= 2);
  assert.equal(act.activated.some((x) => x.key === 'a'), false, '种子不重复注入');
  const bScore = act.activated.find((x) => x.key === 'b')?.score || 0;
  const cScore = act.activated.find((x) => x.key === 'c')?.score || 0;
  assert.ok(bScore >= cScore, '1 跳不应低于 2 跳');
  assert.deepEqual(spreadActivation(null, ['a']).activated, []);
});

test('闲置联想：确定性随机游走，可复现，且不回到种子', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => e({ id, text: id, theme: '同', recordedAt: T }));
  const graph = buildAssociationGraph(entries, { now: T });
  const one = idleAssociations(graph, { seedKey: 'a', steps: 3, topK: 3, seed: 42 });
  const two = idleAssociations(graph, { seedKey: 'a', steps: 3, topK: 3, seed: 42 });
  assert.deepEqual(one.map((x) => x.key), two.map((x) => x.key));
  assert.equal(one.some((x) => x.key === 'a'), false);
  assert.ok(one.length >= 1);
});

test('渲染：空为空串；有条目带块头与"不是检索结果"的界定', () => {
  assert.equal(renderAssociationBlock([]), '');
  const text = renderAssociationBlock([{ key: 'b', entry: { text: '意面店排队' }, score: 0.3 }]);
  assert.match(text, /顺带想起/);
  assert.match(text, /意面店排队/);
  assert.match(text, /不是检索结果/);
  assert.equal(/你必须|应该/.test(text), false);
});

test('接线：memory-retrieve 在召回后做扩散，块头可被预算系统识别', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(REPO, 'src/domain/memory/memory-retrieve.js'), 'utf8');
  assert.match(src, /buildAssociationGraph/);
  assert.match(src, /spreadActivation/);
  assert.match(src, /assocBlock/);
  assert.match(src, /filesForScope\(opts\.dir \|\| DEFAULTS\.dir, scope\)/, '联想池必须按 scope 与调用方 dir 取库');
  const assoc = fs.readFileSync(path.join(REPO, 'src/domain/memory/assoc-activation.mjs'), 'utf8');
  assert.match(assoc, /【顺带想起/);
});
