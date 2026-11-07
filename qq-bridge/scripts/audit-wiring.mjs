#!/usr/bin/env node
// audit-wiring.mjs · 接线审计：只查"语法能过、单测能过、运行才炸"的两类回归
//
// 为什么需要（2026-11-02 一天内真实踩到两回）：
//   1. bootstrap/config.mjs 外提时漏 import normalizeReasoningEffort：
//      ReferenceError 被 try/catch 吞掉 → config.json 里 dsh.reasoningEffort 永远不生效；
//   2. app.mjs 引导代码调用 maintenance.runSessionRetain / transient.ensureIsolatedSession，
//      但服务没返回这两个函数 → 启动即 ReferenceError。
// 这两类都不属于"逻辑"，属于"接线"，单测天然覆盖不到。
//
// 本脚本只断言两件可静态证明的事：
//   A. ctx 契约：createX(ctx) 解构了哪些依赖 vs 调用点实际提供了哪些（漏一个就是 undefined）；
//   B. 跨模块调用：调用了别的模块 export 的名字，但自己既没 import 也没声明。
//
// 用法：node scripts/audit-wiring.mjs [--json]
// 退出码：0 = 无发现；1 = 有发现。
//
// 已知边界：正则级分析，不做完整作用域解析。声明/形参一律做宽匹配，
// 宁可漏报也不误报——误报一次就没人再跑这个脚本了。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');

// ── 源码遮罩：注释压空格、字符串/模板内容压空格，保留换行与 ${} 里的代码 ──────
// 单遍状态机遮罩：注释/字符串/正则/模板文本一律压空格，`${...}` 里的代码保留，
// 行号位置不动。之前分成"先字符串、后正则"两遍，遇到正则里含引号（/property="og:title"/）
// 就会把后面的代码整段当字符串吞掉——既漏报也误报，所以改成一趟走完。
export function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  const NL = String.fromCharCode(10);
  const blank = (from, to) => { for (let k = from; k < to && k < n; k += 1) if (src[k] !== NL) out[k] = ' '; };
  const stack = []; // 'template' | 'expr'；栈顶决定当前模式
  let braceDepth = 0;
  let prevSig = '';
  let word = '';
  const top = () => stack[stack.length - 1] ?? null;
  const inCode = () => top() !== 'template';
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (!inCode()) {
      if (c === '`') { stack.pop(); blank(i, i + 1); i += 1; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('expr'); braceDepth = 0; blank(i, i + 2); i += 2; continue; }
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    // 以下都是"代码"模式
    if (c === '}' && top() === 'expr' && braceDepth === 0) { stack.pop(); blank(i, i + 1); i += 1; continue; }
    if (c === '}' && top() === 'expr' && braceDepth > 0) { braceDepth -= 1; prevSig = c; word = ''; i += 1; continue; }
    if (c === '{' && top() === 'expr') { braceDepth += 1; prevSig = c; word = ''; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf(NL, i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== NL) { if (src[j] === '\\') j += 1; j += 1; }
      blank(i + 1, j);
      i = j + 1;
      prevSig = 'x';
      word = '';
      continue;
    }
    if (c === '`') { stack.push('template'); blank(i, i + 1); i += 1; continue; }
    if (c === '/' && (prevSig === '' || REGEX_PREFIX_CHARS.has(prevSig) || REGEX_PREFIX_WORDS.has(word))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === NL) break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        blank(i + 1, j);
        prevSig = '/';
        word = '';
        i = j + 1;
        continue;
      }
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      word = /[\w$]/.test(c) ? word + c : '';
    }
    i += 1;
  }
  return out.join('');
}

const REGEX_PREFIX_CHARS = new Set('/=(,:[!&|?{};+-*%^~<>'.split(''));
const REGEX_PREFIX_WORDS = new Set(['return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'await', 'yield', 'do', 'else', 'throw']);

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// ── 文件枚举 ───────────────────────────────────────────────────────────────
export function listSources(dir = SRC) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(entry.name) && !entry.name.includes('.bak')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// ── 声明集合（宽匹配） ─────────────────────────────────────────────────────
const DECL_PATTERNS = [
  /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  // 一行多个声明：let a = 1, b = 2
  /\b(?:const|let|var)\s+[^;\n]*?,\s*([A-Za-z_$][\w$]*)\s*=/g,
  /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
];

function addDestructuredNamesInto(text, set) {
  // "{ a, b: c, d = 1 }" -> a, c, d（嵌套对象/数组先摊平，否则形参照不到）
  const flat = String(text).replace(/[{[\]]/g, ' ').replace(/[}\]]/g, ' ');
  for (const part of flat.split(',')) {
    const chunk = part.trim().replace(/\/\/.*$/, '').trim();
    if (!chunk || chunk.startsWith('...')) continue;
    const alias = chunk.match(/^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)/);
    if (alias) { set.add(alias[1]); continue; }
    const plain = chunk.match(/^([A-Za-z_$][\w$]*)/);
    if (plain) set.add(plain[1]);
  }
}

