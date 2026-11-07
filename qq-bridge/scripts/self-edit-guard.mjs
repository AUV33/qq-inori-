// self-edit-guard.mjs · 她改自己代码的护栏
//
// 背景：owner 私聊的 qq-chat-admin preset 给了她 pwsh/read/write/edit，
// 她能改 <repo> 下的任何文件，包括 bridge.js 自己。改坏了桥接就崩，
// 得人手救。这个守护进程负责：
//   1) 基线：首次运行把所有核心 .js 当前版本存一份"好版本"
//   2) 监控：轮询核心文件 mtime，一有变化立刻 node --check
//   3) 改坏自动回滚：校验失败 → 用最近一个通过校验的版本覆盖回去
//   4) 不自动重启：符合"她改完等主人下令重启"的约定
//
// 只监控代码（src/*.js）；data/roles/prompts 是热加载的安全区，不归它管。
//
// 用法：node qq-bridge/scripts/self-edit-guard.mjs
// （建议放进计划任务或 silent vbs 后台跑）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';
import { collectCodeFiles, backupNameFor, needsSmoke } from './guard-scan.mjs';

const BRIDGE = `${PROJECT_ROOT}/qq-bridge`;
const SRC = path.join(BRIDGE, 'src');
const BACKUP = `${PROJECT_ROOT}/_src/backups`;
const LOG = `${PROJECT_ROOT}/_src/self-edit-guard.log`;
// [EVOLUTION] 自改日志：她每次改自己（通过语法检查的改动）都记一条，供"进化"回顾
const EVOLUTION = `${PROJECT_ROOT}/data/state/evolution.jsonl`;
const POLL_MS = 3000;
const EXT = new Set(['.js', '.mjs']);

// [EVO-DEDUP] 同一文件、同一结果、同一秒级变化在 5 秒内只记一条：
// 轮询会在一次保存里多次触发 mtime/size 变化，之前同一次改动被记了 7 遍。
let lastEvoKey = '';
let lastEvoAt = 0;
function appendEvolution(row) {
  try {
    const key = `${row.kind}|${row.file}|${row.delta}|${row.result}`;
    const now = Date.now();
    if (key === lastEvoKey && now - lastEvoAt < 5000) return;
    lastEvoKey = key;
    lastEvoAt = now;
    fs.mkdirSync(path.dirname(EVOLUTION), { recursive: true });
    fs.appendFileSync(EVOLUTION, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* ignore */ }
}

fs.mkdirSync(BACKUP, { recursive: true });

// [ACTOR/LINEAGE] 账本行：谁改的 + 内容指纹 + 上一版指纹（DGM 式血统）。
// 护栏只能看见"文件变了"，认不出是谁改的，所以一律记 actor:'guard'；
// 她通过 self_edit 通道改的那些由 console 侧记 actor:'her'。
// 这样唤醒提示里的"我最近改过自己"只认 her，就不会再拿 owner 的改动替她编自画像。
const lastSha = new Map(); // file -> sha12（上一次记进账本时的内容指纹）
function sha12(file) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch { return null; }
}
function recordEdit(file, fields) {
  const sha = sha12(file);
  const parentSha = lastSha.get(file) ?? null;
  if (sha) lastSha.set(file, sha);
  appendEvolution({
    at: new Date().toISOString(),
    kind: 'code_edit',
    actor: 'guard',
    file: path.relative(PROJECT_ROOT, file).replaceAll('\\', '/'),
    ...fields,
    score: fields.result === 'syntax_ok' ? 'passed' : 'failed',
    sha,
    parentSha,
  });
}

