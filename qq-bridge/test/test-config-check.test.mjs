import test from 'node:test';
import assert from 'node:assert/strict';
import { compareConfigShape, findDroppedKeys, flattenConfig, formatConfigReport } from '../src/config-check.mjs';

test('flatten：数组算叶子、空对象算叶子', () => {
  assert.deepEqual(flattenConfig({ a: { b: 1 }, c: [], d: {} }), ['a.b', 'c', 'd']);
});

test('被白名单静默丢弃的键能被找出来（顶层 / 嵌套）', () => {
  const raw = { ownerQQ: 1, ownerQQs: 2, socialV2: { enabled: true, typoKey: 1 } };
  const effective = { ownerQQ: 1, socialV2: { enabled: true } };
  assert.deepEqual(findDroppedKeys(raw, effective).map((d) => d.path), ['ownerQQs', 'socialV2.typoKey']);
});

test('别名不算被丢弃：allow.privates 会被加载器映射为 allow.private', () => {
  const raw = { allow: { privates: [1], group: [2] }, deny: { privates: [3] } };
  const effective = { allow: { private: [1], groups: [2] }, deny: { private: [3], groups: [] } };
  assert.deepEqual(findDroppedKeys(raw, effective), []);
});

test('整块未接线时只报块名，不逐叶轰炸', () => {
  const raw = { gate: { enabled: true, cosThreshold: 0.5 } };
  assert.deepEqual(findDroppedKeys(raw, {}).map((d) => d.path), ['gate']);
});

test('形状比对：现网用的键在 example 里缺失会被报出来', () => {
  const live = { ownLife: { maxPerDay: 0 }, gate: { enabled: true } };
  const example = { ownLife: {} };
  const shape = compareConfigShape(live, example);
  assert.deepEqual(shape.missingInExample, ['gate.enabled', 'ownLife.maxPerDay']);
});

test('空对象不算缺：example 展开了子键也算覆盖', () => {
  const live = { socialV2: { memoryInject: {} } };
  const example = { socialV2: { memoryInject: { limit: 5 } } };
  assert.deepEqual(compareConfigShape(live, example).missingInExample, []);
});

test('报告文案：没有问题时要明确说通过', () => {
  const lines = formatConfigReport({ dropped: [], missingInExample: [], extraInExample: [] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /通过/);
});
