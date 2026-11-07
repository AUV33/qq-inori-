// 发布前隐私与敏感信息扫描（**离线、只读、不联网**）。
//
// 为什么需要它：这个项目在一台真实机器上跑过，工作树里散落着真实 QQ 号、群号、本机绝对路径、
// 令牌、以及个人化的人格卡内容。任何一次"忘了 gitignore 就直接推"都会把这些永久写进公开仓库历史
// ——而 Git 历史里的东西删提交是删不掉的（还会被 fork 保留）。
//
// 工作方式：扫描**将要被提交的内容**（`git ls-files` 的文件 + 未跟踪但没被 ignore 的文件），
// 逐条匹配规则；命中即失败（退出码 1），并只打印**脱敏后的片段**（绝不回显凭据本身）。
//
// [REPO-WIDE] 扫描根是**仓库根**，不是脚本所在的 qq-bridge/。此前 ROOT 指向 qq-bridge/，
// 于是 ai-companion-kit/、docs/、scripts/、dsh-plugins/ 全部在闸门外——一个已提交的
// `sk-` API key 在 kit 的遗留自测脚本里躺了两个提交而扫描一直报绿。发布闸门必须覆盖
// 所有会被 push 的目录；下面用 rulePaths() 兼容历史规则里「相对 qq-bridge/」的路径写法。
//
// 用法：
//   node scripts/privacy-scan.mjs                # 扫描整个仓库工作树（推荐：提交前/发布前）
//   node scripts/privacy-scan.mjs --tracked-only # 只扫 git 已跟踪文件
//   node scripts/privacy-scan.mjs --json         # 机读输出
//   node scripts/privacy-scan.mjs --root=<dir>   # 覆盖扫描根（仅供回归测试使用）
//
// 规则来源：`scripts/privacy-rules.json`（可自己加；里面的值是**你机器上的真实标识**，不入库）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootArg = args.find((a) => a.startsWith('--root='));
// 默认扫描根 = 仓库根（qq-bridge/scripts/ 的上两级）。
const ROOT = rootArg ? path.resolve(rootArg.slice('--root='.length)) : path.resolve(__dirname, '../..');
const RULES_FILE = path.join(__dirname, 'privacy-rules.json');
const trackedOnly = args.includes('--tracked-only');
const asJson = args.includes('--json');
// 强制走目录遍历（回归测试用：临时目录不在 git 仓库里，且不能依赖宿主环境是否有 .git）。
const noGit = args.includes('--no-git');
// [RUNTIME-PII] 运行时档案扫描（只报告，不门禁）：people.json / state 下的明文 QQ/手机号/邮箱/本机路径。
const runtimeOnly = args.includes('--runtime');
const runtimeDirArg = args.find((a) => a.startsWith('--runtime-dir='));
const runtimeFail = args.includes('--fail-on-runtime');
if (runtimeOnly) {
  const dir = runtimeDirArg ? path.resolve(runtimeDirArg.slice('--runtime-dir='.length)) : path.resolve(ROOT, 'data', 'state');
  const runtime = scanRuntimeDir(dir);
  if (asJson) console.log(JSON.stringify(runtime, null, 2));
  else {
    console.log(`[privacy-scan:runtime] 目录：${runtime.dir}（${runtime.files} 个文件）`);
    if (!runtime.findings.length) console.log('[privacy-scan:runtime] ✅ 未发现明文 PII 模式。');
    else {
      console.log(`[privacy-scan:runtime] ⚠️ 发现 ${runtime.findings.length} 处（只报告，不回显值）：`);
      for (const f of runtime.findings) console.log(`   - ${f.rule} × ${f.count} → ${f.file}`);
      console.log('[privacy-scan:runtime] 这是本机私有档案；不要提交 data/state。需要门禁时加 --fail-on-runtime。');
    }
  }
  process.exit(runtimeFail && runtime.findings.length ? 1 : 0);
}

