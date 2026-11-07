// [WIRING-FIX] deps facade 契约回归锁。
//
// 背景（2026-11-03 实锤）：app.mjs 用「依赖对象 + getter」把状态交给子模块（console-server / mux-bus）。
// 但有一批 getter 的 `return <ident>` 引用了从未声明的标识符（sticker 防抖、媒体像素上限、预设备份目录、
// ownerKey、日记强制日集合、changed）。ESM 严格模式下这不是「值不对」，而是**一读就 ReferenceError**：
// 上传校验、预设备份、清空工作区、日记重试、控制台鉴权、强制刷新表情这些分支直接崩。
//
// 本测试锁两件事（都是源码事实，不需要跑整个 app）：
//   1) 每个 deps 对象里 `get X() { return <裸标识符> }` 的标识符，必须在 app.mjs 里能声明/导入到；
//   2) 每个消费模块的 `__deps.<name>` 读取点，其 deps 对象必须提供同名条目（读了没有 = 运行期抛）。
//
// 注意：不做全文注释剥离（源码里有包含 /* 的字符串，粗暴正则会吃掉大段代码）；只按行跳注释行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const APP = path.join(SRC, 'app.mjs');

// deps 对象 → 消费它的模块（源码事实：app.mjs 里的 createXxx(consoleDeps/pumpMuxDeps)）
const FACADES = [
  { object: 'consoleDeps', consumers: ['adapters/console-server.mjs'] },
  { object: 'pumpMuxDeps', consumers: ['adapters/mux-bus.mjs'] },
];

const GLOBALS = new Set([
  'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Promise', 'Set', 'Map',
  'Buffer', 'process', 'console', 'URL', 'Error', 'RegExp', 'isNaN', 'parseInt', 'parseFloat',
  'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'TextDecoder',
  'TextEncoder', 'Intl', 'globalThis', 'AbortController', 'encodeURIComponent', 'decodeURIComponent',
  'Symbol', 'BigInt', 'Infinity', 'NaN', 'undefined',
]);

/** 取出 `const <name> = { ... };` 的对象体。
 *  用行式扫描：从声明行往下找「同缩进的 `};`」——对象体里含字符串/模板字面量，
 *  花括号计数会被字符串里的 `}` 带偏（实测会把 consoleDeps 截断，漏掉一半键）。 */
function objectBody(appSrc, name) {
  const lines = appSrc.split('\n');
  const decl = lines.findIndex((l) => new RegExp(`^\\s*const\\s+${name}\\s*=\\s*\\{`).test(l));
  assert.ok(decl >= 0, `app.mjs 里找不到 ${name} 对象`);
  const indent = lines[decl].match(/^\s*/)[0];
  const close = lines.findIndex((l, i) => i > decl && l === `${indent}};`);
  assert.ok(close > decl, `${name} 对象没有找到同缩进的闭合行`);
  return lines.slice(decl + 1, close).join('\n');
}

/** app.mjs 里是否出现该标识符的声明 / 导入 / 解构。 */
function buildDeclaredChecker(appSrc) {
  // import 子句可能很长（一行 import 几十个名字，from 在几百字符之后），
  // 所以先把所有 import 子句里的词收进集合，而不是用「ident 后 200 字符内必须有 from」。
  const imported = new Set();
  for (const m of appSrc.matchAll(/\bimport\b([\s\S]*?)\bfrom\s*['"][^'"]+['"]/g)) {
    for (const word of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) imported.add(word[0]);
  }
  return (ident) => {
    if (imported.has(ident)) return true;
    const id = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`\\b(?:let|const|var|function|class|async\\s+function)\\s+${id}\\b`),
      new RegExp(`\\{[^}]*\\b${id}\\b[^}]*\\}\\s*=`), // const { a, b } = ...
    ];
    return patterns.some((re) => re.test(appSrc));
  };
}

/** deps 对象提供了哪些键（getter / setter / 简写 / 别名）。 */
function providedKeys(body) {
  const provided = new Set();
  for (const m of body.matchAll(/get\s+(\w+)\s*\(\s*\)\s*\{/g)) provided.add(m[1]);
  for (const m of body.matchAll(/set\s+(\w+)\s*\(\s*\w*\s*\)\s*\{/g)) provided.add(m[1]);
  for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*),\s*$/gm)) provided.add(m[1]);
  for (const m of body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*,\s*$/gm)) provided.add(m[1]);
  return provided;
}

// Windows 上 app.mjs 可能是 CRLF：按行匹配（找同缩进的 `};`）前先归一，否则行尾 \r 会让匹配失败
const appSrc = fs.readFileSync(APP, 'utf8').replace(/\r\n/g, '\n');
const isDeclared = buildDeclaredChecker(appSrc);

test('deps 对象的每个 getter 返回的裸标识符都已声明', () => {
  const problems = [];
  for (const { object } of FACADES) {
    const body = objectBody(appSrc, object);
    for (const m of body.matchAll(/get\s+(\w+)\s*\(\s*\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\s*;?\s*\}/g)) {
      const [, getterName, ident] = m;
      if (GLOBALS.has(ident)) continue;
      if (!isDeclared(ident)) problems.push(`${object}: get ${getterName}() -> ${ident}（未声明）`);
    }
  }
  assert.deepEqual(problems, [], `deps 里有 getter 引用了不存在的标识符：\n${problems.join('\n')}`);
});

test('每个消费模块的 __deps.<name> 都由对应 deps 对象提供', () => {
  for (const { object, consumers } of FACADES) {
    const provided = providedKeys(objectBody(appSrc, object));
    const missing = new Map();
    for (const name of consumers) {
      const file = path.join(SRC, name);
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        for (const m of line.matchAll(/\b__deps\.([A-Za-z_$][\w$]*)/g)) {
          if (provided.has(m[1])) continue;
          if (!missing.has(m[1])) missing.set(m[1], []);
          missing.get(m[1]).push(`${name}:${i + 1}`);
        }
      });
    }
    const report = [...missing.entries()].map(([name, locs]) => `${name} -> ${locs.slice(0, 3).join(', ')}`);
    assert.deepEqual(report, [], `${object} 缺这些被 ${consumers.join(',')} 读取的键（运行期会抛）：\n${report.join('\n')}`);
  }
});

test('getSelfKnowledgeBlock 必须转发参数，不能把函数本身塞进 prompt', () => {
  const src = fs.readFileSync(APP, 'utf8');
  assert.match(src, /getSelfKnowledgeBlock:\s*\([^)]*\)\s*=>\s*selfKnowledgeBlock\(/, '必须写成 (opts) => selfKnowledgeBlock(opts)');
});
