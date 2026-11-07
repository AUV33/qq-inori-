// 人格卡与二代仿真预设的「文件层」。
//
// 从 app.mjs 搬出（P3-1a，2026-10-31）：原来这两块（roles/*.md 的读写/校验/摘要，
// dsh/agent-presets/*/agent.cordis.yml 的读取/备份/状态）和桥接的会话调度焊在一个文件里。
// 它们只做文件 IO，不碰 QQ/DSH 运行时，搬出来后可以独立用临时目录做单测。
//
// 边界：
//   · 本模块不 import app.mjs、不持有桥接状态；
//   · root / stateDir 由调用方注入（测试可指到临时目录）；
//   · 唯一的易变输入是「人格注入上限」——由 getInjectMaxChars() 读当前值，避免复制一份会漂移的状态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats } from './role-card.js';
import { extractPresetPrefix } from './preset-prompt.js';

export const ROLE_NAME_MAX = 40;
export const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），
// 可用 config.json 的 role.maxInjectChars 调整（1000~20000）。
export const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;

const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_KEEP = 10;

/** 把配置里的人格注入上限校正到允许范围（1000~20000）。 */
export function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}

/**
 * 创建人格/预设文件仓库。
 * @param {object} deps
 * @param {string} deps.root 桥接根目录（qq-bridge）
 * @param {string} deps.stateDir 运行期状态目录
 * @param {(file: string, text: string) => void} deps.atomicWriteText 原子写（app 注入，保持原写入语义）
 * @param {(raw: unknown) => string} deps.sanitizeRoleName 人格名净化（app 注入）
 * @param {() => number} deps.getInjectMaxChars 当前人格注入上限（动态读，不冻结）
 */
export function createRolePresetStore({
  root,
  stateDir,
  atomicWriteText,
  sanitizeRoleName,
  getInjectMaxChars = () => ROLE_INJECT_MAX_CHARS_DEFAULT,
}) {
  const ROLES_DIR = path.join(root, 'roles');
  const PRESET_BACKUP_DIR = path.join(stateDir, 'preset-backups');

  function listRoles() {
    try {
      return fs.readdirSync(ROLES_DIR)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => f.slice(0, -3))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      return [];
    }
  }

  function roleFilePath(name) {
    return path.join(ROLES_DIR, name + '.md');
  }

  function firstMeaningfulLine(content) {
    for (const line of String(content ?? '').split('\n')) {
      const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (t) return t.slice(0, 80);
    }
    return '';
  }

  function roleWarnings(content, mode = 'v2') {
    const text = String(content ?? '');
    const warnings = [];
    const stats = roleCharStats(text);
    const injected = mode === 'v1' ? stats.v1 : stats.v2;
    const limit = getInjectMaxChars();
    if (injected > limit) {
      warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${limit} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
    }
    // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
    const untagged = parseRoleSections(text)
      .filter((section) => section.mode === 'all')
      .map((section) => section.lines.join('\n'))
      .join('\n');
    if (GEN1_ROLE_LINE_RE.test(untagged)) {
      warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
    }
    if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
      warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
    }
    return warnings;
  }

  function roleSummaries() {
    return listRoles().map((name) => {
      const file = roleFilePath(name);
      try {
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file, 'utf8');
        const stats = roleCharStats(content);
        const limit = getInjectMaxChars();
        return {
          name,
          bytes: stat.size,
          chars: content.length,
          lines: content.split('\n').length,
          mtime: stat.mtimeMs,
          excerpt: firstMeaningfulLine(content),
          // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
          injectedV1: Math.min(stats.v1, limit),
          injectedV2: Math.min(stats.v2, limit),
          charsV1: stats.v1,
          charsV2: stats.v2,
          hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
          truncated: stats.v1 > limit || stats.v2 > limit,
          warnings: roleWarnings(content).length,
        };
      } catch {
        return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
      }
    });
  }

  function validateRoleName(raw) {
    const name = sanitizeRoleName(raw);
    if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
    if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
    if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
    if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
    return name;
  }

  function validateRoleContent(raw) {
    const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    if (!content) throw new Error('人格内容不能为空');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > ROLE_CONTENT_MAX_BYTES) {
      throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
    }
    return content;
  }

  function readRoleContent(name) {
    return fs.readFileSync(roleFilePath(name), 'utf8');
  }

  function writeRoleContent(name, content, { exclusive = false } = {}) {
    fs.mkdirSync(ROLES_DIR, { recursive: true });
    const body = content + (content.endsWith('\n') ? '' : '\n');
    if (exclusive) {
      // [TOCTOU-FIX] 创建人格用 wx 独占：existsSync 之后两个并发请求仍可能互相覆盖。
      fs.writeFileSync(roleFilePath(name), body, { encoding: 'utf8', flag: 'wx' });
      return;
    }
    atomicWriteText(roleFilePath(name), body);
  }

  // ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
  // 与「人格」层的边界：
  //   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
  //   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
  // 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
  // 人格层由桥接每条消息注入，保存即生效。

  function presetSourceYaml(name) {
    return path.join(root, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
  }

  function dshHomeDir() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  }

  function installedPresetYaml(name) {
    return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
  }

  // 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
  // （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
  // 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
  // "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
  // 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
  // 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

  function readPresetPromptText(name) {
    const file = presetSourceYaml(name);
    if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(root, file)}`);
    const text = fs.readFileSync(file, 'utf8');
    const prefix = extractPresetPrefix(text);
    if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
    return { text, prefix };
  }

  // 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
  // 不加前缀会让「还原」列到另一个预设的备份。
  function presetBackupPrefix(name) {
    return `${name}.${path.basename(presetSourceYaml(name))}`;
  }

  function backupPresetFile(name) {
    const file = presetSourceYaml(name);
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
    fs.copyFileSync(file, dest);
    const prefix = presetBackupPrefix(name) + '.';
    const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
      try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'role-preset-store.mjs:216'); }
    }
    return dest;
  }

  function listPresetBackups(name) {
    try {
      const prefix = presetBackupPrefix(name) + '.';
      return fs.readdirSync(PRESET_BACKUP_DIR)
        .filter((f) => f.startsWith(prefix))
        .sort().reverse()
        .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
    } catch {
      return [];
    }
  }

  function presetStatus(name) {
    // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
    // （路径已经写在服务端日志里，排查时看日志即可）。
    return {
      preset: name,
      label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
      sourceFile: path.relative(root, presetSourceYaml(name)),
      installed: fs.existsSync(installedPresetYaml(name)),
      requiresRestart: true,
    };
  }

  return {
    ROLES_DIR,
    ROLE_NAME_MAX,
    ROLE_CONTENT_MAX_BYTES,
    ROLE_INJECT_MAX_CHARS_DEFAULT,
    PRESET_NAMES,
    listRoles,
    roleFilePath,
    firstMeaningfulLine,
    roleWarnings,
    roleSummaries,
    validateRoleName,
    validateRoleContent,
    readRoleContent,
    writeRoleContent,
    presetSourceYaml,
    dshHomeDir,
    installedPresetYaml,
    // [WIRING-FIX] 2026-11-03：consoleDeps 的 PRESET_BACKUP_DIR getter 原先引用未声明标识符，
    // console-server 备份预设时一读就 ReferenceError。目录归本模块所有，从返回值暴露。
    PRESET_BACKUP_DIR,
    readPresetPromptText,
    presetBackupPrefix,
    backupPresetFile,
    listPresetBackups,
    presetStatus,
  };
}
