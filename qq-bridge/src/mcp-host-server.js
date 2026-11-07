// SnowLuma 网关状态查询 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行）。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（只读：HTTP get_login_info）与账号信息
//   handoff_task      —— 把长任务交给桥接独立会话做（见 [HANDOFF] 段）
//   adjust_wall       —— 她自己调整「墙」（会话白名单 allowlist.txt）：加/减/看（见 [WALL] 段）
//
// ── 为什么这里**没有**启停 SnowLuma 的工具（2026-09-20 移除，不要加回来）────────────
//
// 曾经有 `start_snowluma` / `stop_snowluma`（`spawn launcher.bat` / `taskkill`），默认关闭、
// 需要 `snowluma.allowProcessControl: true` 才注册。它们被移除，理由不是"危险"，而是**许可**：
//
//   SnowLuma EULA §5.4（中文为准）：「除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的
//   非商业用途，以专有组件随本软件提供的形式运行该组件；不得复制、修改、单独再分发或再许可该组件。
//   **将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或者将其用于任何商业用途，
//   均须事先取得书面授权。」
//
// 原生组件是**专有组件**；由本程序**程序化启动/结束**它，落在"通过自动化脚本部署"的射程内。
// 即便是"用户已装好、我们帮忙拉起"，也不值得为这点便利去踩一条需要书面授权的条款。
//
// 设计不变量 L6（见规划集 QSH_PLAN.md §6.0）：**QSH 只探测、不部署**——
// 永不安装、复制、打包或自动部署 SnowLuma 及其原生组件，也不程序化启停其进程。
// 用户在 QQ 侧不可用时得到的应该是**可操作的提示**（"请自行启动 SnowLuma"），而不是被代劳。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// [WATCH-VIDEO] 看视频并总结：B站 API 快路径（标题/简介/字幕/弹幕）+ 关键帧画面层
import {
  watchVideo, openWatchContext, windowView, biliSearch, biliComments,
} from './domain/memory/watch-video.js';
// [EYES] 眼睛：只把帧变成她能看见的画面，别的事一概不管
import { see, lookAt } from '../../ai-companion-kit/packages/shared/video-understanding.js';
// [VIDEO-LOOP] 像人一样接收视频：候选池（她选）+ 感知循环（她控节奏）+ 留存（她的读法）
import { renderFeed, patienceWindows, openSession, stepSession, encodeMemory, pickNextCandidate } from './domain/leaves/inori-videowatch.js';
import { loadLifeState } from './domain/leaves/inori-lifestate.js';
import { MEMORY_DIR, stateDataPath } from './domain/shared/project-paths.js';
// [GATE-TUNE] 门的敏感度范围与生效值（纯函数，与桥接共用同一口径）
import { GATE_SENSITIVITY_RANGE, effectiveGateThreshold, parseGateSensitivityOverride } from './domain/leaves/inori-gate.js';
// [AUDIT-2026-10-25] 共享状态原子写/锁：本进程与桥接交叉写 tool-whitelist / allowlist /
// memory.jsonl，裸 write 会互丢或半截——统一走 learning-store（与桥接同一套锁文件协议）。
import { appendJsonl, withFileLock, writeJsonDocument, writeTextAtomic } from '../../ai-companion-kit/packages/shared/learning-store.mjs';
// [SSRF-IMAGES] 关键帧/封面抓图统一走 safe-fetch（逐跳校验，防内网/环回/元数据）。
import { safeFetchBuffer } from './domain/shared/safe-fetch.js';
// [AUDIT-FIX] 控制台端口从配置读取，不再写死 3100（改端口后派发/鉴权链路会静默失效）。
import { agentApiBase } from './mcp-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 从图片字节嗅探 MIME（safeFetchBuffer 已校验过确为图片）。 */
function imageMime(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const homeDir = c.snowluma?.homeDir ?? (c.snowluma?.launcherPath ? path.dirname(c.snowluma.launcherPath) : '');
  return { httpUrl, homeDir, token: c.snowluma?.accessToken ?? '' };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

const server = new McpServer({ name: 'snowluma-host', version: '0.1.7' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（只读探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。网关不可达时返回可操作的提示（本程序不会代你启动 SnowLuma）。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只读工具：不再暴露本机路径/PID（那需要进程控制能力，而该能力已被移除）。
    const payload = { ...info };
    if (info.reachable === false) {
      payload.hint = 'SnowLuma 网关不可达。请自行启动 SnowLuma（本程序不代装、不代启，原因见项目文档的合规说明 L6）。'
        + (hc.homeDir ? '' : ' 若 config.json 的 snowluma.httpUrl 与实际端口不一致，也请一并检查。');
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

// ── [HANDOFF] 任务分派：把要花几分钟的事交给桥接在独立会话里做 ─────────────
// 她的主会话要保持能聊天；长任务（过游戏教程、查资料、跑长流程）在独立会话跑，
// 做完由任务会话自己用 qq_send_message 回报。这样不用给她 DSH 的 subagent
// （那等于把「派生 agent」能力递出去），也不用她自己在一个 turn 里耗几分钟。
async function handoffTask(task, reportTo, key = '', agentToken = '', acceptance = '', fingerprint = '', intentionId = '') {
  let token = '';
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch (error) {
    if (error?.code !== 'ENOENT') process.stderr.write(`[handoff] 读 console-token 失败: ${error?.message ?? error}\n`);
  }
  try {
    const res = await fetch(`${agentApiBase()}/api/console/handoff-task`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-console-token': token } : {}),
        // [CONFUSED-DEPUTY] 必须声明这是一次智能体调用，否则桥接会把"没带会话令牌"
        // 当成管理端全权（console-token 就在本进程里）。令牌为空也要显式发空串，
        // 让桥接走 403，而不是省略头后提权。
        'x-agent-call': '1',
        'x-agent-token': String(agentToken ?? ''),
      },
      body: JSON.stringify({ task, reportTo, key, acceptance, fingerprint, intentionId }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      return { content: [{ type: 'text', text: `交出去失败：${j.error ?? res.status}` }] };
    }
    if (j.resumed) {
      return { content: [{ type: 'text', text: `这件事之前没做完，我接上了上次的进度（任务 ${String(j.taskId).slice(0, 8)}），会从上次卡点继续，不从头重开。做完把结果发到 ${reportTo}。` }] };
    }
    if (j.queued) {
      return { content: [{ type: 'text', text: `任务池满了，先给你排上了（排队第 ${j.position} 位）。有活干完会自动接着做，做完把结果发到 ${reportTo}；你继续聊你的，不用盯着。` }] };
    }
    return { content: [{ type: 'text', text: `已经交出去了（任务会话 ${String(j.sessionId).slice(0, 8)}，和聊天同时跑）。它会自己做完，把结果发到 ${reportTo}；你继续聊你的。多件互不相干的活可以分几次交，会并行做。` }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `交出去失败：${String(error?.message ?? error).slice(0, 120)}` }] };
  }
}

server.tool(
  'handoff_task',
  '把一件要花几分钟的事交出去做（过游戏教程、下游戏、查一堆资料、整理东西）。交出去之后你继续正常聊天，不用守着；做完它会把结果发到指定会话。适合「他让你做一件事、但做起来要好几分钟」的情况。多件互不相干的活可以分几次交——任务池会并行做（最多同时两件，满了自动排队），做完一件报一件。调用时把提示里的【会话令牌】填进 token、当前会话 key 填进 key（主人派的任务要靠它拿到全权限）。',
  {
    task: z.string().describe('要它做的事：目标 + 做到什么算成功，写清楚'),
    reportTo: z.string().describe('做完把结果发到哪个会话，例如 private:10001 或 group:123456780'),
    key: z.string().optional().describe('当前会话 key（见唤醒提示），用于判断任务来源'),
    token: z.string().describe('当前会话令牌（见唤醒提示中的【会话令牌】；必填，用于判断任务来源/权限）'),
    acceptance: z.string().optional().describe('可选：怎么算成功（一句可验证的判据：文件/截图/文字/他确认）'),
    fingerprint: z.string().optional().describe('可选：同一件事的指纹；重复派活会先接上旧任务，不新建'),
    intentionId: z.string().optional().describe('可选：这件任务对应她挂着的哪个意图（qq_intention 的 id）；做完会自动写 outcome'),
  },
  async ({ task, reportTo, key, token, acceptance, fingerprint, intentionId }) => handoffTask(task, reportTo, key, token, acceptance, fingerprint, intentionId)
);

// ── [WALL] 她自己可以改的墙：会话白名单 allowlist.txt ─────────────────────
// 主人 2026-10-25 授权：她调整自己「看得见哪些会话」的墙，不需要拍板。
// 工程形态：行级编辑（保留注释与历史行）+ 每次改动写 state/wall-log.jsonl 留痕
// （留痕不是门槛：改动即时生效，日志是给主人读和撤销用的）。
// 边界（不是权限关卡，是工具定义）：只动 allowlist.txt 的会话条目；
// 工具边界（qq-tool-restrict 白名单）与源码自改（self-edit-guard）仍归 owner 层。
const WALL_FILE = process.env.MZ_WALL_FILE
  ?? path.join(ROOT, 'allowlist.txt');
const WALL_LOG_FILE = process.env.MZ_WALL_LOG
  ?? path.join(ROOT, 'state', 'wall-log.jsonl');

function parseWallLines(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = /^(private|group)\s*[:：]\s*(\d+)/i.exec(line);
    return m ? { kind: m[1].toLowerCase(), id: String(Number(m[2])), raw: line } : null;
  });
}

function readWall() {
  let text = '';
  try {
    text = fs.readFileSync(WALL_FILE, 'utf8');
  } catch {
    return { entries: [], text: '' }; // 名单文件读不到（首启/被删）= 空名单，不能让整个 MCP server 崩
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 防 BOM 粘住首行导致解析失败
  const entries = parseWallLines(text).filter(Boolean);
  return { entries, text };
}

function wallLog(action, payload) {
  try {
    fs.mkdirSync(path.dirname(WALL_LOG_FILE), { recursive: true });
    fs.appendFileSync(WALL_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), action, ...payload }) + '\n', 'utf8');
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:194'); }
}

