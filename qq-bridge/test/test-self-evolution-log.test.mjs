// [SELF-EVOLUTION-LOG] 进化账本读端：只认「她自己改的」——回归锁。
//
// 钉住的是审计 §8 那个假自画像：owner 的搬迁被当成她的成长。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHerEdit, describeEdit, pickHerRecentEdit } from '../src/domain/persona/self-evolution-log.mjs';

const NOW = Date.parse('2026-10-28T22:00:00.000Z');
const at = (h) => new Date(NOW - h * 3600_000).toISOString();

test('护栏/owner 写的行都不算她改的', () => {
  assert.equal(isHerEdit({ actor: 'guard', kind: 'code_edit' }), false);
  assert.equal(isHerEdit({ kind: 'code_edit' }), false); // 老记录没有 actor
  assert.equal(isHerEdit({ actor: 'her', kind: 'self_model_snapshot' }), false);
});

test('她自己改的才认', () => {
  assert.equal(isHerEdit({ actor: 'her', kind: 'self_edit' }), true);
  assert.equal(isHerEdit({ actor: 'her', kind: 'code_edit' }), true);
});

test('没有她的记录 → null（调用方不该再说"我最近改过自己"）', () => {
  const rows = [
    { at: at(1), actor: 'guard', kind: 'code_edit', file: 'src/a.js' },
    { at: at(2), kind: 'code_edit', file: 'src/b.js' }, // 旧格式，无 actor
  ];
  assert.equal(pickHerRecentEdit(rows, { now: NOW }), null);
});

test('有她的记录 → 取最新那条', () => {
  const rows = [
    { at: at(5), actor: 'her', kind: 'self_edit', target: 'role', action: 'append' },
    { at: at(1), actor: 'guard', kind: 'code_edit', file: 'src/a.js' },
  ];
  const hit = pickHerRecentEdit(rows, { now: NOW });
  assert.equal(hit.target, 'role');
});

test('超过 14 天的不算', () => {
  const rows = [{ at: at(15 * 24), actor: 'her', kind: 'self_edit', target: 'selfnotes', action: 'replace' }];
  assert.equal(pickHerRecentEdit(rows, { now: NOW }), null);
});

test('描述：文件行给 file+结果，自述行给 target+action', () => {
  assert.equal(describeEdit({ file: 'src/a.js', result: 'syntax_ok' }), 'src/a.js（syntax_ok）');
  assert.equal(describeEdit({ target: 'role', action: 'append' }), 'role（append）');
});

test('坏输入不炸', () => {
  assert.equal(pickHerRecentEdit(null, { now: NOW }), null);
  assert.equal(pickHerRecentEdit([null, undefined, {}], { now: NOW }), null);
});