// [NEVER-ALLOW] 凭据类规则不允许被 allowPaths 的「整文件放行」豁免。
// allowPaths 里留着一批历史前缀（scripts/probe- / scripts/test- …），**新增文件会自动落进去**；
// 若连凭据规则一起豁免，等于「往 probe-xxx.mjs 里写个 key 就永远扫不出来」——这正是
// kit 的 sk- key 能躺两个提交没被发现的同构问题。这四类规则只能走 allowRules 的
// 「文件 + 规则名」精确放行，且每条都要人工核对过内容。
const NEVER_ALLOW = new Set([
  'API key 字面量（sk-）',
  '疑似令牌/密钥（高熵串）',
  '私钥头',
  '带凭据的 URL',
]);

// 默认规则：即使没有 privacy-rules.json 也能挡住最常见的一类泄漏。
const DEFAULT_RULES = {
  comment: '默认规则。规则路径可写「相对仓库根」或「相对 qq-bridge/」（兼容历史）。请把 privacy-rules.json 加进 .gitignore（它含你的真实 QQ 号/路径），本文件是脱敏模板。',
  deny: [
    // [SK-KEY] 明确抓模型厂商 API key 字面量。不能只靠「高熵串」：那条规则带
    // requireNonHex，而 sk- 后面常跟纯小写 hex，很容易被误判成噪声而放行。
    // 这类凭据一旦进历史就必须轮换，删文件是没用的。
    // noNoise：真实 key 常是「sk- + 小写 hex」，会被 isNoise 的 /^[a-z0-9._-]+$/
    // 当成文件名/包名过滤掉。这条规则必须绕开通用噪声过滤，否则等于没写。
    { name: 'API key 字面量（sk-）', pattern: 'sk-[A-Za-z0-9]{16,}', flags: '', noNoise: true },
    { name: '本机绝对路径（Windows 用户目录）', pattern: '[A-Za-z]:\\\\Users\\\\[^\\\\\\s"\'`]{2,}', flags: 'i' },
    { name: '本机绝对路径（Windows 用户目录，正斜杠）', pattern: '[A-Za-z]:/Users/[^/\\s"\'`]{2,}', flags: 'i' },
    { name: '本机绝对路径（非系统盘的顶层目录）', pattern: '(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\\\[^\\\\\\s"\'`|<>]{2,}\\\\', flags: 'i' },
    // [NUMERIC-RULE] numeric:true 让 isNoise 不要把它当"常量/文件名"过滤掉——
    // 旧版 isNoise 的 /^[A-Z0-9_]+$/ 会把纯数字全部当噪声，这条规则实际上从未报过任何东西。
    { name: 'QQ 号/群号（9-10 位连续数字）', pattern: '(?<![0-9])[1-9][0-9]{8,9}(?![0-9])', flags: '', numeric: true },
    // 真实凭据是**高熵**的；`dea3ce8c408a...` 这种 40 位全 hex 是 git commit SHA，
    // 报它属于纯粹的噪音（会让整个扫描被无视）。所以只报"含非 hex 字符的长串"。
    // [FAST-TOKEN-RE] 不再用前后环视：字符类本身会把整段连续串吃下，边界自然落在
    // 非字符类上；旧写法的 lookbehind/lookahead 在 minified 文件上会触发灾难性回溯
    // （实测 10s/文件，整轮扫描 3 分钟还没完）。
    { name: '疑似令牌/密钥（高熵串）', pattern: '[0-9a-zA-Z_-]{32,}', flags: '', requireNonHex: true },
    // 凭据赋值：**空值/占位符不算**（`accessToken: ''` 是模板常态，报它只会制造噪音）。
    { name: '疑似凭据赋值（有实际值）', pattern: '(?:access[_-]?token|api[_-]?key|password|passwd|secret)["\']?\\s*[:=]\\s*["\']?(?!(?:cfg\\.|process\\.|globalThis\\.|this\\.|undefined|null|true|false|""|\'\'))[A-Za-z0-9_\\-./+=]{12,}', flags: 'i' },
    { name: '私钥头', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: '' },
    { name: '带凭据的 URL', pattern: 'https?://[^/\\s:@]+:[^/\\s:@]+@', flags: 'i' },
  ],
  // 这些文件本来就不该进公开仓库；出现即失败（无论内容）。
  denyFiles: ['config.json', 'state/', 'audio/', '*.log', '*.bak', '*.bak-*', 'roles/*.md.bak*'],
  // 路径/整行匹配到这些就跳过（脱敏模板、示例、测试夹具、已声明含占位符的文档）。
  // 注意：这是**误报白名单**，不是"这些文件不用检查"——加入前先确认里面确实只有占位数据。
  // [NEVER-ALLOW] 从现在起，整文件放行只压「路径 / QQ 号 / 凭据赋值」这类高噪声规则；
  // 上面 NEVER_ALLOW 里的凭据规则照常扫描，前缀放行不再能让新文件里的真实 key 隐形。
  // 新增宽泛前缀请优先考虑 allowRules（文件 + 规则名），不要继续往这里堆。
  allowPaths: [
    'scripts/privacy-', 'config.example.json', 'package-lock.json', 'src/sensitive.js',
    // 测试夹具/回归脚本：里面是刻意构造的假 ID 与假凭据
    'scripts/test-', 'scripts/console-ui-', 'scripts/fixtures/', 'scripts/audit-bridge-harness.mjs',
    'scripts/check-onebot-status.mjs', 'scripts/send-test-group.mjs', 'scripts/send-voice.mjs',
    'scripts/setup-dsh.mjs', 'scripts/patch-', 'scripts/verify-', 'scripts/probe-',
    // ── 以下三项来自一次独立复核：在**全新克隆**里扫描会报 15 条命中，全部是误报，
    //    但它们此前只写在本地 privacy-rules.json（不入库）里，所以对外部验证者而言
    //    这道闸门永远是红的。把误报放进来，闸门才是可用的。
    //    逐条依据：docs/guides/PRIVACY.md 是**讲解脱敏规则**的文档，里面的
    //    `C:\Users\<名字>\…` / `https://user:pass@host` / `-----BEGIN … PRIVATE KEY-----`
    //    就是它要举例的占位符；src/bridge.js:1706 是注释里的示例 `D:\...\audio\xxx.mp3`；
    //    src/bridge.js 的 `accessToken:` 与 src/adapters/dsh-client.js 的 `secret =` 命中的都是
    //    **运行时从配置/凭据文件读取**的赋值，源码里没有任何凭据字面量。
    //    ⚠️ 代价必须说清：allowPaths 是**按文件**粒度放行的，所以 bridge.js / dsh-client.js
    //    今后新增的真实泄漏不会被扫出来。要收紧，正确做法是给扫描器加
    //    「文件 + 规则名」粒度（或让凭据规则只认高熵字面量），而不是继续往这里加文件。
    'docs/guides/PRIVACY.md',
    // 测试夹具：PNG data URI 被高熵规则误报；文件内只有合成像素，无真实媒体
    'test/test-vision-service.test.mjs',
  ],
  // [ALLOW-RULES] 比 allowPaths 细一级：只放行「这个文件的这条规则」，而不是整个文件。
  // src/bridge.js / dsh-client.js 以前被整文件放行，等于"今后新增的真实泄漏也扫不出"；
  // 现在只放行下面这些已逐条核对过的误报。
  allowRules: [
    { path: 'src/bridge.js', rule: '本机绝对路径（非系统盘的顶层目录）' },
    { path: 'src/bridge.js', rule: '疑似凭据赋值（有实际值）' },
    { path: 'src/adapters/dsh-client.js', rule: '疑似凭据赋值（有实际值）' },
    // 测试夹具里的假凭据 / base64 图片 / 带密码的示例 URL
    // 测试夹具里的 QQ 号/群号全是构造值（10001 / 123456789 之类），不是真实凭据；
    // 但 src/docs 里的必须照常报。这是"按规则放行"，不是整目录免检。
    { path: 'test/', rule: 'QQ 号/群号' },
    { path: 'test/test-dsh-client.test.mjs', rule: '疑似凭据赋值（有实际值）' },
    { path: 'test/test-snowluma-conn.test.mjs', rule: '疑似凭据赋值（有实际值）' },
    { path: 'test/test-gif-frames-fixtures.test.mjs', rule: '疑似令牌/密钥（高熵串）' },
    { path: 'test/test-image-service.test.mjs', rule: '疑似令牌/密钥（高熵串）' },
    { path: 'test/test-media-service.test.mjs', rule: '疑似令牌/密钥（高熵串）' },
    { path: 'test/test-safe-fetch.test.mjs', rule: '带凭据的 URL' },
    // 哈希常量被 9-10 位数字规则误报：2166136261 是 FNV-1a 初值，4294967296 是 2^32。
    // 逐条核对过：这两个文件里没有 QQ 号，只有这三处数字常量。
    { path: 'src/domain/memory/assoc-activation.mjs', rule: 'QQ 号/群号' },
    { path: 'src/kernel/state.mjs', rule: 'QQ 号/群号' },
    // ── 全仓扫描后新增的误报，逐条核对过内容，全部用「精确文件 + 规则名」放行 ──
    // 豆瓣话题 id 503077552 是 9 位数字，不是 QQ 号；probe 与单测指向同一个公开话题。
    { path: 'ai-companion-kit/tests/test-browse-comments.mjs', rule: 'QQ 号/群号' },
    { path: 'ai-companion-kit/tests/probe-browse-comments-live.mjs', rule: 'QQ 号/群号' },
    // 架构文档里的 JSON 示例含缓存命中字节数 301398528（9 位），不是账号。
    { path: 'docs/architecture-full.md', rule: 'QQ 号/群号' },
    // SSRF 单测构造的假 URL http://u:p@example.test/，正是「带凭据 URL 必须拒」的用例。
    { path: 'ai-companion-kit/packages/memory-mcp/test/browse-tool.test.mjs', rule: '带凭据的 URL' },
    // ── NEVER_ALLOW 生效后，原先被整文件放行的文件里的凭据类误报，逐条核对后精确放行 ──
    // lockfile 的 integrity 是 sha512 base64，高熵但不是密钥。
    { path: 'package-lock.json', rule: '疑似令牌/密钥（高熵串）' },
    // 合成 PNG 的 data URI（iVBORw0KGgo…），文件里没有真实媒体/凭据。
    { path: 'scripts/audit-bridge-harness.mjs', rule: '疑似令牌/密钥（高熵串）' },
    { path: 'test/test-vision-service.test.mjs', rule: '疑似令牌/密钥（高熵串）' },
    // 扫描器自身：注释里的备份文件名示例、以及讲解/正则里的 `https://user:pass@host` 占位符。
    { path: 'scripts/privacy-scan.mjs', rule: '疑似令牌/密钥（高熵串）' },
    { path: 'scripts/privacy-scan.mjs', rule: '带凭据的 URL' },
    { path: 'scripts/test-audit-security.mjs', rule: '带凭据的 URL' },
  ],
};

