// allowlist.mjs · 名单判定（从 app.mjs 抽出，2026-11-07 Wave 2）
//
// 名单文件 allowlist.txt 一旦存在就是权威：private:<QQ> / group:<群号> 每行一条，
// `#` 注释、空行忽略。文件优先于 config.allow（见下方 allowed 的权威判定）。
//
// 抽出时逻辑逐字一致；app.mjs 仍保留模块级细委托绑定
// （readWallEntries / writeWallEntries / allowed）以守住 test-app-facade-wiring
// 的源码契约（consoleDeps 的 `get readWallEntries()` / `get writeWallEntries()` /
// `get allowed()` 要求这些标识符在 app.mjs 内可声明/导入）。
import fs from 'node:fs';
import path from 'node:path';

export function createAllowlist({ ROOT, writeTextAtomic, log }) {
  const ALLOWLIST_FILE = path.join(ROOT, 'allowlist.txt');
  let _allowFileCache = { mtimeMs: 0, allow: null };
  let _allowDivergenceWarned = null;

  /** [WALL-SYNC] 读墙文件条目（数字数组；与 loadAllowlistFile 同源，用于控制台展示/合并）。 */
  function readWallEntries() {
    try {
      const text = fs.readFileSync(ALLOWLIST_FILE, 'utf8').replace(/^\uFEFF/, '');
      const allow = { private: [], group: [] };
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = /^(private|group)\s*[:：]\s*(\d+)$/i.exec(line);
        if (!m) continue;
        const id = Number(m[2]);
        if (m[1].toLowerCase() === 'private') allow.private.push(id);
        else allow.group.push(id);
      }
      return allow;
    } catch { return null; }
  }

  /** [WALL-SYNC] 行级编辑墙文件：保留注释/行内说明；只增删会话条目。 */
  function writeWallEntries(allow) {
    const wantPrivate = new Set((allow.private ?? []).map(String));
    const wantGroup = new Set((allow.groups ?? allow.group ?? []).map(String));
    let text = '# ===== 名单 =====\n';
    try { text = fs.readFileSync(ALLOWLIST_FILE, 'utf8'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'allowlist.mjs:47'); }
    const kept = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const noComment = rawLine.replace(/#.*$/, '').trim();
      const m = /^(private|group)\s*[:：]\s*(\d+)$/i.exec(noComment);
      if (!m) { kept.push(rawLine); continue; } // 注释/空行原样保留
      const kind = m[1].toLowerCase();
      const id = String(Number(m[2]));
      if (kind === 'private') {
        if (wantPrivate.has(id)) { wantPrivate.delete(id); kept.push(rawLine); } // 保留原行（含行内注释）
      } else if (wantGroup.has(id)) { wantGroup.delete(id); kept.push(rawLine); }
      // 不在新名单里 → 删掉
    }
    for (const id of wantPrivate) kept.push('private:' + id);
    for (const id of wantGroup) kept.push('group:' + id);
    writeTextAtomic(ALLOWLIST_FILE, kept.join('\n') + '\n', { source: 'bridge/console-whitelist' });
    _allowFileCache = { mtimeMs: 0, allow: null }; // 让下一次判定读到新内容
  }

  function loadAllowlistFile() {
    try {
      const st = fs.statSync(ALLOWLIST_FILE);
      if (_allowFileCache.allow && _allowFileCache.mtimeMs === st.mtimeMs) return _allowFileCache.allow;
      const allow = { private: [], group: [], groups: [] };
      const text = fs.readFileSync(ALLOWLIST_FILE, 'utf8');
      let bad = 0;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = /^(private|group)\s*[:：]\s*(\d+)$/i.exec(line);
        if (!m) { bad += 1; continue; }
        const kind = m[1].toLowerCase();
        const id = String(Number(m[2]));
        if (kind === 'private') allow.private.push(id);
        else allow.group.push(id);
      }
      allow.groups = allow.group;
      if (bad > 0) log(`[allow] 名单文件有 ${bad} 行无法识别（格式应为 private:QQ号 或 group:群号）`);
      _allowFileCache = { mtimeMs: st.mtimeMs, allow };
      log(`[allow] 已载入名单文件 allowlist.txt：私聊 ${allow.private.length} 个，群 ${allow.group.length} 个`);
      return allow;
    } catch {
      _allowFileCache = { mtimeMs: 0, allow: null };
      return null;
    }
  }

  // [NO-SILENT] allowlist.txt 一旦存在就是权威，config.allow 整段不可达。
  // 这本身是设计（文件编辑更安全、可审计），但"改了 config 没生效"必须能看见——
  // 之前是完全静默的，结果只能靠翻代码发现。这里每种 kind 只告警一次。
  function warnAllowDivergence(cfg, kind, fileList) {
    if (!_allowDivergenceWarned) _allowDivergenceWarned = new Set();
    if (_allowDivergenceWarned.has(kind)) return;
    _allowDivergenceWarned.add(kind);
    try {
      const cfgList = (cfg.allow?.[kind] ?? cfg.allow?.[kind + 's'] ?? []).map(String);
      const fileSet = new Set(fileList.map(String));
      const onlyCfg = cfgList.filter((x) => !fileSet.has(x));
      const onlyFile = [...fileSet].filter((x) => !cfgList.includes(x));
      if (onlyCfg.length || onlyFile.length) {
        log(`[allow] ⚠ config.allow.${kind} 与 allowlist.txt 不一致，实际以文件为准：只在配置 ${onlyCfg.join(',') || '无'}；只在文件 ${onlyFile.join(',') || '无'}`);
      }
    } catch (error) { /* 告警失败不影响放行 */ globalThis.__ignoredCatch?.(error, 'allowlist.mjs:96'); }
  }

  function allowed(kind, id, cfg) {
    // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
    // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
    const s = String(id);
    const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
    if (denyList.map(String).includes(s)) return false;
    // 名单文件优先（存在且非空即生效）
    const fileAllow = loadAllowlistFile();
    if (fileAllow) {
      const fileList = fileAllow[kind] ?? fileAllow[kind + 's'] ?? [];
      warnAllowDivergence(cfg, kind, fileList);
      // 文件一旦生效就是**权威**：某种类没写 → 该类一律不接收。
      // 不能因为「私聊写了、群没写」就让群回落到 allowAllWhenEmpty（那会变成漏口）。
      return fileList.map(String).includes(s);
    }
    const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
    if (allowList.length > 0) return allowList.map(String).includes(s);
    return cfg.allowAllWhenEmpty;
  }

  return { readWallEntries, writeWallEntries, loadAllowlistFile, warnAllowDivergence, allowed };
}
