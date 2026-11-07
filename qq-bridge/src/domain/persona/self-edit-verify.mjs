// self-edit-verify.mjs · 她改自己代码时的「先验后留」规则（纯函数，无 IO）
//
// 参考 Darwin Gödel Machine / STOP 的落点：改动必须经过可计算的检查，
// 检查不过就回滚——而不是"能加载就算成功"。这里只做**判定**，执行由 console 侧注入。
//
// 纪律：
// - 只允许改代码，不许改脚本/数据/备份（否则等于自己拆护栏）
// - 入口文件要额外跑冒烟（app.mjs / bridge.js）
// - 有同名测试就一起跑（test/test-<name>.test.mjs）

export const ALLOWED_ROOTS = ['qq-bridge/src/', 'ai-companion-kit/packages/'];
export const MAX_CONTENT_BYTES = 512 * 1024;

/** 规范化成 posix 相对路径；带 ..、绝对路径、盘符的一律判非法（返回空串） */
export function normalizeRelPath(input) {
  const raw = String(input ?? '').trim().replaceAll('\\', '/');
  if (!raw) return '';
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return '';
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return '';
    parts.push(seg);
  }
  return parts.join('/');
}

/** 只允许 src 下的代码文件（.js/.mjs），且必须在允许的根里 */
export function isAllowedCodePath(rel) {
  const p = normalizeRelPath(rel);
  if (!p) return false;
  if (!/\.(m?js)$/i.test(p)) return false;
  if (!ALLOWED_ROOTS.some((r) => p.startsWith(r))) return false;
  if (p.includes('/scripts/') || p.includes('/test/') || p.includes('/node_modules/')) return false;
  return true;
}

/** 入口文件：改完必须跑冒烟（它们顶层就会加载整条链路） */
export function isEntryFile(rel) {
  const p = normalizeRelPath(rel);
  return p === 'qq-bridge/src/app.mjs' || p === 'qq-bridge/src/bridge.js';
}

/** 由变更文件推同名测试（约定 test/test-<basename>.test.mjs） */
export function testPathFor(rel) {
  const p = normalizeRelPath(rel);
  if (!p) return '';
  const base = p.split('/').pop().replace(/\.m?js$/i, '');
  return `qq-bridge/test/test-${base}.test.mjs`;
}

/**
 * 该跑哪些检查。`hasTest` 由调用方用 fs 判断后传入（保持本模块纯）。
 * @returns {Array<{kind:string,label:string}>}
 */
export function planChecks({ rel, hasTest = false } = {}) {
  const p = normalizeRelPath(rel);
  if (!isAllowedCodePath(p)) return [];
  const checks = [{ kind: 'syntax', label: 'node --check' }];
  if (isEntryFile(p)) checks.push({ kind: 'smoke', label: '入口冒烟' });
  if (hasTest) checks.push({ kind: 'test', label: '同名单测' });
  return checks;
}

/** 把检查结果折成分数：全过才 passed；任何一项失败即 failed */
export function classifyChecks(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r || r.ok !== true);
  return {
    score: failed.length === 0 && list.length > 0 ? 'passed' : 'failed',
    failed: failed.map((r) => ({ kind: r?.kind ?? 'unknown', detail: String(r?.detail ?? '').slice(0, 400) })),
  };
}

/** 改动摘要（给人看的一句话） */
export function diffStat(before, after) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  const la = a ? a.split('\n').length : 0;
  const lb = b ? b.split('\n').length : 0;
  return {
    charsBefore: [...a].length,
    charsAfter: [...b].length,
    linesBefore: la,
    linesAfter: lb,
    lineDelta: lb - la,
    changed: a !== b,
  };
}

// [F8 / L2] 静态危险模式扫描：node --check 只做语法解析，挡不住「语法合法但会干坏事」的 self-edit。
// 这里在写盘前做一层**词法感知**的门禁，默认拒绝；维护者确认无误可设
// QQ_SELF_EDIT_ALLOW_DANGEROUS=1 放行（仍记入 evolution 账本）。
//
// 旧版是「对整份源码跑正则」，两头都不准：
//   · 误报：注释里写 `eval("x")` 或 `process.env.A === "prod"` 会被当成危险代码
//   · 漏报：require('child' + '_process')、'node:child_process'、import(`child_process`)、
//     globalThis.constructor.constructor('...')()、间接 eval、Reflect.set(process.env, ...)
// 现在先做词法预处理（剥离注释、保留字符串、识别正则字面量、折叠字符串拼接），
// 再在「代码视图 + 折叠视图」两份文本上跑结构化模式。
// 说明：项目未引入 JS parser，本模块保持纯函数、零依赖，用词法归一覆盖已知绕过，
// 不谎称完整 AST 语义分析；无法静态求值的动态目标（如 import(变量)）仍靠运行时边界兜底。
// 刻意只拦最具灾难性、且在正常业务逻辑里极罕见的模式，避免误伤合法 self-edit。