/** 从 startIndex 处的 `{` 开始取配平内容（masked 源码上做） */
export function balancedBrace(masked, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return { inner: masked.slice(startIndex + 1, i), end: i + 1 };
    }
  }
  return { inner: masked.slice(startIndex + 1), end: masked.length };
}

const NOT_NAMES = new Set(['true', 'false', 'null', 'undefined', 'this', 'new', 'function', 'async', 'await', 'typeof', 'default', 'super', 'get', 'set']);

// 短名字里必须照查的：都是模块别名，裸用几乎一定是漏 import（见 social-format 的 `fs` 事故）
const SHORT_SUSPECT = new Set(['fs', 'os', 'path', 'url', 'db', 'net', 'api']);

/** 按顶层逗号切分（忽略 (){}[] 内部的逗号） */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text)) {
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 解构字段：names=绑定名，keys=属性名（`fetch: fetchImpl` 的键是 fetch），pairs=对应关系，optional=自带默认值 */
export function parseDestructureFields(innerText) {
  const names = new Set();
  const keys = new Set();
  const optional = new Set();
  const pairs = [];
  const chunks = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(innerText)) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { chunks.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) chunks.push(cur);
  for (const raw of chunks) {
    const chunk = raw.trim().replace(/\/\/.*$/, '').trim();
    if (!chunk || chunk.startsWith('...')) continue;
    const alias = chunk.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/);
    const name = alias ? alias[2] : (chunk.match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? null);
    if (!name || NOT_NAMES.has(name)) continue;
    const key = alias ? alias[1] : name;
    const hasDefault = chunk.includes('=');
    names.add(name);
    keys.add(key);
    if (hasDefault) optional.add(name);
    pairs.push({ key, binding: name, optional: hasDefault });
  }
  return { names, keys, pairs, optional };
}

/** 从「一个形参块」里取声明名：`{ a, b = 1 } = {}` → a,b；`...rest` → rest；`x = 1` → x */
function addParamNamesInto(signatureText, set) {
  for (const part of splitTopLevel(signatureText)) {
    const chunk = part.trim();
    if (!chunk) continue;
    if (chunk.startsWith('{')) {
      let depth = 0;
      let closedAt = -1;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === '{') depth += 1;
        else if (chunk[i] === '}') { depth -= 1; if (depth === 0) { closedAt = i; break; } }
      }
      const inner = closedAt > 0 ? chunk.slice(1, closedAt) : chunk.slice(1);
      for (const name of parseDestructureFields(inner).names) if (!NOT_NAMES.has(name)) set.add(name);
      continue;
    }
    if (chunk.startsWith('[')) {
      // 数组解构形参：([id, person]) => ...
      let depth = 0;
      let closedAt = -1;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === '[') depth += 1;
        else if (chunk[i] === ']') { depth -= 1; if (depth === 0) { closedAt = i; break; } }
      }
      const inner = closedAt > 0 ? chunk.slice(1, closedAt) : chunk.slice(1);
      for (const part of splitTopLevel(inner)) {
        const name = part.trim().replace(/^\.\.\./, '').match(/^([A-Za-z_$][\w$]*)/)?.[1];
        if (name && !NOT_NAMES.has(name)) set.add(name);
      }
      continue;
    }
    const plain = chunk.replace(/=.*$/s, '').trim().replace(/^\.\.\./, '');
    const name = plain.match(/^([A-Za-z_$][\w$]*)/)?.[1];
    if (name && !NOT_NAMES.has(name)) set.add(name);
  }
}