// [SINGLE-INSTANCE + SELF-RELOAD] 桥接每次重启都会 spawn 一个守护，旧的不退就会叠加多个。
// 审计 §4.1：单实例逻辑让"新守卫启动→发现旧守卫活着→直接退出"，于是护栏自身的改动
// （比如 10/28 新增的 app.mjs 冒烟）永远加载不到。现在 PID 文件带"源码指纹"：
// 指纹一致才退出；指纹不同 = 护栏更新了，杀掉旧进程由新进程接管。
const PID_FILE = path.join(BACKUP, '.guard.pid');
const SELF_FILES = [fileURLToPath(import.meta.url), path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard-scan.mjs')];
function selfHash() {
  try {
    const h = crypto.createHash('sha1');
    for (const f of SELF_FILES) { try { h.update(fs.readFileSync(f)); } catch { /* 缺文件不影响指纹 */ } }
    return h.digest('hex').slice(0, 12);
  } catch { return 'nohash'; }
}
const GUARD_HASH = selfHash();
try {
  const [oldPid, oldHash] = String(fs.readFileSync(PID_FILE, 'utf8')).trim().split(/\s+/);
  const pid = Number(oldPid);
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, 0); // 旧进程活着
      if (!oldHash || oldHash !== GUARD_HASH) {
        // 旧 PID 文件是纯 pid（10/26 之前的格式），或护栏源码变了：都让新版本接管。
        // 否则护栏自身的修复（比如 app.mjs 冒烟、actor 记账）永远加载不到（审计 §4.1）。
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        log(`self-edit-guard 版本变化（${oldHash || 'legacy'} → ${GUARD_HASH}），接管旧进程 pid=${pid}`);
      } else {
        console.log(`self-edit-guard 已在运行（pid=${pid}，同版本），本次退出`);
        process.exit(0);
      }
    } catch { /* 旧进程已不存在，继续 */ }
  }
} catch { /* 首次运行 */ }
try { fs.writeFileSync(PID_FILE, `${process.pid} ${GUARD_HASH}`, 'utf8'); } catch { /* ignore */ }

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { /* ignore */ }
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 30000 });
    return { ok: true };
  } catch (error) {
    const out = String(error?.stderr ?? error?.message ?? error).slice(0, 500);
    return { ok: false, error: out };
  }
}

// [SMOKE] 对入口链再验一层「运行时可加载」：语法解析通过的顶层炸弹只有真跑一遍才炸得出。
// 2026-10-28 起入口拆成 bridge.js（壳）+ app.mjs（实现）：两个文件任何一边改了都要跑同一条壳，
// 否则真正那 1MB 的 app.mjs 只剩 --check，冒烟等于没做。
const SMOKE_ENTRY = path.join(SRC, 'bridge.js');

function smokeTest(file) {
  if (!needsSmoke(file)) return { ok: true, skipped: true };
  try {
    const out = String(execFileSync(process.execPath, [SMOKE_ENTRY], {
      cwd: BRIDGE, stdio: 'pipe', timeout: 30000,
      env: { ...process.env, BRIDGE_SMOKE_TEST: '1' },
    }));
    return { ok: out.includes('SMOKE_OK'), error: out.slice(0, 300) };
  } catch (error) {
    const out = String(error?.stdout ?? '') + String(error?.stderr ?? error?.message ?? error);
    return { ok: false, error: out.slice(0, 500) };
  }
}

/** 每个文件的"最近好版本" */
const good = new Map(); // file -> { content, at }
const lastSeen = new Map(); // file -> { mtimeMs, size }

function snapshotName(file) {
  return path.join(BACKUP, backupNameFor(file, { projectRoot: PROJECT_ROOT, srcDir: SRC }));
}

function saveGood(file) {
  try {
    const content = fs.readFileSync(file);
    fs.writeFileSync(snapshotName(file), content);
    good.set(file, { content, at: Date.now() });
  } catch (error) {
    log(`备份失败 ${path.basename(file)}: ${error?.message ?? error}`);
  }
}

function restore(file, content) {
  try {
    fs.writeFileSync(file, content);
    log(`↩️ 已回滚 ${path.basename(file)}（${content.length}B）`);
    return true;
  } catch (error) {
    log(`❌ 回滚失败 ${path.basename(file)}: ${error?.message ?? error}`);
    return false;
  }
}

// [MULTI-ROOT] 除了 qq-bridge/src，再把各 MCP 包的 src 也纳入监控。
// 这些代码写坏不会崩桥接，只会让工具静默失败 —— 比崩溃更难查，所以更该有护栏。
// 扫描/命名逻辑抽在 guard-scan.mjs（纯函数，有单测）。
const PACKAGES_ROOT = path.join(PROJECT_ROOT, 'ai-companion-kit', 'packages');

function scanFiles() {
  return collectCodeFiles({ srcDir: SRC, packagesRoot: PACKAGES_ROOT });
}

