// 人格卡热注入：读取/按模式筛小节/截断/二代兜底过滤、示例空格改写、分条断点提示。
//
// 从 app.mjs 的 main() 搬出（P3-RW-29，2026-11-01）。只读 roles/*.md，缓存按
// 文件 mtime+size+人格名 击穿；不写文件、不发消息。
import fs from 'node:fs';
import path from 'node:path';
import { GEN1_ROLE_LINE_RE, selectRoleText } from './role-card.js';

/**
 * @param {object} ctx
 */
export function createRoleHint(ctx) {
  const {
    readRoleState, sanitizeRoleName, ROLES_DIR, ROLE_STATE_FILE, getRoleInjectMaxChars,
    truncateText, conditionedRoleText, log = () => {},
  } = ctx;
  let roleHintCache = { key: '', raw: '' };
  let lastTruncateLogAt = 0;
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode, contextText = '') {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    // [COND-ROLE] 条件注入：[[?关键词|关键词2]]…[[/?]] 块只有上下文命中才注入（世界书式，想到才用）
    const filtered = conditionedRoleText(selected, contextText);
    // 二代要在【截断之前】做过兜底过滤：先截断会把超限段落里的一代遗留行留下，
    // 又把该保留的正文截掉（同一张卡在唤醒提示词与 qq_get_prompt 里长度/内容不一致的根因）。
    const cleaned = mode === 'v2' ? applyV2Rules(filtered) : filtered;
    const max = getRoleInjectMaxChars();
    if (cleaned.length > max) {
      // [ROLE-TRUNC-VISIBLE] 静默截断会让卡尾（往往是"能做什么/怎么发"）被切掉半句而没人知道。
      // 10 分钟内只记一条，避免每次唤醒刷屏。
      if (Date.now() - lastTruncateLogAt > 10 * 60 * 1000) {
        lastTruncateLogAt = Date.now();
        try { log(`[role-hint] 角色卡 ${cleaned.length} 字超过注入上限 ${max}，已截断 ${cleaned.length - max} 字（卡尾可能被切半句；改 role.maxInjectChars 或瘦身卡片）`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'role-hint.mjs:truncate'); }
      }
      return truncateText(cleaned, max);
    }
    return cleaned;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        // [URL-KEEP] 紧跟着 URL/域名时别改：把「看 https://…」改成「看，https://…」会让人以为
        // 逗号是链接的一部分（示例是给她抄的，链接要能原样粘出去）。
        const rest = chars.slice(i + 1, i + 9).join('').toLowerCase();
        const nextIsUrl = /^(https?:\/\/|www\.)/.test(rest);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked && !nextIsUrl) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  // 二代兜底过滤：整行去掉一代遗留指令；「回复示例」节把"空格分条"改写成逗号。
  // 抽成独立函数，由 roleHintForMode('v2') 统一调用——这样唤醒提示词、notify-ai、隔离会话、
  // qq_get_prompt 四条路径看到的是同一份文本（之前只有 qq_get_prompt 走这套过滤）。
  function applyV2Rules(text) {
    const lines = String(text ?? '').split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  function currentRoleHintV2() {
    return roleHintForMode('v2');
  }

  return {
    roleRawContent, roleHintForMode, currentRoleHint, isCjkLikeChar,
    convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning, currentRoleHintV2,
  };
}
