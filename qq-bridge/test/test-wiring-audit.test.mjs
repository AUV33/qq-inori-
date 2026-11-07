// 接线审计器自己的金标：解析规则一旦跑偏，这个门禁就会变成噪音源。
// 最后一组是「真源码零缺口」的端到端断言——等于把 npm run audit:wiring 接进 npm test。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  maskSource, parseDestructureFields, factoriesOf, objectLiteralKeys,
  auditDanglingCalls, auditShorthandRefs, auditUndeclaredRefs, declaredNames, buildExportMap, runAudit,
} from '../scripts/audit-wiring.mjs';

test('maskSource：注释/字符串压空格，模板里的 ${} 代码保留', () => {
  const src = [
    "const a = 'foo(bar)'; // baz(qux)",
    '/* quux(corge) */',
    'log(`值 ${compute(1)} 和文字(call)`);',
  ].join('\n');
  const masked = maskSource(src);
  assert.equal(masked.includes('foo(bar)'), false);
  assert.equal(masked.includes('baz(qux)'), false);
  assert.equal(masked.includes('quux(corge)'), false);
  assert.equal(masked.includes('compute(1)'), true, '${} 里是代码，不能遮掉');
  assert.equal(masked.includes('call'), false, '模板字面量部分要遮掉');
  assert.equal(masked.split('\n').length, src.split('\n').length, '行号必须保持');
});

test('parseDestructureFields：别名取属性名，默认值算可选', () => {
  const f = parseDestructureFields(' cfg, fetch: fetchImpl, rotateTo, maxBytes = 1024, ...rest ');
  assert.deepEqual([...f.keys].sort(), ['cfg', 'fetch', 'maxBytes', 'rotateTo']);
  assert.equal(f.names.has('fetchImpl'), true);
  assert.equal(f.optional.has('maxBytes'), true);
  assert.equal(f.optional.has('cfg'), false);
  assert.deepEqual(f.pairs.find((p) => p.key === 'fetch'), { key: 'fetch', binding: 'fetchImpl', optional: false });
});

test('factoriesOf：同一文件里两个工厂的依赖不互相污染', () => {
  const src = `
export function createA({ file, writeJson }) { return { file, writeJson }; }
export function createB({ stateDir, writeText }) { return { stateDir, writeText }; }
`;
  const factories = factoriesOf(src);
  assert.deepEqual([...factories.get('createA').keys()], ['file', 'writeJson']);
  assert.deepEqual([...factories.get('createB').keys()], ['stateDir', 'writeText']);
});

test('factoriesOf：函数体里 const {...} = ctx 的依赖也算必填', () => {
  const src = `
export function createX(ctx) {
  const { cfg, isDshReady, log = () => {} } = ctx;
  return () => [cfg, isDshReady, log()];
}
`;
  const deps = factoriesOf(src).get('createX');
  assert.equal(deps.has('cfg'), true);
  assert.equal(deps.has('isDshReady'), true);
  assert.equal(deps.has('log'), false, '自带默认值的不算必填');
});

test('objectLiteralKeys：取顶层键，getter 算键，spread 视为不可验证', () => {
  const keys = objectLiteralKeys('{ file: p, get mode() { return 1; }, writeJson, nested: { a: 1 } }');
  assert.deepEqual([...keys.keys].sort(), ['file', 'mode', 'nested', 'writeJson']);
  assert.equal(keys.unverifiable, false);
  assert.equal(objectLiteralKeys('{ ...base, a: 1 }').unverifiable, true);
});

test('auditDanglingCalls：调用了别的模块 export 却没 import 要报，import 了不报', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-audit-'));
  const lib = path.join(dir, 'lib.mjs');
  const missing = path.join(dir, 'missing.mjs');
  const ok = path.join(dir, 'ok.mjs');
  fs.writeFileSync(lib, 'export function unwrap(x) { return x; }\n', 'utf8');
  fs.writeFileSync(missing, 'export function run(v) { return unwrap(v); }\n', 'utf8');
  fs.writeFileSync(ok, "import { unwrap } from './lib.mjs';\nexport function run(v) { return unwrap(v); }\n", 'utf8');
  const files = [lib, missing, ok];
  const issues = auditDanglingCalls(files, buildExportMap(files));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, 'unwrap');
  assert.equal(path.basename(issues[0].file), 'missing.mjs');
});

test('auditShorthandRefs：对象简写里的未声明名字要报，export 列表和形参不报', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-shorthand-'));
  const bad = path.join(dir, 'bad.mjs');
  const good = path.join(dir, 'good.mjs');
  fs.writeFileSync(bad, [
    'export function build(deps) {',
    '  return {',
    '    ok: true,',
    '    missingName,',
    '  };',
    '}',
  ].join('\n'), 'utf8');
  fs.writeFileSync(good, [
    'const exported = 1;',
    'export {',
    '  exported,',
    '};',
    'export function build(declared, other = () => 1) {',
    '  return {',
    '    declared,',
    '    other,',
    '  };',
    '}',
  ].join('\n'), 'utf8');
  const issues = auditShorthandRefs([bad, good]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, 'missingName');
  assert.equal(path.basename(issues[0].file), 'bad.mjs');
});

