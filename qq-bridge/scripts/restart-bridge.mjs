#!/usr/bin/env node
// [RESTART-GATE] 重启桥接的唯一推荐入口。
//
// 为什么要有它：以前重启是「kill + 拉起」，正在说的那句被拦腰砍断——
// 同一条消息回两遍、前后话对不上（她"左右脑互搏"的直接来源）。
//
// 现在的流程：
//   1. POST /api/restart（带 console token）——桥接自己判断有没有回合在跑；
//   2. 有回合就等（默认最多 60s），放完最后一个回合才退出；
//   3. 本脚本盯端口：确认停了 → 拉起；起不来就兜底再拉一次，最后报状态。
//
// 用法：
//   node scripts/restart-bridge.mjs                # 等最多 60s 到空闲再重启
//   node scripts/restart-bridge.mjs --wait 120000  # 等更久
//   node scripts/restart-bridge.mjs --force        # 立刻重启（真有急事再用）
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, QQ_BRIDGE_DIR } from '../src/domain/shared/project-paths.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const wi = args.indexOf('--wait');
const waitMs = wi >= 0 && args[wi + 1] ? Math.max(0, Number(args[wi + 1]) || 0) : 120000;

const CONSOLE = 'http://127.0.0.1:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  try {
    await fetch(`${CONSOLE}/api/status`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch (error) {
    return error?.name === 'TimeoutError'; // 超时说明端口有人，只是慢
  }
}

let token = '';
try {
  token = fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/state/console-token`, 'utf8').replace(/^\uFEFF/, '').trim();
} catch (error) {
  console.error(`[restart-gate] 读不到控制台令牌（state/console-token）：${error.message}`);
  process.exit(1);
}
if (!token) {
  console.error('[restart-gate] 控制台令牌为空，拒绝无鉴权重启');
  process.exit(1);
}

// 1) 请求重启（闸门在桥接内部）
try {
  const res = await fetch(`${CONSOLE}/api/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify({ force, waitMs }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[restart-gate] HTTP ${res.status}｜${body.message ?? JSON.stringify(body)}`);
  if (!res.ok) process.exit(2);
} catch (error) {
  // [RESTART-500MS] 桥接在回完 200 后 500ms 内就 process.exit，高负载下响应可能还没送达
  // 连接就被关掉（客户端看到 fetch failed）。以前这里直接 exit 3，等于「重启已发生、脚本却不再拉起」，
  // 桥接靠看门狗 60s 才回来（2026-10-30 18:30 实测：脚本退出、3100 空窗 ~60s）。
  // 现在把 POST 失败当成「重启大概率已发出」继续走下面的等待/拉起路径；真没重启，
  // 端口会一直活着，等到 downDeadline 再用 exit 4 报「还活着」。
  console.warn(`[restart-gate] POST 没拿到响应（${error.message}）——按「重启已发出」继续盯端口`);
}

// 2) 等它真的退下去（闸门可能在等回合，最长 waitMs）
const downDeadline = Date.now() + waitMs + 30000;
let down = false;
while (Date.now() < downDeadline) {
  if (!(await isUp())) { down = true; break; }
  await sleep(1000);
}
if (!down) {
  console.error('[restart-gate] 等了很久桥接还活着：可能还有回合在跑。确认没在说话后再试，或加 --force。');
  process.exit(4);
}
console.log('[restart-gate] 桥接已停，准备拉起…');

// 3) 拉起（守护窗口不一定在，自己兜底）
const VBS = `${PROJECT_ROOT}/silent-bridge.vbs`;
const BRIDGE_DIR = QQ_BRIDGE_DIR;
async function launch() {
  if (fs.existsSync(VBS)) {
    spawn('wscript.exe', ['//nologo', VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  // [VBS-OPTIONAL] silent-bridge.vbs 是作者本机私有启动器，被 .gitignore 排除、不入库。
  // 公开仓库/全新克隆上它不存在；这里直接起 node（与 bridge-watchdog.mjs 的 startDirect 一致），
  // 否则 throw 会让「重启桥接的唯一推荐入口」彻底失效、桥接再也拉不起来。
  console.warn('[restart-gate] 找不到 silent-bridge.vbs，改用仓库内脚本直接拉起桥接');
  const child = spawn(process.execPath, ['--import', './src/crash-forensics.js', 'src/bridge.js'], {
    cwd: BRIDGE_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BRIDGE_LAUNCH_SOURCE: 'restart-gate-direct' },
  });
  child.unref?.();
}

await sleep(3000);
if (!(await isUp())) await launch();

let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  if (await isUp()) { up = true; break; }
  if (i === 25 && !up) await launch(); // 25 秒还没起来，再拉一次
}

if (up) {
  console.log('[restart-gate] 桥接已恢复（3100 在线）✅');
  process.exit(0);
}
console.error('[restart-gate] 拉起失败：3100 仍不在。请手动跑 wscript //nologo D:\\<repo>\\silent-bridge.vbs');
process.exit(5);