function loadRules() {
  if (!fs.existsSync(RULES_FILE)) return { ...DEFAULT_RULES, fromFile: false };
  try {
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return {
      ...DEFAULT_RULES,
      ...raw,
      deny: [...(raw.deny ?? []), ...DEFAULT_RULES.deny],
      denyFiles: [...(raw.denyFiles ?? []), ...DEFAULT_RULES.denyFiles],
      allowPaths: [...(raw.allowPaths ?? []), ...DEFAULT_RULES.allowPaths],
      allowRules: [...(raw.allowRules ?? []), ...DEFAULT_RULES.allowRules],
      fromFile: true,
    };
  } catch (error) {
    console.error(`[privacy-scan] 无法解析 ${RULES_FILE}：${error?.message ?? error}`);
    process.exit(2);
  }
}

/** 收集候选文件：git 已跟踪 + 未跟踪但未被 ignore 的。git 不可用时退化为目录遍历。 */
function listFiles() {
  const git = (a) => {
    const res = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  };
  const tracked = noGit ? null : git(['ls-files']);
  if (tracked) {
    if (trackedOnly) return { files: tracked, via: 'git ls-files' };
    const others = git(['ls-files', '--others', '--exclude-standard']) ?? [];
    return { files: [...new Set([...tracked, ...others])], via: 'git ls-files' };
  }
  // git 不可用（沙箱禁止 spawn / 没装 git / 不是仓库）：退化为目录遍历 + 读 .gitignore。
  // 这样脚本在任何环境下都能给出**有意义的**结果，而不是一句"拿不到文件列表"。
  const ignores = readGitignorePatterns();
  const out = [];
  const seen = new Set();
  const MAX_DEPTH = 24;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) return;
    // 真实存在的坑：本仓库里 `state/setup-dsh-test-home/plugins/qq-mode-console` 是一个
    // **junction**，指回仓库自身 ⇒ 朴素遍历会无限递归。所以必须显式跳过所有 reparse point
    // （junction / 符号链接）。Windows 上 Node 的 Dirent.isSymbolicLink() 对 junction 不可靠，
    // 因此这里直接看 lstat 的 ReparsePoint 属性，再用 realpath 去重兜底。
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(childRel)) continue;
      if (ignores.some((re) => re.test(childRel) || re.test(`${childRel}/`))) continue;
      const abs = path.join(dir, e.name);
      let st = null;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & 0x400) !== 0)) {
        // 0x400 = FILE_ATTRIBUTE_REPARSE_POINT
        continue;
      }
      if (st.isDirectory()) walk(abs, childRel, depth + 1);
      else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        out.push(childRel);
      }
    }
  };
  walk(ROOT, '', 0);
  return { files: out, via: `目录遍历（git 不可用，已尽力套用 .gitignore；跳过 ${seen.size} 个真实目录）` };
}