export function declaredNames(src) {
  const masked = maskSource(src);
  const set = new Set();
  for (const re of DECL_PATTERNS) {
    for (const m of masked.matchAll(re)) set.add(m[1]);
  }
  // 解构声明：const { a, b: c } = / const [a, b] =
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*\{/g)) {
    const braceAt = m.index + m[0].length - 1;
    const { inner, end } = balancedBrace(masked, braceAt);
    if (!/^\s*=/.test(masked.slice(end, end + 8))) continue;
    for (const name of parseDestructureFields(inner).names) set.add(name);
  }
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*\[([^[\]]*)\]\s*=/g)) addDestructuredNamesInto(m[1], set);
  // import：默认 / 命名 / 命名空间
  for (const m of masked.matchAll(/\bimport\s+([^;]+?)\s+from\s+['"]/g)) {
    const clause = m[1];
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) {
      for (const part of brace[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const alias = piece.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        set.add(alias ? alias[1] : piece.split(/\s+/)[0]);
      }
    }
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s*([A-Za-z_$][\w$]*)/, '$1').trim();
    const def = head.match(/^([A-Za-z_$][\w$]*)/);
    if (def) set.add(def[1]);
    const ns = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (ns) set.add(ns[1]);
  }
  // 形参宽匹配：只从「函数签名」里认解构形参（见下面的 function 扫描 + 箭头函数扫描）。
  // 绝不能用裸 `\(\s*\{` 扫全文件：那会把所有 `createX({ ... })` 的对象键都算成"已声明"，
  // 于是 app.mjs 里 `MAX_MEDIA_STORE_PER_KEY`/`bumpSessionEpoch` 这种裸引用被漏掉
  // （2026-11-02 线上 `处理群消息出错` 的根因，两条都是真炸过的）。
  for (const m of masked.matchAll(/,\s*\{/g)) {
    const braceAt = m.index + m[0].length - 1;
    for (const name of parseDestructureFields(balancedBrace(masked, braceAt).inner).names) set.add(name);
  }
  // for (const { address } of list) / const { a } = ... 这种"声明关键字直接跟大括号"的写法
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*\{/g)) {
    const braceAt = m.index + m[0].length - 1;
    for (const name of parseDestructureFields(balancedBrace(masked, braceAt).inner).names) set.add(name);
  }
  // 数组解构：for (const [storedRef, media] of byRef) / const [a, b] = ...
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*\[([^\[\]]{0,300})\]/g)) {
    for (const part of splitTopLevel(m[1])) {
      const name = part.trim().replace(/^\.\.\./, '').match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name && !NOT_NAMES.has(name)) set.add(name);
    }
  }
  // 普通位置参数：function f(a, b = 1) / (a, b) => —— 每个形参的首个标识符；`{...}` 走解构解析
  for (const m of masked.matchAll(/\(([^()]{0,500})\)\s*(?:=>|\{)/g)) {
    addParamNamesInto(m[1], set);
  }
  // 单参数箭头函数：x => ...（不声明就会被当成未声明引用）
  for (const m of masked.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) set.add(m[1]);
  // 类体里的字段/方法名：`agentPresets = {` / `async callUnary(` 都是定义，不是引用
  for (const m of masked.matchAll(/\bclass\s+[A-Za-z_$][\w$]*[^{]*\{/g)) {
    const body = balancedBrace(masked, m.index + m[0].length - 1).inner;
    for (const f of body.matchAll(/(?:^|\n)\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:=|\()/g)) {
      if (!NOT_NAMES.has(f[1])) set.add(f[1]);
    }
  }
  // 一行多个声明（含 `let min, max, longProb = 0, longMin = 0;`）：按顶层逗号切开逐个认领
  for (const line of masked.split('\n')) {
    const m = line.match(/^\s*(?:const|let|var)\s+([\s\S]+)$/);
    if (!m) continue;
    for (const part of splitTopLevel(m[1])) {
      const chunk = part.replace(/=.*$/s, '').trim();
      const name = chunk.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name && !NOT_NAMES.has(name)) set.add(name);
    }
  }
  // import 绑定：默认导入 / 命名导入（含 as 别名）/ 命名空间导入  for (const m of masked.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from\b)/g)) set.add(m[1]);
  for (const m of masked.matchAll(/\*\s*as\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of masked.matchAll(/\bimport\s*\{([\s\S]{0,400}?)\}\s*from\b/g)) {
    for (const part of splitTopLevel(m[1])) {
      const alias = part.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      const plain = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      const name = alias ? alias[1] : plain?.[1];
      if (name && !NOT_NAMES.has(name)) set.add(name);
    }
  }
  // 形参里带嵌套括号（默认值 Date.now() 之类）时上面那条匹配不到，这里用配平扫描补一遍
  for (const m of masked.matchAll(/\b(?:async\s+)?function\s*[A-Za-z_$]*\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    addParamNamesInto(signatureText(masked, open), set);
  }
  for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) set.add(m[1]);
  for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\s*\([^()]{0,200}\)\s*\{/g)) set.add(m[1]);
  return set;
}

// ── 导出表 ─────────────────────────────────────────────────────────────────
export function buildExportMap(files) {
  const byName = new Map(); // name -> Set(file)
  const add = (name, file) => {
    if (!name) return;
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(file);
  };
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const masked = maskSource(src);
    for (const m of masked.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1], file);
    for (const m of masked.matchAll(/\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1], file);
    for (const m of masked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const alias = piece.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        add(alias ? alias[1] : piece.split(/\s+/)[0], file);
      }
    }
  }
  return byName;
}