// [MISSING-FILE] 审计 §4.4：删除/改名受监控文件不在护栏视野——下次重启才炸。
// 每轮比对"上一轮见过的文件"，消失的立刻从 `.good.js` 还原（有备份才还），并写进账本。
function restoreMissing(known, current) {
  for (const file of known) {
    if (current.has(file)) continue;
    const snap = snapshotName(file);
    if (!fs.existsSync(snap)) {
      log(`⚠️ 受监控文件消失且无备份：${path.basename(file)}（需人工处理）`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fs.readFileSync(snap));
      const stat = fs.statSync(file);
      lastSeen.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
      recordEdit(file, {
        bytesBefore: 0,
        bytesAfter: stat.size,
        delta: stat.size,
        result: 'deleted_restored',
      });
      log(`↩️ 文件被删/改名，已从备份还原：${path.basename(file)}（${stat.size}B）`);
    } catch (error) {
      log(`❌ 还原消失文件失败 ${path.basename(file)}: ${error?.message ?? error}`);
    }
  }
}

function tick() {
  const files = scanFiles();
  const current = new Set(files);
  // 注意：lastSeen 是 Map，直接迭代会拿到 [key, value] 数组；这里要的是"曾经见过的文件路径"
  restoreMissing(new Set(lastSeen.keys()), current);
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const prev = lastSeen.get(file);
    const now = { mtimeMs: stat.mtimeMs, size: stat.size };
    if (prev && prev.mtimeMs === now.mtimeMs && prev.size === now.size) continue;
    lastSeen.set(file, now);
    if (!prev) {
      // 首次见到：校验通过且（入口文件）冒烟通过才作为基线
      const r = checkSyntax(file);
      const s = r.ok ? smokeTest(file) : { ok: true, skipped: true };
      if (r.ok && s.ok) saveGood(file);
      else log(`⚠️ 基线文件不合格 ${path.basename(file)}（${r.ok ? '冒烟失败' : '语法不通过'}）: ${(s.error ?? r.error ?? '').slice(0, 200)}`);
      continue;
    }
    // 有变化
    const r = checkSyntax(file);
    if (r.ok) {
      // [SMOKE] 入口文件还要验运行时可加载（语法过 ≠ 跑得起来）
      const s = smokeTest(file);
      if (!s.ok) {
        log(`⚠️ ${path.basename(file)} 语法通过但冒烟失败：${String(s.error ?? '').slice(0, 300)}`);
        const g0 = good.get(file);
        if (g0 && restore(file, g0.content)) {
          recordEdit(file, {
            bytesBefore: now.size,
            bytesAfter: g0.content.length,
            delta: g0.content.length - now.size,
            result: 'smoke_failed_rolled_back',
          });
          log(`   已回滚（冒烟失败）到 ${new Date(g0.at).toLocaleString('zh-CN', { hour12: false })} 的版本`);
          lastSeen.set(file, { mtimeMs: fs.statSync(file).mtimeMs, size: fs.statSync(file).size });
        }
        return;
      }
      const prevBytes = good.get(file)?.content?.length ?? 0;
      saveGood(file);
      log(`✅ ${path.basename(file)} 改动通过语法检查，已更新"好版本"备份`);
      // [EVOLUTION] 记一条自改：哪个文件、大小变化、时间
      recordEdit(file, {
        bytesBefore: prevBytes,
        bytesAfter: now.size,
        delta: now.size - prevBytes,
        result: 'syntax_ok',
      });
    } else {
      log(`❌ ${path.basename(file)} 改动语法错误：${r.error.slice(0, 300)}`);
      const g = good.get(file);
      if (g) {
        if (restore(file, g.content)) {
          recordEdit(file, {
            bytesBefore: now.size,
            bytesAfter: g.content.length,
            delta: g.content.length - now.size,
            result: 'syntax_failed_rolled_back',
          });
          log(`   已回滚到 ${new Date(g.at).toLocaleString('zh-CN', { hour12: false })} 的版本`);
          lastSeen.set(file, { mtimeMs: fs.statSync(file).mtimeMs, size: fs.statSync(file).size });
        }
      } else {
        log(`   ⚠️ 没有可用备份，跳过回滚（文件保持原样，需人工处理）`);
      }
    }
  }
}

log(`self-edit-guard 启动：监控 ${SRC} + ${PACKAGES_ROOT}/*/src（${POLL_MS}ms 轮询）`);
log(`好版本备份目录：${BACKUP}`);
tick();
setInterval(tick, POLL_MS);