// 永远跳过的目录：依赖、缓存、git 元数据、以及**用户数据**（后者的处理方式是"出现即报错"，
// 见 denyFiles，不需要进去扫内容）。少跳一个目录就可能让扫描去读几十万行依赖代码。
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.npm-cache', '.cache', 'dist', 'build', 'coverage',
  'state', 'audio', 'assets/vendor',
]);

/** 把 .gitignore 里"简单形态"的规则转成正则（够用即可：目录名、文件名、*.ext、/path）。 */
function readGitignorePatterns() {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'); } catch { return []; }
  const out = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const p = line.replace(/^\//, '').replace(/\/$/, '');
    if (!p) continue;
    // 关键点：`*.log` 这类"只有 basename 通配"的规则要匹配**任意目录下**的同名文件，
    // 而不是拼成 `^*\.log`（那是个非法正则）。含 `/` 的规则按路径前缀匹配。
    const hasSlash = p.includes('/');
    const base = hasSlash ? p : path.basename(p);
    const baseRe = globToRe(hasSlash ? p : base).source;
    try {
      out.push(hasSlash
        ? new RegExp(`(?:^|/)${baseRe}(?:/|$)`)
        : new RegExp(`(?:^|/)${baseRe}$`));
    } catch { /* 忽略无法解析的规则 */ }
  }
  return out;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.wav', '.mp3', '.ico', '.zip', '.tgz', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.zstd']);

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mask(snippet) {
  // 只保留头尾，中间打码——报告本身不能成为泄漏源。
  const s = String(snippet).replace(/[\r\n]+/g, ' ').trim();
  if (s.length <= 12) return s.replace(/./g, '*');
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

const rules = loadRules();
// rule 留空会让 startsWith('') 恒真 → 一条 allowRules 就能放行整文件的全部规则
//（包括 NEVER_ALLOW 那四条）。直接拒绝这种配置，避免闸门被无声绕过。
for (const a of rules.allowRules ?? []) {
  if (!String(a?.rule ?? '').trim()) {
    console.error('[privacy-scan] allowRules 的 rule 不能为空；请写明要放行的具体规则名。');
    process.exit(2);
  }
}
if (process.env.QQ_BRIDGE_PRIVACY_DEBUG) console.error('[privacy-scan:debug] rules loaded');
const listed = listFiles();
if (process.env.QQ_BRIDGE_PRIVACY_DEBUG) console.error(`[privacy-scan:debug] listed ${listed.files.length} files via ${listed.via}`);
const files = listed.files;
if (!files.length) {
  console.error('[privacy-scan] 没有拿到任何文件（目录遍历失败或仓库为空）');
  process.exit(2);
}

// [RULE-PATH-COMPAT] 历史规则里的路径是「相对 qq-bridge/」写的（如 src/bridge.js、test/）。
// 扫描根提到仓库根后，文件路径变成 qq-bridge/src/bridge.js；匹配时同时尝试两种基准，
// 这样内置规则和维护者本机的 privacy-rules.json 都不必改写。新规则请一律用仓库根相对路径。
const BRIDGE_PREFIX = 'qq-bridge/';
const rulePaths = (normalized) => normalized.startsWith(BRIDGE_PREFIX)
  ? [normalized, normalized.slice(BRIDGE_PREFIX.length)]
  : [normalized];
const anyRulePath = (normalized, predicate) => rulePaths(normalized).some(predicate);

const allowRe = rules.allowPaths.map((p) => (p.includes('*') ? globToRe(p) : new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&')}`)));
// [ALLOW-RULES] path 支持前缀/glob；rule 是规则名的前缀匹配。
const allowRuleMatches = (file, ruleName) => (rules.allowRules ?? []).some((a) => {
  const ap = String(a?.path ?? '');
  if (!ap) return false;
  const pathOk = anyRulePath(file, (p) => ap.includes('*') ? globToRe(ap).test(p) : p.startsWith(ap));
  return pathOk && String(ruleName ?? '').startsWith(String(a?.rule ?? ''));
});
/** denyFiles：带 `/` 的按"任意层级下的该路径"匹配；纯文件名（config.json / *.log）按 basename 匹配。 */
function denyFileRe(glob) {
  const g = String(glob ?? '');
  if (!g) return null;
  if (g.endsWith('/')) return new RegExp(`(?:^|/)${g.slice(0, -1).replace(/[.+^${}()|[\]\\]/g, '\\$&')}(?:/|$)`);
  const bodyRe = globToRe(g).source.replace(/^\^/, '').replace(/\$$/, '');
  return new RegExp(`(?:^|/)${bodyRe}$`);
}
const denyFileRes = rules.denyFiles.map((p) => ({ glob: p, re: denyFileRe(p) }));

// 文档/测试里通用的占位账号，不是真实 QQ：10001、123456789 这类。
// 必须在扫描循环之前初始化（isNoise 会在循环里被调用，const 有 TDZ）。
const PLACEHOLDER_IDS = new Set(['10000', '10001', '123456789', '123456780', '1234567890', '222222222', '333333333', '123123123']);

const findings = [];
// [SCAN-COMPLETE] 规则迭代被上限截断时必须让闸门变红：旧实现只打 stderr 警告、
// 退出码仍看 findings，等于"没扫完也算通过"。
let scanIncomplete = 0;
for (const rel of files) {
  const normalized = rel.split(path.sep).join('/');
  // ① 文件级：本来就不该出现的文件
  for (const { glob, re } of denyFileRes) {
    if (anyRulePath(normalized, (p) => re.test(p))) findings.push({ kind: 'file', rule: `不应入库的文件（${glob}）`, file: normalized, masked: '' });
  }
  // [NEVER-ALLOW] 不再「命中整文件放行就 continue」：凭据类规则仍要跑完。
  const wholeFileAllow = allowRe.some((re) => anyRulePath(normalized, (p) => re.test(p)));
  if (BINARY_EXT.has(path.extname(normalized).toLowerCase())) continue;
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }
  if (looksBinary(buf)) continue;
  const text = buf.toString('utf8');
  // ② 内容级：一个文件里同一规则最多报 3 处（带行号），方便直接定位；不要把整文件刷屏。
  for (const rule of rules.deny) {
    if (allowRuleMatches(normalized, rule.name)) continue;
    if (wholeFileAllow && !NEVER_ALLOW.has(rule.name)) continue;
    let re;
    // [GLOBAL-REGEX] 必须带 g：旧代码信任 rule.flags，而高熵规则写的是 flags:''，
    // exec 没有 g 就不会前进，永远返回同一个噪声匹配 —— 表现为"扫了 5 秒/500k 次，
    // 但一条都没报"。这也是此前"QQ/高熵规则永远扫不出东西"的根因。
    const flags = String(rule.flags ?? '').includes('g') ? String(rule.flags) : `${rule.flags ?? ''}g`;
    try { re = new RegExp(rule.pattern, flags); }
    catch (error) { console.error(`[privacy-scan] 规则「${rule.name}」正则非法：${error.message}`); continue; }
    re.lastIndex = 0;
    let m;
    let hits = 0;       // 已上报的命中数（上限 3）
    let attempts = 0;   // 正则迭代次数（含被 isNoise 过滤掉的）
    const started = Date.now();
    // [SCAN-COST] 限额只防病态输入；正常文件远到不了。超限 → 本次扫描不完整 → 退出码 1。
    while ((m = re.exec(text)) !== null && hits < 3 && attempts < 500000 && Date.now() - started < 5000) {
      attempts += 1;
      const value = m[0];
      if (m.index === re.lastIndex) re.lastIndex += 1; // 空匹配保护
      if (isNoise(value, rule)) continue;
      hits += 1;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ kind: 'content', rule: rule.name, file: normalized, line, masked: mask(value) });
    }
    if (attempts >= 500000 || Date.now() - started >= 5000) {
      if (process.env.PRIVACY_TRACE) console.error(`[privacy-trace] ${normalized} | ${rule.name} | attempts=${attempts} | ms=${Date.now() - started}`);
      scanIncomplete += 1;
      console.error(`[privacy-scan] ⚠️ ${normalized} 的「${rule.name}」匹配过多/过慢，已提前结束该规则（本次扫描不完整，按失败处理）`);
    }
  }
}