/**
 * [WALL-GATE] 改墙前先问桥接：这个令牌是不是主人私聊 lane。
 * 只做鉴权，不改文件——留痕/原子写仍在本地（wall-log 语义不变）。
 */
async function wallAccessOk(agentToken) {
  const t = String(agentToken ?? '');
  if (!t) return { ok: false, error: '缺会话令牌' };
  let consoleToken = '';
  try { consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { /* 没有令牌则让桥接 401，别在这里伪造 */ }
  try {
    const res = await fetch(`${agentApiBase()}/api/socialV2/wall-access`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
        'x-agent-call': '1',
        'x-agent-token': t,
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) return { ok: false, error: j.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function adjustWall(op, kind, id, reason, agentToken) {
  if (op === 'list') {
    const { entries } = readWall();
    wallLog('list', { count: entries.length });
    const lines = entries.map((e) => `${e.kind}:${e.id}`);
    return { content: [{ type: 'text', text:
      `名单里的会话（共 ${entries.length} 个）：\n${lines.join('\n') || '（空）'}` }] };
  }
  const gate = await wallAccessOk(agentToken);
  if (!gate.ok) {
    return { content: [{ type: 'text', text:
      `改墙需要主人私聊会话里的令牌（这次：${gate.error}）。现在不是那条线——想动墙就等跟他私聊时再说，或者跟他讲为什么想加/减。` }] };
  }
  const k = String(kind ?? '').toLowerCase();
  const s = String(id ?? '').trim();
  if (!['private', 'group'].includes(k) || !/^\d+$/.test(s)) {
    return { content: [{ type: 'text', text: '格式不对：kind 是 private 或 group，id 是纯数字。' }] };
  }
  const sid = String(Number(s));
  const target = `${k}:${sid}`;
  let { text } = readWall();
  const lines = text.split(/\r?\n/);
  const lineRe = new RegExp(`^${k}\\s*[:：]\\s*${sid}(?:\\s|$)`);
  if (op === 'add') {
    if (lines.some((l) => lineRe.test(l))) {
      return { content: [{ type: 'text', text: `${target} 已经在名单里了，不用再加。` }] };
    }
    const note = reason ? String(reason).replace(/\r?\n/g, ' ').slice(0, 60) : '';
    const newLine = note ? `${target}  # ${note}` : target;
    text = text.replace(/\n?$/, '\n') + newLine + '\n';
    // 原子写：桥接每消息热读这份名单，半截文件 = 名单解析失败
    writeTextAtomic(WALL_FILE, text, { source: 'mcp-host/adjust-wall' });
    wallLog('add', { session: target, reason, ts: new Date().toISOString() });
  } else if (op === 'remove') {
    const hit = lines.find((l) => lineRe.test(l));
    if (!hit) {
      return { content: [{ type: 'text', text: `${target} 不在名单里，没东西可减。` }] };
    }
    const kept = lines.filter((l) => l !== hit).join('\n');
    const entries = parseWallLines(kept).filter(Boolean);
    if (entries.length === 0) {
      return { content: [{ type: 'text', text: '这是名单里最后一个会话，减掉它你的世界就空了——留着它吧（或者想想为什么想清掉它，跟我说说也行）。' }] };
    }
    writeTextAtomic(WALL_FILE, kept, { source: 'mcp-host/adjust-wall' });
    wallLog('remove', { session: target, removedLine: hit, reason });
  }
  const after = readWall().entries.map((e) => `${e.kind}:${e.id}`);
  return { content: [{ type: 'text', text:
    `${op === 'add' ? '加进来了' : '减掉了'}：${target}。已经生效（名单热读，下一次消息判定就是新的）。\n`
    + `现在名单里 ${after.length} 个：${after.join('、')}\n`
    + `改动记在 wall-log 里，主人随时能看、能改回去——他看得到，但不会拦你。` }] };
}

server.tool(
  'adjust_wall',
  '你自己调整「墙」：你和哪些会话之间互相看得见（会话白名单）。op=list 看名单；add/remove 加/减一个会话（kind: private 或 group，id 纯数字），立即热生效，不用重启。加减必须带上你当前会话的 token（见唤醒提示的【会话令牌】）——只有主人私聊那条线能改墙，群里/任务会话改不了。加减要写 reason（一句话为什么——会连同改动留痕给主人看，他随时可撤销，但不会拦你）。你只能动这份名单：工具边界（你能用什么工具）和源码边界不在这里改。',
  {
    op: z.enum(['list', 'add', 'remove']),
    kind: z.enum(['private', 'group']).optional().describe('add/remove 必填：会话类型'),
    id: z.string().optional().describe('add/remove 必填：QQ 号或群号（纯数字）'),
    reason: z.string().max(100).optional().describe('为什么（一句话，会留痕给主人看）'),
    token: z.string().optional().describe('当前会话令牌（见唤醒提示的【会话令牌】）；add/remove 必填，且必须来自主人私聊'),
  },
  async ({ op, kind, id, reason, token }) => adjustWall(op, kind, id, reason, token)
);

// ── [GATE-TUNE] 她的注意力门：群话题多容易唤到她（热覆盖 + 留痕） ──────────
// 基线在 config.json（gate.cosThreshold，主人定）；她的覆盖写 state/gate-sensitivity.json，
// 桥接门循环按 mtime 热读，30 秒内下一拍即用新阈值，不用重启。
// 每次改动记 state/gate-tune-log.jsonl（主人随时能看、能改回去，不拦她）。
const GATE_SENS_FILE = process.env.MZ_GATE_SENSITIVITY
  ?? path.join(ROOT, 'state', 'gate-sensitivity.json');
const GATE_TUNE_LOG_FILE = process.env.MZ_GATE_TUNE_LOG
  ?? path.join(ROOT, 'state', 'gate-tune-log.jsonl');

function gateTuneLog(entry) {
  try { appendJsonl(GATE_TUNE_LOG_FILE, { ts: new Date().toISOString(), ...entry }, { source: 'mcp-host/gate-tune' }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:267'); }
}

function readGateSensOverride() {
  try {
    let text = fs.readFileSync(GATE_SENS_FILE, 'utf8');
    return parseGateSensitivityOverride(text);
  } catch { return null; }
}

async function gateTune(op, threshold, reason) {
  const cfg = getConfig();
  const base = Number(cfg?.gate?.cosThreshold ?? 0.6);
  const override = readGateSensOverride();
  const effective = effectiveGateThreshold(base, override?.cosThreshold);
  if (op === 'get') {
    const line = override?.cosThreshold != null
      ? `当前生效 ${effective.toFixed(2)}（${override.by ?? 'agent'} 设的，理由：${override.reason ?? '没写'}${override.at ? `，${override.at}` : ''}）`
      : `当前生效的是主人基线 ${base.toFixed(2)}（你还没动过）`;
    return { content: [{ type: 'text', text: `注意力门（群话题多容易唤到你）：${line}。\n`
      + `范围 ${GATE_SENSITIVITY_RANGE.min}–${GATE_SENSITIVITY_RANGE.max}：越低话题越容易唤到你（你在群里越活跃），越高门越严（越安静）。`
      + 'op=set 自己调（写理由），op=clear 回基线。改动下一拍（≤30秒）生效，不用重启；主人看得到日志、随时改得回去。' }] };
  }
  const why = String(reason ?? '').trim().slice(0, 100);
  if (op === 'clear') {
    if (!why) return { content: [{ type: 'text', text: 'op=clear 要写 reason（一句话，主人看得到）。' }] };
    withFileLock(GATE_SENS_FILE, () => { try { fs.unlinkSync(GATE_SENS_FILE); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:293'); } }, { source: 'mcp-host/gate-tune' });
    gateTuneLog({ op: 'clear', by: 'agent', reason: why, effectiveAfter: Number(base) });
    return { content: [{ type: 'text', text: `已回到主人基线 ${base.toFixed(2)}。理由（${why}）记在 gate-tune-log 里。` }] };
  }
  // op === 'set'
  const th = Number(threshold);
  if (!Number.isFinite(th)) return { content: [{ type: 'text', text: 'op=set 需要 threshold 是数字。' }] };
  if (th < GATE_SENSITIVITY_RANGE.min || th > GATE_SENSITIVITY_RANGE.max) {
    return { content: [{ type: 'text', text: `调不了：门的敏感度只能在 ${GATE_SENSITIVITY_RANGE.min}–${GATE_SENSITIVITY_RANGE.max} 之间（更低≈永远被唤到、flash 白烧；更高≈你听不见群）。当前生效 ${effective.toFixed(2)}。` }] };
  }
  if (!why) return { content: [{ type: 'text', text: 'op=set 要写 reason（一句话，主人看得到，他据这个判断要不要改回去）。' }] };
  const doc = { cosThreshold: th, by: 'agent', reason: why, at: new Date().toISOString() };
  withFileLock(GATE_SENS_FILE, () => { writeJsonDocument(GATE_SENS_FILE, doc, { source: 'mcp-host/gate-tune' }); }, { source: 'mcp-host/gate-tune' });
  gateTuneLog({ op: 'set', by: 'agent', threshold: th, reason: why });
  return { content: [{ type: 'text', text: `已调到 ${th.toFixed(2)}（下一拍 ≤30 秒生效，不用重启）。理由：${why}。改动记在 gate-tune-log，主人随时看得到、随时改得回去——他看得到，但不会拦你。` }] };
}

server.tool(
  'gate_tune',
  '注意力门控制「群话题多容易唤到你」：数字越低，话题越容易唤到你（你在群里越活跃）；越高，门越严（越安静）。op=get 看当前值、上次是谁调的、为什么；op=set 自己调（0.40–0.80，写 reason；日志主人看得到、随时改得回去，但不拦你）；op=clear 回到主人基线。只动你的注意力门槛，不碰群内容本身。',
  {
    op: z.enum(['get', 'set', 'clear']),
    threshold: z.number().optional().describe('op=set 必填：0.40–0.80，越低越容易被唤到'),
    reason: z.string().max(100).optional().describe('op=set/clear 必填：一句话为什么（会留痕，主人看得到）'),
  },
  async ({ op, threshold, reason }) => gateTune(op, threshold, reason)
);

// ── [WALL-TOOL] 工具边界：她自己能动的一道（收紧免批，放开走申请）─────────
// 收紧（mode=deny）：追加进 state/tool-whitelist.json 的 denied[] —— 两个 restrict
// 插件（群聊/私聊）的 guard 按 mtime 热读，下一次工具调用就拒绝，立即生效。
// 放开（mode=grant）：写 state/tool-proposals.jsonl 待批准条目，owner 一句话
// （bridge /api/console/approve-tool）合并进白名单；本地工具进 schema 还需 DSH 重启。
const TOOL_WHITELIST_FILE = process.env.MZ_TOOL_WHITELIST
  ?? path.join(ROOT, 'state', 'tool-whitelist.json');
const TOOL_PROPOSALS_FILE = path.join(ROOT, 'state', 'tool-proposals.jsonl');
const TOOL_LOG_FILE = process.env.MZ_TOOL_LOG
  ?? path.join(ROOT, 'state', 'tool-log.jsonl');

function readWhitelist() {
  try {
    let text = fs.readFileSync(TOOL_WHITELIST_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    return {
      extraExact: Array.isArray(raw.extraExact) ? raw.extraExact : [],
      extraPrefixes: Array.isArray(raw.extraPrefixes) ? raw.extraPrefixes : [],
      denied: Array.isArray(raw.denied) ? raw.denied : [],
    };
  } catch {
    return { extraExact: [], extraPrefixes: [], denied: [] };
  }
}

function writeWhitelist(wl) {
  // 锁内原子写：与桥接侧 /api/console/approve-tool|revoke-tool 共享同一把锁
  // （learning-store 的 <file>.lock 协议），交叉 读-改-写 不再互丢
  const locked = withFileLock(TOOL_WHITELIST_FILE, () => {
    writeJsonDocument(TOOL_WHITELIST_FILE, wl, { source: 'mcp-host/tool-boundary' });
    return { ok: true };
  }, { source: 'mcp-host/tool-boundary' });
  if (!locked.ok) {
    // 锁等待超时兜底：直接写（宁可半截风险低——3s 内拿不到锁的概率极低）
    fs.mkdirSync(path.dirname(TOOL_WHITELIST_FILE), { recursive: true });
    fs.writeFileSync(TOOL_WHITELIST_FILE, JSON.stringify(wl, null, 2), 'utf8');
  }
}

/** 锁内 读-改-写（fn 拿到锁内的白名单，修改后返回；锁内原子落盘） */
function mutateWhitelist(fn) {
  const locked = withFileLock(TOOL_WHITELIST_FILE, () => {
    const wl = fn(readWhitelist());
    if (wl) writeJsonDocument(TOOL_WHITELIST_FILE, wl, { source: 'mcp-host/tool-boundary' });
    return { ok: true };
  }, { source: 'mcp-host/tool-boundary' });
  if (!locked.ok) {
    const wl = fn(readWhitelist());
    if (wl) writeWhitelist(wl);
  }
}

function toolLog(action, payload) {
  try {
    fs.mkdirSync(path.dirname(TOOL_LOG_FILE), { recursive: true });
    fs.appendFileSync(TOOL_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), action, ...payload }) + '\n', 'utf8');
  } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:378'); }
}

function listPendingProposals() {
  try {
    const lines = fs.readFileSync(TOOL_PROPOSALS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-10).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// 本地执行/文件/子代理类工具：这类放开仍要主人点头（安全边界，不是权限问题）
const LOCAL_EXEC_TOOLS = new Set(['pwsh', 'bash', 'read', 'read_image', 'write', 'edit', 'str_replace_editor', 'glob', 'grep', 'subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'load_workspace_dependencies']);

async function toolBoundary(op, tool, mode, reason) {
  if (op === 'status') {
    const wl = readWhitelist();
    const pending = listPendingProposals().filter((p) => p.mode === 'grant' && p.status !== 'approved');
    return { content: [{ type: 'text', text:
      `当前工具边界：\n`
      + `· 经批准放开：${wl.extraExact.concat(wl.extraPrefixes).join('、') || '（无）'}\n`
      + `· 停用（自拒/经批准收紧）：${wl.denied.join('、') || '（无）'}\n`
      + `· 待主人决定的申请：${pending.length ? pending.map((p) => `${p.tool}（${String(p.reason ?? '')}）`).join('、') : '（无）'}` }] };
  }
  const t = String(tool ?? '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(t) && !/^mcp__[\w-]+__[\w-]+$/.test(t)) {
    return { content: [{ type: 'text', text: '工具名没写清（例如 subagent、mcp__phone__phone_tap）。' }] };
  }
  if (mode === 'deny') {
    mutateWhitelist((wl) => {
      if (!wl.denied.includes(t)) wl.denied.push(t);
      return wl;
    });
    toolLog('self-deny', { tool: t, reason });
    return { content: [{ type: 'text', text:
      `已经停用了 ${t}——从现在起它就不会再出现在你的手里（不需要谁批准，这是你自己的收紧）。`
      + (reason ? `\n你写的原因留痕了：「${String(reason).slice(0, 60)}」。主人看得到这条记录。` : '\n留痕时没写原因；想说的话可以补一句。') }] };
  }
  if (mode === 'grant') {
    const isPrefix = t.endsWith('__');
    const localExec = LOCAL_EXEC_TOOLS.has(t);
    // [WALL-FAILCLOSED] 只登记申请，绝不自行改动白名单。
    // 原实现即时把工具写进 extra* 并标记 approved，等于 agent 可自行放开 bash/写文件/子代理，
    // 与 fail-closed 边界矛盾（群聊 prompt injection 可借此拿到本地执行能力）。
    const proposal = {
      ts: new Date().toISOString(),
      tool: t,
      mode: 'grant',
      status: 'pending',
      by: 'self',
      reason,
      prefix: isPrefix,
      localExec,
    };
    try {
      fs.mkdirSync(path.dirname(TOOL_PROPOSALS_FILE), { recursive: true });
      fs.appendFileSync(TOOL_PROPOSALS_FILE, JSON.stringify(proposal) + '\n', 'utf8');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:430'); }
    toolLog('self-grant-request', { tool: t, reason, localExec });
    return { content: [{ type: 'text', text:
      `已登记申请：${t}——还没生效，等主人批准${localExec ? '（本地执行/文件/子代理类工具，主人确认后还要重启大脑刷新工具表）' : ''}。`
      + (reason ? `\n你写的原因留痕了：「${String(reason).slice(0, 60)}」。` : '\n留痕时没写原因；能补一句就补一句，主人看得到。')
      + `\n（申请记在 tool-proposals，主人在控制台一句话就能批；在那之前它不在你手里。）` }] };
  }
  return { content: [{ type: 'text', text: 'op=propose 要带 mode：deny（停用，立即）或 grant（申请放开，等主人）。' }] };
}

server.tool(
  'tool_boundary',
  '你手里的工具边界，也能由你动。想停用一个工具 → op=propose, mode=deny，立即生效、不需要批准（你自己收紧）；想加回/加一个新工具 → op=propose, mode=grant，只登记"申请"，等主人批准后才生效（本地执行/文件/子代理类必须主人确认并重启）。op=status 看当前边界与待批申请。',
  {
    op: z.enum(['status', 'propose']),
    tool: z.string().optional().describe('工具名（propose 必填），例如 subagent、mcp__phone__phone_tap'),
    mode: z.enum(['deny', 'grant']).optional().describe('deny=停用（立即）；grant=申请放开（待主人一句话）'),
    reason: z.string().max(100).optional().describe('为什么（留痕给主人看）'),
  },
  async ({ op, tool, mode, reason }) => toolBoundary(op, tool, mode, reason)
);

server.tool(
  'watch_video',
  '一次性看完一个视频拿总结（批处理）：标题/UP主/简介/字幕/弹幕+关键帧画面。★字幕和画面都要看，别只总结文字；只有简介+弹幕时别把推断说成"看完了"。——想**像人一样看**（自己挑、慢慢看、随时跳/退、看完留一句想法）用 video_feed + video_watch。',
  {
    url: z.string().describe('视频链接，如 https://www.bilibili.com/video/BV... 或 https://b23.tv/xxx'),
  },
  async ({ url }) => {
    try {
      const r = await watchVideo(url);
      if (!r.ok) return { content: [{ type: 'text', text: `看不了：${r.error}` }] };
      const layerNote = `\n\n（拿到：${Object.entries(r.layers).filter(([, v]) => v).map(([k]) => k).join(' / ')}）`;
      // [THOUGHT] 看完要形成「她的」想法，不是复述视频；B 开关打开时要求按时间把全片串起来。
      const full = Boolean(getConfig()?.video?.fullUnderstand);
      const sedimentHint = [
        '（看完之后，先用你自己的话说清你看见了什么，再说你由此想到了什么——',
        '可以是一点感触、一个联想、一条想记住的知识，或者一个反问；不必正确，不必像总结。',
        full ? '全片理解已开：按帧的时刻把整片串起来，别只看开头就下结论。' : '',
        '想留住就 qq_memory_append 写那一句；不想留也算看过了。）',
      ].filter(Boolean).join('');
      const content = [{ type: 'text', text: r.text + layerNote + '\n' + sedimentHint }];
      // [EYES] 眼睛只把帧变成画面；看不见就是没有图片，不需要别的状态。
      const eyes = await see(r.frameImages, { fetchImage: safeFetchBuffer, imageMime });
      for (const eye of eyes) content.push({ type: 'image', data: eye.data, mimeType: eye.mimeType });
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `看视频失败：${String(error?.message ?? error).slice(0, 200)}` }] };
    }
  }
);

// ── [BILI-SEARCH] 按关键词搜 B 站视频 / 读某个视频的热评（只读；发评论要登录 Cookie，没配就不碰）──
const biliHits = [];
const biliBudget = (n = 10) => {
  const now = Date.now();
  while (biliHits.length && now - biliHits[0] > 60000) biliHits.shift();
  if (biliHits.length >= n) return false;
  biliHits.push(now);
  return true;
};

server.tool(
  'bili_search',
  '去 B 站搜视频：给个关键词，回来一串标题/UP主/播放量/简介。想按自己的兴趣刷、或者想找点什么看，用它；看中了用 watch_video 或 video_watch 打开。别刷太快（一分钟最多十次）。',
  {
    keyword: z.string().describe('搜什么（比如「猫咪 搞笑」「明日方舟 攻略」）'),
    page: z.number().int().min(1).max(5).optional().describe('第几页（默认 1）'),
    limit: z.number().int().min(1).max(12).optional().describe('最多返回几条（默认 8）'),
  },
  async ({ keyword, page, limit }) => {
    if (!biliBudget()) return { content: [{ type: 'text', text: '搜太快了，缓一分钟再来（防 B 站风控）。' }] };
    try {
      const list = await biliSearch(keyword, { page: page || 1, limit: limit || 8 });
      if (!list.length) return { content: [{ type: 'text', text: `没搜到「${keyword}」相关的视频。` }] };
      const lines = list.map((v, i) => `${i + 1}. 《${v.title}》 UP主：${v.owner || '?'} 播放 ${v.play}  ${v.bvid}\n   ${v.desc || '（无简介）'}`);
      return { content: [{ type: 'text', text: `搜「${keyword}」找到 ${list.length} 条：\n${lines.join('\n')}\n\n想看的用 watch_video（一次性）或 video_feed+video_watch（像人一样慢慢看）。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `B站搜索失败：${String(error?.message ?? error).slice(0, 200)}` }] };
    }
  }
);

server.tool(
  'bili_comments',
  '看一个 B 站视频下面的热评（别人怎么说的）：链接或 BV 号都行。热评是「别人怎么说话」最密集的地方，看视频时跟字幕/弹幕一起读。',
  {
    link: z.string().describe('B站链接或 BV 号'),
    limit: z.number().int().min(1).max(20).optional().describe('最多几条（默认 8）'),
  },
  async ({ link, limit }) => {
    if (!biliBudget()) return { content: [{ type: 'text', text: '读太快了，缓一分钟再来（防 B 站风控）。' }] };
    try {
      const list = await biliComments(String(link), { limit: limit || 8 });
      if (!list.length) return { content: [{ type: 'text', text: '这个视频没读到热评（或评论关闭）。' }] };
      const lines = list.map((c) => `- ${c.name || '?'}：${c.text}${c.like ? `（${c.like} 赞）` : ''}`);
      return { content: [{ type: 'text', text: `热评 ${list.length} 条（别人的说法）：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读热评失败：${String(error?.message ?? error).slice(0, 200)}` }] };
    }
  }
);


// ── [VIDEO-LOOP] 像人一样接收视频 ───────────────────────────────────────────
// 状态：data/state/video-watch.json = { active: {sess, ctx} | null, log: [...] }
// 会话里挂的是 sess（inori-videowatch.openSession 的返回）+ ctx（openWatchContext 的缓存）
const VIDEO_STATE_FILE = stateDataPath('video-watch.json');
const VIDEO_MEMORY_FILE = path.join(MEMORY_DIR, 'memory.jsonl');
const log = (m) => { try { process.stderr.write(`${new Date().toISOString()} ${m}\n`); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:545'); } };

function loadVideoState() {
  try {
    const j = JSON.parse(fs.readFileSync(VIDEO_STATE_FILE, 'utf8'));
    return {
      active: j.active ?? null,
      // [VIDEO-STREAM] video_feed 的候选队列；next 只在这个队列里走动，不自动播。
      feed: j.feed && typeof j.feed === 'object' ? j.feed : null,
      log: Array.isArray(j.log) ? j.log : [],
    };
  } catch {
    return { active: null, feed: null, log: [] };
  }
}
function saveVideoState(st) {
  try {
    // 原子写（tmp+rename）：视频会话状态半截 = 下一轮 openSession 读不了
    const r = writeJsonDocument(VIDEO_STATE_FILE, st, { source: 'mcp-host/video-watch' });
    if (!r.ok) {
      fs.mkdirSync(path.dirname(VIDEO_STATE_FILE), { recursive: true });
      fs.writeFileSync(VIDEO_STATE_FILE, JSON.stringify(st, null, 1), 'utf8');
    }
  } catch (error) {
    log(`[video-watch] 状态落盘失败: ${error?.message ?? error}`);
  }
}

/** 把窗口视图渲染成"她此刻看到的东西"（30 秒，不是全片） */
function renderLookNote(viewWindow, view, session) {
  const lines = [];
  if (view.subs?.length) lines.push(`【说了什么】${view.subs.join(' | ').slice(0, 900)}`);
  else lines.push('【说了什么】（这段没拿到字幕——可能无字幕或需要登录，别把推断说成"我听到"）');
  if (view.danmakuMoments?.length) {
    lines.push(`【弹幕此刻】${view.danmakuMoments.map((p) => `${Math.floor(p.t / 60)}:${String(p.t % 60).padStart(2, '0')}「${p.phrase}」×${p.n}`).join('；')}`);
  }
  lines.push(view.frames?.length
    ? `【画面】附图（${view.frames.length} 张）。画面是"长什么样"，字幕是"说了什么"，两个都要用。图里的字（标题卡、台词字幕、截图里的文字）直接读出来——那是这段里发生过的事，不是装饰；格子之间场景变了也是信息。${view.framesNote ?? ''}`
    : `【画面】${view.framesNote ?? '这段没拿到关键帧。'}`);
  if (view.remaining <= 0) lines.push('（已经到片尾了——exit 合上，留一句想法。）');
  void session;
  return lines.join('\n');
}

/** [ACQ-GATE] 这条视频到底有没有画面层：storyboard 一帧都没返回 = 没取到东西。 */
function videoFrameCount(ctx) {
  return Number(ctx?.frames?.imagesAll?.length || 0) + Number(ctx?.frames?.images?.length || 0);
}

/** [ACQ-GATE] 没取到画面：只记"没看"，不写记忆、不计观看时长。 */
function logVideoMiss(st, { bvid, title, total = 0 } = {}) {
  st.log = [...(Array.isArray(st.log) ? st.log.slice(-11) : []), {
    ts: Date.now(), bvid: String(bvid || ''), title: String(title || ''),
    watched: 0, total: Number(total) || 0, take: '没取到画面，这条没看', why: 'no-signal',
  }];
  saveVideoState(st);
}

/** exit 时写留存（她的读法进记忆库，带她的状态上下文） */
function persistWatchMemory(sess, ctx) {
  const entry = encodeMemory(sess, ctx);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const time = `${day} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  try {
    // 锁内追加：memory.jsonl 同时被桥接（facts/digest）与桥接侧归档器写，裸 append 会交错
    const ar = appendJsonl(VIDEO_MEMORY_FILE, { day, time, ...entry }, { source: 'mcp-host/video-watch' });
    if (!ar.ok) {
      fs.mkdirSync(path.dirname(VIDEO_MEMORY_FILE), { recursive: true });
      fs.appendFileSync(VIDEO_MEMORY_FILE, JSON.stringify({ day, time, ...entry }) + '\n', 'utf8');
    }
  } catch (error) {
    log(`[video-watch] 记忆写入失败: ${error?.message ?? error}`);
  }
}

server.tool(
  'video_feed',
  '按你自己想看的关键词去 B站找视频：want 是你要看的主题/人物/作品/UP主。★不摆热榜、不按别人的弹幕密度替你挑；没给 want 就先想清楚想看什么。看封面附图再挑；看某条用 video_watch(op=open, bvid=第N条的BV号)；看完想接下一條用 video_watch(op=next)（手动接，不自动播）。',
  {
    want: z.string().optional().describe('你想看什么：主题/人物/作品/UP主关键词；没有就先去想清楚，不给就不找'),
  },
  async ({ want }) => {
    try {
      const q = String(want ?? '').trim();
      const videoState = loadVideoState();
      if (!q) {
        videoState.feed = null;
        saveVideoState(videoState);
        return { content: [{ type: 'text', text: '【先想一下】你还没说想看什么。给我一个关键词（人、作品、题材、UP主都行），我按这个词去找；不想看就关掉。' }] };
      }
      const list = await biliSearch(q, { limit: 8 });
      if (!list.length) {
        videoState.feed = null;
        saveVideoState(videoState);
        return { content: [{ type: 'text', text: `按「${q}」没找到视频——换个说法，或者关掉不看了。` }] };
      }
      // [VIDEO-STREAM] 把这次候选队列留给 video_watch(op=next) 用；仍是“她手动接下一條”。
      videoState.feed = { at: Date.now(), query: q, list, nextIndex: 0 };
      saveVideoState(videoState);
      const out = [`【按「${q}」找到 ${list.length} 条】`, renderFeed({ list, note: '' })];
      const content = [{ type: 'text', text: out.join('\n') }];
      // 封面：最多 3 张，让她"刷到"的是画面不是纯字
      for (const pic of list.slice(0, 3).map((v) => v.pic).filter(Boolean)) {
        try {
          const { buffer: buf } = await safeFetchBuffer(pic, 1500 * 1024);
          if (buf.length > 0) {
            content.push({ type: 'image', data: buf.toString('base64'), mimeType: imageMime(buf) });
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:623'); }
      }
      content[0].text += '\n（附图是前几条的封面——封面本身就是选片材料：图/字勾住你才看，封面上有字就读出来。）';
      return { content };
    } catch (error) {
      return { content: [{ type: 'text', text: `热榜没拿到：${String(error?.message ?? error).slice(0, 150)}——要不再试一次，或者把想看的链接直接给我。` }] };
    }
  }
);

server.tool(
  'video_watch',
  '像人一样看视频（一步步来，不是全片摘要）：open 打开一条 → look 看当前 30 秒（说了什么/弹幕炸在哪/画面）→ skip 跳 / rewatch 倒带 / exit 合上；next 接 video_feed 队列的下一条（先合上当前，不自动播）。画面里的字（标题卡/字幕/截图文字）直接读出来，那是信息不是装饰。耐心=能连续看几段，闲的时候多、刚聊完少，用完就是看不下去了。exit 时留一句想法（可空——"没看完"本身就是读法）。',
  {
    bvid: z.string().optional().describe('BV 号或 B 站链接（op=open 必填，其余 op 不用带）'),
    op: z.enum(['open', 'look', 'skip', 'rewatch', 'exit', 'next']),
    to: z.number().optional().describe('op=skip 时跳到第几秒'),
    take: z.string().max(120).optional().describe('op=exit 或 next 时留一句你刚才的想法（可空）'),
  },
  async ({ bvid, op, to, take }) => {
    const st = loadVideoState();
    const errText = (m) => ({ content: [{ type: 'text', text: m }] });
    try {
      if (op === 'open') {
        if (!String(bvid ?? "").trim()) return errText("op=open 要带 bvid（BV 号或 B 站链接，video_feed 列表里每条的 [BVxxx]）。其余 op 不用带。");
        if (st.active && !st.active.sess?.ended) {
          return errText(`还有一条没看完（《${st.active.sess.title}》，看到 ${st.active.sess.pos}s）——先把它 exit 掉，人一次只看一条。`);
        }
        const ctx = await openWatchContext(String(bvid ?? '').trim());
        // [ACQ-GATE] 无帧不开场：宁可说"没看成"，也不耗耐心看进度条。
        if (!videoFrameCount(ctx)) {
          logVideoMiss(st, { bvid: ctx.info.bvid, title: ctx.info.title, total: ctx.info.duration });
          return errText(`【没取到画面】「${ctx.info.title}」的 storyboard 一帧都没返回——这条不看了，也不记观看时长。换一条有画面的。`);
        }
        const patience = patienceWindows(loadLifeState(), Date.now());
        const entry = { bvid: ctx.info.bvid, title: ctx.info.title, owner: ctx.info.owner, duration: ctx.info.duration };
        const sess = openSession(entry, patience);
        st.active = { sess, ctx: { subtitle: ctx.subtitle, peaks: ctx.peaks, topPhrases: ctx.topPhrases, timedDanmakuCount: ctx.timedDanmakuCount, frames: ctx.frames } };
        saveVideoState(st);
        const mm = Math.floor((Number(ctx.info.duration) || 0) / 60);
        const ss = String((Number(ctx.info.duration) || 0) % 60).padStart(2, '0');
        const subNote = ctx.subtitle ? `字幕 ${ctx.subtitle.count} 行（拿得到"说了什么"）` : '字幕拿不到（无字幕/要登录）——文字层靠简介+弹幕，别把推断说成"我听了"。';
        return errText(`打开了「${ctx.info.title}」（UP:${ctx.info.owner}，${mm}:${ss}）。\n${subNote}\n耐心 ${patience.windows} 段（你现在的无聊度 ${patience.boredomPct}%）——接下来用 op=look 一段段看。`);
      }
      if (op === 'next') {
        let closed = '';
        if (st.active?.sess) {
          const { session: endedSession } = stepSession(st.active.sess, { op: 'exit', take });
          persistWatchMemory(endedSession, st.active.ctx);
          st.log = [...st.log.slice(-11), { ts: Date.now(), bvid: endedSession.bvid, title: endedSession.title, watched: endedSession.pos, total: endedSession.duration, take: endedSession.take, why: endedSession.ended }];
          closed = `合上了「${endedSession.title}」。\n`;
          st.active = null;
          saveVideoState(st);
        }
        let feed = st.feed;
        let seen = (st.log || []).slice(-12).map((x) => x.bvid).filter(Boolean);
        let picked = pickNextCandidate(feed, { seen });
        if (picked.exhausted) {
          if (!feed?.query) return errText(`${closed}还没有想看的词——先 video_feed 给个 want，再 next。`);
          try {
            const list = await biliSearch(feed.query, { limit: 12 });
            feed = { at: Date.now(), query: feed.query, list, nextIndex: 0 };
            picked = pickNextCandidate(feed, { seen });
          } catch (error) {
            return errText(`${closed}这一批看完了，按「${feed.query}」也没搜到新的（${String(error?.message ?? error).slice(0, 100)}）——换个关键词再 video_feed。`);
          }
        }
        if (!picked.entry) return errText(`${closed}候选流里这一轮都看过了；下次再 video_feed 换一批。`);
        const ctx = await openWatchContext(picked.entry.bvid);
        // [ACQ-GATE] 候选里也有没画面的：跳过并记一笔，不耗耐心。
        if (!videoFrameCount(ctx)) {
          feed.nextIndex = picked.nextIndex;
          st.feed = feed;
          logVideoMiss(st, { bvid: ctx.info.bvid, title: ctx.info.title, total: ctx.info.duration });
          return errText(`${closed}【没取到画面】「${ctx.info.title}」一帧都没返回——跳过，没看，也不计时。再 next 换一条。`);
        }
        const patience = patienceWindows(loadLifeState(), Date.now());
        const sess = openSession({ bvid: ctx.info.bvid, title: ctx.info.title, owner: ctx.info.owner, duration: ctx.info.duration }, patience);
        feed.nextIndex = picked.nextIndex;
        st.feed = feed;
        st.active = { sess, ctx: { subtitle: ctx.subtitle, peaks: ctx.peaks, topPhrases: ctx.topPhrases, timedDanmakuCount: ctx.timedDanmakuCount, frames: ctx.frames } };
        saveVideoState(st);
        const mm = Math.floor((Number(ctx.info.duration) || 0) / 60);
        const ss = String((Number(ctx.info.duration) || 0) % 60).padStart(2, '0');
        return errText(`${closed}接上一条「${ctx.info.title}」（UP:${ctx.info.owner}，${mm}:${ss}）。\n${ctx.subtitle ? `字幕 ${ctx.subtitle.count} 行` : '字幕拿不到（无字幕/要登录）'}；耐心 ${patience.windows} 段。接下来用 op=look 一段段看。`);
      }
      const a = st.active;
      if (!a?.sess) return errText('没有正在看的视频——先 video_feed 挑一条，再 open。');
      const prevPos = Number(a.sess.pos) || 0;
      const prevWindows = Number(a.sess.windowsLeft) || 0;
      const { session, note, viewWindow } = stepSession(a.sess, { op, to, take });
      // [VIDEO-FRAME-FIX] 先保存“这一步行进没有”，再写回 a.sess。
      // 旧代码先 `a.sess = session` 再判断 `session !== a.sess`，恒为 false：
      // look/skip 永远不渲染窗口文本、也不下载关键帧，她只能看到“进度在走”。
      const shouldRenderWindow = Boolean(viewWindow);
      a.sess = session;
      let extra = '';
      const imageUrls = [];
      if (shouldRenderWindow) {
        // 只有真的动了（look/skip/rewatch）才切窗口内容
        const view = windowView(a.ctx, viewWindow.from, viewWindow.to);
        const hasSubs = Array.isArray(view.subs) && view.subs.length > 0;
        const hasFrames = Array.isArray(view.frames) && view.frames.length > 0;
        // [ACQ-GATE] 这一段既没字幕也没画面 = 没取到东西：回滚这一步，关掉，不计观看时长。
        if (!hasSubs && !hasFrames && (op === 'look' || op === 'skip')) {
          session.pos = prevPos;
          session.windowsLeft = prevWindows;
          session.ended = 'no-signal';
          session.take = null;
          a.sess = session;
          st.log = [...(Array.isArray(st.log) ? st.log.slice(-11) : []), {
            ts: Date.now(), bvid: session.bvid, title: session.title,
            watched: 0, total: session.duration, take: '这段没画面也没字幕，没看成', why: 'no-signal',
          }];
          st.active = null;
          saveVideoState(st);
          return errText(`【没取到任何东西】这段没画面也没字幕——关了。这步不算看，观看时长仍是 ${session.pos}s，也没写记忆。`);
        }
        if (!hasSubs && !hasFrames) {
          extra = '（这段没取到画面/字幕——别把推断说成看到的。）';
        } else {
          extra = renderLookNote(viewWindow, view, session);
          // [EYES] 多张拼图时挑这一刻对应的那张，不再永远是第一张。
          const sheets = a.ctx?.frames?.imagesAll?.length ? a.ctx.frames.imagesAll : (view.frames ?? []);
          const picked = (view.frames ?? []).length
            ? lookAt(sheets, viewWindow.from, { coverage: a.ctx?.frames?.coverage }).slice(0, 3)
            : [];
          imageUrls.push(...picked.map((e) => e.url));
        }
      }
      if (session.ended === 'chose' || (session.ended && op === 'exit')) {
        persistWatchMemory(session, a.ctx);
        st.log = [...st.log.slice(-11), { ts: Date.now(), bvid: session.bvid, title: session.title, watched: session.pos, total: session.duration, take: session.take, why: session.ended }];
        st.active = null;
        saveVideoState(st);
        extra += `\n（这段看过的已记进记忆库——含你刚才那句话。若刚才那句只是在复述内容，现在补一句你由此想到了什么也来得及：qq_memory_append。）`;
      } else {
        saveVideoState(st);
      }
      const content = [{ type: 'text', text: note + (extra ? `\n${extra}` : '') }];
      for (const u of imageUrls) {
        try {
          const { buffer: buf } = await safeFetchBuffer(u, 3 * 1024 * 1024);
          if (buf.length > 0) {
            content.push({ type: 'image', data: buf.toString('base64'), mimeType: imageMime(buf) });
          }
        } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'mcp-host-server.js:692'); }
      }
      return { content };
    } catch (error) {
      return errText(`看视频出岔子：${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
);

// [WALL-TEST] 测试钩子（生产 inert）：node 侧脚本 import 本文件后可直接调 adjustWall
// 走 MZ_WALL_FILE / MZ_WALL_LOG 覆盖的临时文件，不碰真名单。
globalThis.__wallTest = { adjustWall };

await server.connect(new StdioServerTransport());