test('auditUndeclaredRefs：读 app.mjs 遗留的闭包变量要报（黑话库/消息入口那类事故）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-undeclared-'));
  const bad = path.join(dir, 'bad.mjs');
  const good = path.join(dir, 'good.mjs');
  fs.writeFileSync(bad, [
    'export function createX(ctx) {',
    '  const { getSlangStoreWritable } = ctx;',
    '  if (!slangStoreWritable) return;',
    '}',
  ].join('\n'), 'utf8');
  fs.writeFileSync(good, [
    'import { unwrap } from "./dsh-client.js";',
    'export function createX(ctx) {',
    '  const { getSlangStoreWritable } = ctx;',
    '  if (!getSlangStoreWritable()) return;',
    '  return unwrap({ ok: true });',
    '}',
  ].join('\n'), 'utf8');
  const issues = auditUndeclaredRefs([bad, good]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, 'slangStoreWritable');
  assert.equal(issues[0].kind, 'undeclared-ref');
});

test('declaredNames：调用点对象字面量的键不算声明，解构形参才算（线上两条 ReferenceError 的教训）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-decl-'));
  const file = path.join(dir, 'a.mjs');
  fs.writeFileSync(file, [
    '// 调用点：对象字面量里的键**不是**本文件的声明',
    'export function build() {',
    '  return createThing({',
    '    MAX_MEDIA_STORE_PER_KEY,',
    '    bumpSessionEpoch,',
    '  });',
    '}',
    '// 这些才是声明',
    'export const f1 = ({ a, b = 1 } = {}) => a;',
    'export function f2({ c, d }, e) { return c + d + e; }',
    'export const f3 = ([x, y]) => x + y;',
  ].join('\n'), 'utf8');
  const names = declaredNames(fs.readFileSync(file, 'utf8'));
  assert.equal(names.has('MAX_MEDIA_STORE_PER_KEY'), false, '对象字面量的键不能算声明');
  assert.equal(names.has('bumpSessionEpoch'), false);
  for (const want of ['a', 'b', 'c', 'd', 'e', 'x', 'y']) assert.equal(names.has(want), true, `解构形参 ${want} 要算声明`);
});

test('auditUndeclaredRefs：调用 main() 里未导出的局部函数也要报（B 的盲区）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-callgap-'));
  const bad = path.join(dir, 'bad.mjs');
  const good = path.join(dir, 'good.mjs');
  fs.writeFileSync(bad, [
    'export function send(ctx) {',
    '  const { getLifeState } = ctx;',
    '  const st = getLifeState();',
    '  return readRoleState();', // readRoleState 是 main() 里的局部函数，既没 import 也没导出
    '}',
  ].join('\n'), 'utf8');
  fs.writeFileSync(good, [
    'export function send(ctx) {',
    '  const { readRoleState } = ctx;',
    '  return readRoleState();',
    '}',
  ].join('\n'), 'utf8');
  const issues = auditUndeclaredRefs([bad, good]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, 'readRoleState');
});

test('auditUndeclaredRefs：对象/类里的方法定义不算引用（{ foo() {} }）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-method-'));
  const file = path.join(dir, 'a.mjs');
  fs.writeFileSync(file, [
    'function build() {',
    '  return {',
    '    describeThing() { return 1; },',
    '  };',
    '}',
    'class X {',
    '  renderBlock() { return 2; }',
    '}',
  ].join('\n'), 'utf8');
  assert.deepEqual(auditUndeclaredRefs([file]), []);
});

test('auditUndeclaredRefs：短名模块别名（fs/os/path）也必须照查', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-shortname-'));
  const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(bad, [
    'export function write(file, row, append) {',
    '  const r = append(file, row);',
    '  if (!r.ok) fs.appendFileSync(file, row);',
    '}',
  ].join(String.fromCharCode(10)), 'utf8');
  const issues = auditUndeclaredRefs([bad]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, 'fs', '短名不能因为长度过滤被放过');
});

test('端到端：仓库源码零接线缺口（npm run audit:wiring 的测试版）', () => {
  const result = runAudit();
  const detail = result.issues.map((i) => (i.kind === 'ctx-missing'
    ? `${i.file} ${i.factory} 缺 ${i.name}（${i.at} 未提供）`
    : `${i.file}:${i.line} ${i.name}() 未 import（定义于 ${i.definedIn}）`)).join('\n');
  assert.equal(result.issues.length, 0, `发现接线缺口：\n${detail}`);
});