/**
 * 噪音过滤：把**明显不是秘密**的命中挡掉。
 *
 * 为什么必须做：一个"什么都报"的扫描器等于没有扫描器——用户看两眼就不看了。
 * 这里挡掉的三类是实测出来的主要噪音源：
 *   - 全 hex 的长串：git commit SHA（`dea3ce8c408a…`）而不是密钥；
 *   - 全大写下划线的长串：环境变量名 / 常量名（`PLAYWRIGHT_MODULE`）；
 *   - 连字符/点号分隔的小写长串：文件名/包名/路径片段（`bridge.js.bak-20260821-1722-currentRoleHint`）。
 * 真凭据是**混合大小写 + 数字**的高熵串，因此下面要求"同时含小写与大写与数字"。
 */
function isNoise(value, rule) {
  // [NO-NOISE] 形如 sk-xxxxxxxx 的凭据全是小写/数字，会被下面的「文件名/包名」规则
  // 误判成噪声；显式标记的规则直接视为真实命中，不做通用过滤。
  if (rule.noNoise) return false;
  // QQ 号规则只认纯数字：下面的"常量/文件名"规则会把它全部吃掉，所以 numeric 规则先放行。
  if (rule.numeric) return PLACEHOLDER_IDS.has(String(value));
  if (rule.requireNonHex && /^[0-9a-f]+$/i.test(value)) return true;
  if (/^[A-Z0-9_]+$/.test(value)) return true;                       // 环境变量名/常量
  if (/^[a-z0-9._-]+$/.test(value)) return true;                     // 文件名/包名/路径片段
  if (/^[A-Za-z0-9]+$/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value))) return true;
  return false;
}