// ── A. ctx 契约 ────────────────────────────────────────────────────────────
/** 取了配平括号内容的签名文本（从 '(' 后开始） */
function signatureText(masked, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return masked.slice(openParenIndex + 1, i);
    }
  }
  return masked.slice(openParenIndex + 1);
}

/**
 * 每个工厂声明的「必填」依赖：签名解构 + 该函数体内的 `const {...} = ctx;`。
 * 自带默认值（`a = 1`）的不算必填——调用点不传是合法的。
 * 按工厂分桶：同一文件里两个工厂的依赖不能互相污染（runtime-state 踩过）。
 */
export function factoriesOf(src) {
  const masked = maskSource(src);
  const out = new Map();
  for (const m of masked.matchAll(/export\s+function\s+(create[A-Za-z0-9_$]*)\s*\(/g)) {
    const factory = m[1];
    const open = m.index + m[0].length - 1;
    const sig = signatureText(masked, open);
    const need = new Map(); // 属性名 -> 绑定名（判断兜底用法时用绑定名）
    const collect = (fields) => {
      for (const pair of fields.pairs) {
        if (pair.optional) continue;
        need.set(pair.key, pair.binding);
      }
    };
    const braceAt = sig.indexOf('{');
    if (braceAt !== -1) {
      const { inner } = balancedBrace(sig, braceAt);
      collect(parseDestructureFields(inner));
    }
    const bodyOpen = masked.indexOf('{', open + 1 + sig.length);
    let body = '';
    if (bodyOpen !== -1) {
      const balanced = balancedBrace(masked, bodyOpen);
      body = balanced.inner;
      for (const d of body.matchAll(/\bconst\s*\{/g)) {
        const at = d.index + d[0].length - 1;
        const { inner, end: e } = balancedBrace(body, at);
        if (!/^\s*=\s*ctx\s*;/.test(body.slice(e, e + 20))) continue;
        collect(parseDestructureFields(inner));
      }
    }
    // 用法兜底：`dep ?? x` / `dep || x` / `typeof dep` / `dep?.()` 说明它本来就是可选注入
    for (const [key, binding] of [...need]) {
      const re = new RegExp(`\\b${binding}\\s*(?:\\?\\?|\\|\\||\\?\\.)`);
      if (re.test(body) || new RegExp(`typeof\\s+${binding}\\b`).test(body)) need.delete(key);
    }
    if (need.size) out.set(factory, need);
  }
  return out;
}

/** 从 `{...}` 里取顶层键；遇到 ...spread 返回 { unverifiable:true } */
export function objectLiteralKeys(text) {
  // text 以 '{' 开头
  let depth = 0;
  const chunks = [];
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') { depth += 1; if (depth === 1 && c === '{') continue; }
    else if (c === '}' || c === ')' || c === ']') { depth -= 1; if (depth === 0) break; }
    if (c === ',' && depth === 1) { chunks.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) chunks.push(cur);
  const keys = new Set();
  let unverifiable = false;
  for (const raw of chunks) {
    const chunk = raw.trim();
    if (!chunk) continue;
    if (chunk.startsWith('...')) { unverifiable = true; continue; }
    let m = chunk.match(/^(?:get|set|async)\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m) { keys.add(m[1]); continue; }
    m = chunk.match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (m) { keys.add(m[1]); continue; }
    m = chunk.match(/^['"]([A-Za-z_$][\w$]*)['"]\s*:/);
    if (m) { keys.add(m[1]); continue; }
    m = chunk.match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (m) { keys.add(m[1]); continue; }
    m = chunk.match(/^([A-Za-z_$][\w$]*)\s*$/);
    if (m) { keys.add(m[1]); continue; }
    unverifiable = true;
  }
  return { keys, unverifiable };
}

export function auditCtxContracts(files) {
  const issues = [];
  const byFile = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const maskedByFile = new Map([...byFile].map(([f, s]) => [f, maskSource(s)]));

  for (const file of files) {
    const factories = factoriesOf(byFile.get(file));
    if (!factories.size) continue;
    for (const [factory, need] of factories) {
      const callSites = [];
      for (const other of files) {
        const masked = maskedByFile.get(other);
        const re = new RegExp(`(?<![.\\w$])${factory}\\s*\\(\\s*\\{`, 'g');
        for (const m of masked.matchAll(re)) {
          const braceStart = m.index + m[0].length - 1;
          // 截出配平的 {} 
          let depth = 0;
          let end = braceStart;
          for (; end < masked.length; end += 1) {
            if (masked[end] === '{') depth += 1;
            else if (masked[end] === '}') { depth -= 1; if (depth === 0) { end += 1; break; } }
          }
          callSites.push({ file: other, line: lineOf(masked, m.index), literal: masked.slice(braceStart, end) });
        }
      }
      if (!callSites.length) continue; // 无人调用的工厂不在本检查范围
      const verifiable = callSites.filter((cs) => !objectLiteralKeys(cs.literal).unverifiable);
      if (!verifiable.length) continue;
      const provided = new Set();
      for (const cs of verifiable) for (const key of objectLiteralKeys(cs.literal).keys) provided.add(key);
      for (const [dep] of need) {
        if (provided.has(dep)) continue;
        const cs = verifiable[0];
        issues.push({
          kind: 'ctx-missing',
          file: path.relative(ROOT, file).replaceAll('\\', '/'),
          factory,
          name: dep,
          at: `${path.relative(ROOT, cs.file).replaceAll('\\', '/')}:${cs.line}`,
        });
      }
    }
  }
  return issues;
}

// ── B. 跨模块调用未 import ─────────────────────────────────────────────────
const JS_GLOBALS = new Set(('globalThis undefined NaN Infinity console process Buffer URL URLSearchParams ' +
  'setTimeout clearTimeout setInterval clearInterval setImmediate queueMicrotask structuredClone fetch ' +
  'Promise JSON Math Date Error TypeError RangeError SyntaxError Object Array Map Set WeakMap WeakSet ' +
  'String Number Boolean BigInt Symbol RegExp Function Intl AbortController AbortSignal TextDecoder ' +
  'TextEncoder Uint8Array Buffer require module exports __dirname __filename arguments eval isNaN ' +
  'parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI decodeURI atob btoa crypto ' +
  'Atomics SharedArrayBuffer Int8Array Int16Array Int32Array Uint16Array Uint32Array Float32Array ' +
  'Float64Array BigInt64Array BigUint64Array ArrayBuffer DataView Worker Event EventTarget MessagePort ' +
  'MessageChannel WebSocket Headers Request Response FormData Blob EventSource ' +
  'performance localStorage').split(/\s+/));

const KEYWORDS = new Set(('if else for while do return const let var break continue switch case try catch ' +
  'finally throw import export from as of in instanceof void delete yield static extends class function ' +
  'await async new this super typeof default debugger with enum implements interface package private ' +
  'protected public').split(/\s+/));

export function auditDanglingCalls(files, exportMap) {
  const issues = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const masked = maskSource(src);
    const local = declaredNames(src);
    const selfExports = new Set();
    for (const [name, owners] of exportMap) {
      if (owners.has(file)) selfExports.add(name);
    }
    for (const m of masked.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (local.has(name) || selfExports.has(name) || JS_GLOBALS.has(name)) continue;
      if (!exportMap.has(name)) continue;
      const idx = m.index + m[1].length;
      const before = masked.slice(Math.max(0, idx - 12), idx);
      if (/function\s*$/.test(before) || /class\s*$/.test(before)) continue;
      // 对象方法简写：{ foo(...) {  或 , foo(...) {
      if (/[{,]\s*$/.test(before)) {
        let depth = 0;
        let i = idx + name.length;
        while (i < masked.length && masked[i] !== '(') i += 1;
        for (; i < masked.length; i += 1) {
          if (masked[i] === '(') depth += 1;
          else if (masked[i] === ')') { depth -= 1; if (depth === 0) break; }
        }
        const after = masked.slice(i + 1, i + 6);
        if (/^\s*\{/.test(after)) continue;
      }
      const owners = [...exportMap.get(name)].map((f) => path.relative(ROOT, f).replaceAll('\\', '/'));
      issues.push({
        kind: 'dangling-call',
        file: path.relative(ROOT, file).replaceAll('\\', '/'),
        line: lineOf(masked, idx),
        name,
        definedIn: owners.slice(0, 2).join(', '),
      });
    }
  }
  return issues;
}

// ── C. 对象简写引用了未声明标识符 ───────────────────────────────────────────
// 2026-11-02 的实例：getMessageIntake({ ..., isQuoteTargetOwner, isQuoteTargetSelf, ... })
// 这两个名字既没 import 也没包装，对象构造时直接 ReferenceError（每条入站消息都会走到）。
// 简写（`name,`）是最容易在搬代码时漏接的一种写法，单查它误报率很低。
export function auditShorthandRefs(files) {
  const issues = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const masked = maskSource(src);
    const local = declaredNames(src);
    const lines = masked.split('\n');
    const rawLines = src.split('\n');
    let inExportBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // export { a, b } 的成员列表不是"对象简写"，跳过整块
      if (/^\s*(?:export|import)\s*\{/.test(line)) inExportBlock = !line.includes('}');
      else if (inExportBlock) { if (line.includes('}')) inExportBlock = false; continue; }
      const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*,\s*(?:\/\/.*)?$/);
      if (!m) continue;
      const name = m[1];
      if (local.has(name) || JS_GLOBALS.has(name) || NOT_NAMES.has(name)) continue;
      issues.push({
        kind: 'shorthand-undeclared',
        file: path.relative(ROOT, file).replaceAll('\\', '/'),
        line: i + 1,
        name,
        text: String(rawLines[i] ?? '').trim().slice(0, 80),
      });
    }
  }
  return issues;
}

// ── D. 裸标识符引用了未声明的名字 ───────────────────────────────────────────
// 这是 A/B/C 之外最常见的一类外提事故：`if (!slangStoreWritable)` 里那个变量原来是
// app.mjs 的闭包变量，搬出来就成了未声明标识符——每次调用都 ReferenceError，
// 被外层 try/catch 吞掉就变成"功能静默失效"（黑话库永不上盘）。
export function auditUndeclaredRefs(files) {
  const issues = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const masked = maskSource(src);
    const local = declaredNames(src);
    const lines = masked.split('\n');
    let inImportExportBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(?:export|import)\s*\{/.test(line)) {
        if (!line.includes('}')) inImportExportBlock = true;
        continue; // 单行 import/export 也是"成员表"，不是裸引用
      }
      else if (inImportExportBlock) { if (line.includes('}')) inImportExportBlock = false; continue; }
      for (const m of line.matchAll(/(?<![.\w$\\])([A-Za-z_$][\w$]*)(?![\w$])/g)) {
        const name = m[1];
        if (name === '$') continue; // 模板插值留下的 `$`（遮罩保留）
        // 短名（g/n/s/d/i 等）是已知噪声：循环变量、解构残留、正则转义残片。
        // 但 fs/os/path/url/db 这类**模块别名**必须照查——social-format 里裸用 `fs.appendFileSync`
        // 就是被这条长度过滤漏掉的（兜底写库路径永远 ReferenceError）。
        if (name.length < 6 && !SHORT_SUSPECT.has(name)) continue;
        if (local.has(name) || JS_GLOBALS.has(name) || NOT_NAMES.has(name) || KEYWORDS.has(name)) continue;
        const after = line.slice(m.index + name.length);
        if (/^\s*:/.test(after)) continue;   // 属性键 / label / case
        if (/^\s*\(/.test(after)) {
          // [CALL-GAP] 以前这里直接 continue（"函数调用交给 check B"），但 check B 只认
          // **别的模块 export 的名字**；调用 main() 里未导出的局部函数（如 readRoleState）
          // 两边都不报 → 每次发送都 ReferenceError 却审计全绿。
          // 现在只有"对象/类里的方法定义"才跳过，其余裸调用按引用检查。
          const before = line.slice(0, m.index);
          const beforeSig = before.replace(/(?:async|static|get|set)\s+$/, '');
          const isKeyPos = /[{,]\s*$/.test(beforeSig);
          if (isKeyPos) {
            // 方法定义：name(...) {   → 不是引用
            let depth = 0;
            let k = m.index + name.length;
            for (; k < line.length; k += 1) {
              if (line[k] === '(') depth += 1;
              else if (line[k] === ')') { depth -= 1; if (depth === 0) { k += 1; break; } }
            }
            if (/^\s*\{/.test(line.slice(k))) continue;
          }
        }
        if (/^\s*=>/.test(after)) continue;
        if (/^\s*=/.test(after) && /[,[{]\s*$/.test(line.slice(0, m.index))) continue; // { a = 1 } 默认值
        issues.push({
          kind: 'undeclared-ref',
          file: path.relative(ROOT, file).replaceAll('\\', '/'),
          line: i + 1,
          name,
          text: line.trim().slice(0, 90),
        });
      }
    }
  }
  return issues;
}

// ── 断链 import 检测 ───────────────────────────────────────────────────────
// [BROKEN-IMPORT] 此前 import 解析只提取名字、从不校验目标文件是否存在；删/改名一个模块后，
// 只要没有测试顺着 import 链触达它，CI 全绿。这里补上静态校验（动态拼接路径无法定位的跳过）。
function resolveImportExists(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 非相对（node_modules / 裸模块）不查
  const clean = String(spec).split('?')[0].split('#')[0];
  if (!clean || clean.endsWith('/')) return null; // 动态拼接 import(\`./x/${v}\`) 无法静态定位
  const base = path.resolve(path.dirname(fromFile), clean);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    try { if (fs.statSync(candidate).isFile()) return true; } catch { /* 不存在 */ }
  }
  return false;
}

function auditBrokenImports(files) {
  const issues = [];
  const importRe = [
    /^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*`([^`]*)`/g,
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [];
    for (const re of importRe) for (const m of src.matchAll(re)) specs.push(String(m[1]).split('${')[0]);
    for (const spec of specs) {
      if (spec && spec.startsWith('.') && !resolveImportExists(file, spec)) {
        issues.push({ kind: 'broken-import', file: path.relative(ROOT, file).replaceAll('\\', '/'), name: spec, text: `断链 import：${spec}` });
      }
    }
  }
  return issues;
}

// ── CLI ────────────────────────────────────────────────────────────────────
export function runAudit(files = listSources()) {
  const exportMap = buildExportMap(files);
  const ctxIssues = auditCtxContracts(files);
  const callIssues = auditDanglingCalls(files, exportMap);
  const shorthandIssues = auditShorthandRefs(files);
  const undeclaredIssues = auditUndeclaredRefs(files);
  const brokenImportIssues = auditBrokenImports(files);
  return {
    files: files.length,
    exports: exportMap.size,
    issues: [...ctxIssues, ...callIssues, ...shorthandIssues, ...undeclaredIssues, ...brokenImportIssues],
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const wantJson = process.argv.includes('--json');
  const result = runAudit();
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`接线审计：${result.files} 个源码文件 / ${result.exports} 个导出名`);
    if (!result.issues.length) {
      console.log('✅ 无接线缺口（ctx 契约完整、无悬空调用、无未声明引用）');
    } else {
      for (const issue of result.issues) {
        if (issue.kind === 'ctx-missing') {
          console.log(`❌ ctx 缺口  ${issue.file}  ${issue.factory} 缺「${issue.name}」（调用点 ${issue.at} 未提供）`);
        } else if (issue.kind === 'shorthand-undeclared') {
          console.log(`❌ 简写未声明  ${issue.file}:${issue.line}  ${issue.name}  ← 对象里的 { ${issue.name} } 既没 import 也没定义`);
        } else if (issue.kind === 'broken-import') {
          console.log(`❌ 断链 import  ${issue.file}  ${issue.name}  ← 指向不存在的文件（CI 此前检测不到）`);
        } else {
          console.log(`❌ 悬空调用  ${issue.file}:${issue.line}  ${issue.name}( )  ← 定义于 ${issue.definedIn}，但本文件没 import`);
        }
      }
    }
  }
  process.exit(result.issues.length ? 1 : 0);
}