/** 词法预处理：注释抹成空白（保留换行），字符串/模板串/正则字面量原样留存 */
function stripComments(source) {
  const REGEX_STARTERS = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '>', '<']);
  const KEYWORD_BEFORE_REGEX = /\b(?:return|throw|case|typeof|yield|delete|void|instanceof|in|of|new|await|else|do)\s*$/;
  let out = '';
  let lastNonSpace = '';
  let state = 'code';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '/' && n !== '/' && n !== '*' && (REGEX_STARTERS.has(lastNonSpace) || KEYWORD_BEFORE_REGEX.test(out.slice(-40)))) {
        const end = regexEndAt(source, i);
        if (end > i) { out += source.slice(i, end); i = end; continue; }
      }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; lastNonSpace = c; i += 1; continue; }
      out += c;
      if (!/\s/.test(c)) lastNonSpace = c;
      i += 1;
      continue;
    }
    if (state === 'line' || state === 'block') {
      if (state === 'line' && (c === '\n' || c === '\r')) { state = 'code'; out += c; i += 1; continue; }
      if (state === 'block' && c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' || c === '\r') ? c : ' ';
      i += 1;
      continue;
    }
    // 字符串内：转义吃掉两个字符，闭合引号回到 code
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    out += c;
    if (c === state) { state = 'code'; lastNonSpace = c; }
    i += 1;
  }
  return out;
}

/** 找到同一行内正则字面量的闭合 `/`（含 flags）；找不到返回 -1，避免吞掉后续代码 */
function regexEndAt(src, start) {
  let j = start + 1;
  let inClass = false;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') { inClass = true; j += 1; continue; }
    if (ch === ']') { inClass = false; j += 1; continue; }
    if (ch === '/' && !inClass) {
      j += 1;
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

/** 折叠 `'ch' + 'ild' + '_process'` 这类拼接，堵住字符串分片绕过模块名检测 */
function foldStringConcat(code) {
  const RE = /(['"])([^'"\\\n]*)\1\s*\+\s*(['"])([^'"\\\n]*)\3/g;
  let out = code;
  for (let round = 0; round < 6; round += 1) {
    const next = out.replace(RE, (_m, q, a, _q2, b) => `${q}${a}${b}${q}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

// 所有模式均不得带 g 标志（test 会因 lastIndex 产生跨次状态）。
const DANGEROUS_PATTERNS = [
  { re: /\beval\s*\(/, label: 'eval() 动态执行' },
  { re: /\beval\s*\)|\[\s*['"`]eval['"`]\s*\]/, label: '间接 eval / globalThis["eval"]' },
  { re: /\bnew\s+Function\s*\(/, label: 'new Function() 动态代码' },
  { re: /(?:^|[^.\w])Function\s*\(\s*['"`]/, label: 'Function() 构造器' },
  { re: /\.constructor\s*(?:\.\s*constructor|\[\s*['"`]constructor['"`]\s*\])\s*\(/, label: 'constructor.constructor() 间接取得 Function' },
  { re: /\[\s*['"`]constructor['"`]\s*\]\s*\[\s*['"`]constructor['"`]\s*\]/, label: 'constructor 链（方括号写法）' },
  { re: /\b(?:globalThis|global|window|self)\s*\[\s*['"`]Function['"`]\s*\]/, label: '全局 Function 索引' },
  { re: /['"`](?:node:)?child_process['"`]/, label: '引入 child_process（任意命令执行）' },
  { re: /['"`](?:node:)?vm['"`]|runInThisContext\s*\(|runInNewContext\s*\(|compileFunction\s*\(/, label: 'vm 模块/在宿主上下文执行代码' },
  { re: /(?:\.|\b)(?:execFileSync|execSync|spawnSync)\s*\(/, label: '同步命令执行（execFileSync/execSync/spawnSync）' },
  { re: /\bprocess\.binding\s*\(/, label: 'process.binding（绕过模块层取底层能力）' },
  { re: /\bunlinkSync\b|\brmSync\b|\brmdirSync\b/, label: '破坏性文件删除（*Sync 变体）' },
  { re: /\bfs\.(?:promises\.)?(?:unlink|rm|rmdir)\s*\(/, label: '破坏性 fs 删除' },
  { re: /process\.env\s*(?:\[[^\]]+\]|\.\w+)\s*(?<![=!<>])=(?!=)/, label: '篡改 process.env（可能动鉴权/令牌）' },
  { re: /process\s*\[\s*['"`]env['"`]\s*\]\s*(?:\[[^\]]+\]|\.\w+)?\s*(?<![=!<>])=(?!=)/, label: '篡改 process["env"]' },
  { re: /(?:Object\.assign|Reflect\.set|Reflect\.defineProperty|Reflect\.deleteProperty)\s*\(\s*process\.env/, label: '反射/批量赋值篡改 process.env' },
  { re: /\bdelete\s+process\.env\b|process\.env\s*=(?!=)/, label: '整体替换/删除 process.env' },
];

const EXIT_PATTERNS = [
  { re: /\bprocess\.exit\s*\(/, label: '非入口文件调用 process.exit（可能 kill 桥接）' },
  { re: /\bglobalThis\.process\.exit\s*\(|process\s*\[\s*['"`]exit['"`]\s*\]\s*\(/, label: '非入口文件间接调用 process.exit' },
  { re: /\bprocess\.(?:kill|abort)\s*\(/, label: '非入口文件 process.kill/abort' },
];

/**
 * @param {string} source 待写入的新内容
 * @param {{isEntry?:boolean}} [opts] 入口文件（app.mjs/bridge.js）允许 process.exit
 * @returns {string[]} 命中的危险模式标签（空数组 = 干净）
 */
export function scanDangerous(source, { isEntry = false } = {}) {
  const code = stripComments(String(source ?? ''));
  const views = [code, foldStringConcat(code)];
  const patterns = isEntry ? DANGEROUS_PATTERNS : [...DANGEROUS_PATTERNS, ...EXIT_PATTERNS];
  const hits = [];
  for (const { re, label } of patterns) {
    if (views.some((view) => re.test(view))) hits.push(label);
  }
  return [...new Set(hits)];
}