/**
 * 运行时 PII 扫描：只在 data/state 这类私有档案上找"明文"模式，输出计数不回显值。
 * 这不是仓库泄漏门禁（那是默认模式）；它是"她的档案里还有多少明文 PII"的审计读数。
 */
function scanRuntimeDir(dir) {
  const RUNTIME_RULES = [
    { name: 'json-key-qq', re: /"([1-9][0-9]{4,11})"\s*:/g },
    { name: 'json-field-qq', re: /"(?:qq|uin|user_?id|sender_?id|ownerQQ|qqNumber)"\s*:\s*"?([1-9][0-9]{4,11})/gi },
    { name: 'phone-cn', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
    { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { name: 'win-user-path', re: /[A-Za-z]:\\Users\\[^\\\s"']{2,}/gi },
  ];
  const findings = [];
  let files = 0;
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '_archive', '.git'].includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.(json|jsonl)$/i.test(entry.name)) continue;
      let text = '';
      try {
        const stat = fs.statSync(full);
        if (stat.size > 5 * 1024 * 1024) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      files += 1;
      const rel = path.relative(dir, full) || entry.name;
      for (const rule of RUNTIME_RULES) {
        rule.re.lastIndex = 0;
        let count = 0;
        while (rule.re.exec(text)) { count += 1; if (count > 10000) break; }
        if (count) findings.push({ file: rel, rule: rule.name, count });
      }
    }
  };
  walk(dir);
  return { dir, files, findings, total: findings.reduce((n, f) => n + f.count, 0) };
}

if (asJson) {
  console.log(JSON.stringify({ rulesFromFile: rules.fromFile, source: listed.via, scanned: files.length, findings }, null, 2));
} else {
  console.log(`[privacy-scan] 规则来源：${rules.fromFile ? 'scripts/privacy-rules.json + 内置默认' : '仅内置默认（建议补 privacy-rules.json）'}`);
  console.log(`[privacy-scan] 扫描文件数：${files.length}（来源：${listed.via}）`);
  if (!findings.length) {
    console.log('[privacy-scan] ✅ 未发现敏感信息。');
  } else {
    console.log(`[privacy-scan] ❌ 发现 ${findings.length} 处问题：`);
    for (const f of findings) {
      console.log(`   - [${f.kind}] ${f.rule} → ${f.file}${f.masked ? `  （命中片段：${f.masked}）` : ''}`);
    }
    console.log('[privacy-scan] 处理方式：① 真实数据删掉/换占位符；② 该文件本就该忽略 → 加进 .gitignore；');
    console.log('[privacy-scan] ③ 是脱敏模板/测试夹具的误报 → 加进 privacy-rules.json 的 allowPaths。');
    console.log('[privacy-scan] ⚠️ 已经提交过的内容光删文件没用：还要清历史（git filter-repo）或干脆新建仓库。');
  }
}
if (scanIncomplete && !asJson) console.error(`[privacy-scan] ❌ 有 ${scanIncomplete} 条规则被截断，扫描不完整，不能判定为通过。`);

// [AUDIT-OUT] Aliveness 完整性维要求一个独立审计来源（data/reports/security-audit.json）。
// 旧实现只往 stdout 打，该文件从未被生成 → 完整性维恒为 no-data(0.5)，等于没有这道指标。
// --out 把本次扫描结果落成机读快照；退出码仍按 findings 判定，写盘失败不影响门禁。
const outIdx = args.indexOf('--out');
if (outIdx >= 0) {
  const outFile = args[outIdx + 1] || path.resolve(ROOT, 'data', 'reports', 'security-audit.json');
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
      v: 1,
      at: new Date().toISOString(),
      scanned: files.length,
      source: listed.via,
      incomplete: scanIncomplete,
      ok: findings.length === 0 && !scanIncomplete,
      high: findings.filter((f) => String(f.rule || '').includes('token') || String(f.rule || '').includes('key')).length,
      medium: findings.length,
      low: 0,
    }, null, 2), 'utf8');
    if (!asJson) console.log(`[privacy-scan] 审计快照已写 ${outFile}`);
  } catch (error) {
    console.error(`[privacy-scan] 审计快照写入失败（不影响扫描结论）: ${error?.message ?? error}`);
  }
}
process.exitCode = (findings.length || scanIncomplete) ? 1 : 0;
