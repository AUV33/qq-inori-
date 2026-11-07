// phone-mcp · 安卓手机/模拟器控制 MCP 服务器（stdio）
//
// 用法：
//   1) 手机开启「开发者选项 → 无线调试」（Android 11+），或用 USB 连接
//   2) npx phone-mcp            （自动探测 adb 与设备）
//   3) 在任意支持 MCP 的客户端里配置它
//
// 环境变量（都可选）：
//   PHONE_ADB         adb 可执行文件路径（默认自动探测 PATH / 常见安装位置）
//   PHONE_SERIAL      设备序列号（默认选第一个已连接设备）
//   PHONE_SHOT_DIR    截图输出目录（默认 系统临时目录/phone-mcp-shots）
//   PHONE_MACRO_FILE  宏存储文件（默认 用户目录/.phone-mcp/macros.json）
//   PHONE_FFMPEG      ffmpeg 路径（默认自动探测，仅 video_frames 需要）
//
// 设计要点：
// - 只依赖本机 adb；手机侧无需安装任何 APP。
// - 中文输入走 ADBKeyboard（可选安装）；未装时会明确提示，不静默失败。
// - 所有 adb 调用都带超时，避免挂死。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as ncm from './ncm.js';
import { scalePng } from './png-scale.js';
import { INORI_ROOT, dataPath, bridgeStatePath } from '../../shared/inori-paths.mjs';
import { readSkillsFile, skillsForApp, renderActivityContext, activityName, readActivityExtras } from '../../shared/activity-context.mjs';
import { readActivityResources, renderResourceLine } from '../../shared/game-resources.mjs';
// [TOOL-CATALOG] 核心常驻 + 分类目录按需调用（省 token：未常驻的工具不再随每次请求发 schema）
import { installToolCatalog } from '../../shared/mcp-tool-catalog.mjs';

const execFileAsync = promisify(execFile);

// ── 可选配置（不填也能用，只是部分工具需要）──
const OWNER_MUSIC_UID = process.env.PHONE_MUSIC_OWNER_UID || '';

// ── 路径：全部自动探测，可用环境变量覆盖 ──
function findAdb() {
  if (process.env.PHONE_ADB) return process.env.PHONE_ADB;
  const cands = [];
  if (process.env.ANDROID_HOME) cands.push(path.join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.env.ANDROID_SDK_ROOT) cands.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.platform === 'win32') {
    cands.push('C:\\platform-tools\\adb.exe', 'C:\\adb\\adb.exe', 'D:\\platform-tools\\adb.exe');
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  } else {
    cands.push('/usr/local/bin/adb', '/usr/bin/adb', path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'));
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'adb';   // 交给 PATH
}
const ADB = findAdb();
const SHOT_DIR = process.env.PHONE_SHOT_DIR || path.join(os.tmpdir(), 'phone-mcp-shots');
// 默认设备：留空 = 自动选第一个已连接设备（可用 PHONE_SERIAL 固定到某一台）
let SERIAL = process.env.PHONE_SERIAL || '';

// ── [DEVICE-LOCK] 一台手机同一时刻只跑一个动作（2026-10-25 任务池并行后的必要约束）──
// 任务池把任务拆到多个独立会话并行跑，每个会话各有自己的 phone MCP 进程；
// 两条 adb 交错执行会把两边都搞乱（点了 A 才发现界面是 B 的）。所以：
//   进程内用 promise 队列串行；跨进程用 lock 文件（持有进程死了 / 超 120s 自动抢占，
//   不让一个崩掉的进程把手机永久锁死）。同进程重入（shell→adb）不再排队，防自锁死。
const DEVICE_LOCK_FILE = process.env.MZ_PHONE_LOCK || bridgeStatePath('phone-device.lock');
let deviceQueue = Promise.resolve();
let deviceDepth = 0;

async function acquireDeviceLock(maxWaitMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(DEVICE_LOCK_FILE), { recursive: true });
      fs.writeFileSync(DEVICE_LOCK_FILE, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') return; // 锁文件写不了：降级为仅进程内串行，不影响可用性
      try {
        const age = Date.now() - fs.statSync(DEVICE_LOCK_FILE).mtimeMs;
        const pid = Number(String(fs.readFileSync(DEVICE_LOCK_FILE, 'utf8') || '').trim());
        let alive = false;
        if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
        if (!alive || age > 120000) { fs.rmSync(DEVICE_LOCK_FILE, { force: true }); continue; }
      } catch { /* 刚好被释放，直接重试 */ }
      if (Date.now() - t0 > maxWaitMs) throw new Error('手机正被另一件事占用（等了太久），稍后再试。');
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
function releaseDeviceLock() { try { fs.rmSync(DEVICE_LOCK_FILE, { force: true }); } catch { /* ignore */ } }

/** 串行执行一次设备动作（同进程重入不再排队）。 */
async function withDeviceLock(fn) {
  if (deviceDepth > 0) return fn();
  const run = deviceQueue.then(async () => {
    deviceDepth += 1;
    try {
      await acquireDeviceLock();
      return await fn();
    } finally {
      releaseDeviceLock();
      deviceDepth -= 1;
    }
  });
  deviceQueue = run.then(() => {}, () => {});
  return run;
}

async function adb(args, { timeout = 30000, serial = true } = {}) {
  return withDeviceLock(async () => {
    const full = serial && SERIAL ? ['-s', SERIAL, ...args] : args;
    try {
      const { stdout, stderr } = await execFileAsync(ADB, full, {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return { ok: true, out: String(stdout ?? ''), err: String(stderr ?? '') };
    } catch (e) {
      return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) };
    }
  });
}

async function ensureDevice() {
  if (SERIAL) return SERIAL;
  const r = await adb(['devices'], { serial: false });
  const lines = r.out.split(/\r?\n/).slice(1).filter((l) => l.trim());
  const ready = lines.map((l) => l.split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0]);
  if (!ready.length) {
    throw new Error('没有已连接的设备。先让手机开启「无线调试」，再用 phone_pair / phone_connect。');
  }
  SERIAL = ready[0];
  return SERIAL;
}

async function shell(cmd, timeout = 30000) {
  await ensureDevice();
  const r = await adb(['shell', cmd], { timeout });
  if (!r.ok) throw new Error(`adb shell 失败：${r.err || r.out}`);
  return r.out;
}

// [SPEED] 二进制直取：exec-out 不落盘、不 pull，一次往返拿 PNG（实测比 shell+pull 省约 180ms/次）
function adbBuf(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', windowsHide: true }, (err, stdout) => {
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
      resolve({ ok: !err && buf.length > 0, buf, message: err?.message ?? '' });
    });
  });
}

// [DUMP-CACHE] uiautomator dump 在这台设备上约 2.7s，是她操作循环里最贵的一步。
// 缓存最近一次 dump：20 秒内、且之后没做过任何会改界面的动作时，phone_tap_text 直接复用，
// 省掉一次整 dump。任何点击/按键/滑动/打字/启动 App 都会把缓存标记为失效。
let lastDump = { xml: '', at: 0, stale: true };
const markDumpStale = () => { lastDump.stale = true; };
async function readUiXml(force = false) {
  await ensureDevice();
  if (!force && !lastDump.stale && lastDump.xml && Date.now() - lastDump.at < 20000) {
    return { xml: lastDump.xml, cached: true };
  }
  // 一次 shell 里 dump+cat：少一次进程往返
  const r = await adb(['shell', 'uiautomator dump /sdcard/_dsh_ui.xml >/dev/null 2>&1; cat /sdcard/_dsh_ui.xml'], { timeout: 30000 });
  const xml = String(r.out || '');
  lastDump = { xml, at: Date.now(), stale: false };
  return { xml, cached: false };
}

/** 把 uiautomator XML 解析成「可点元素清单」（dock 的 dump 与 phone_batch 共用）。 */
function parseUiItems(xml, max = 60) {
  const items = [];
  const re = /<node[^>]*>/g;
  let m;
  while ((m = re.exec(String(xml ?? ''))) !== null) {
    const tag = m[0];
    const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
    const t = get('text') || get('content-desc');
    const cls = (get('class') || '').split('.').pop();
    const clickable = get('clickable') === 'true';
    const bm = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const [, x1, y1, x2, y2] = bm.map(Number);
    if (!t && !clickable) continue;
    items.push({
      text: t.slice(0, 40),
      type: cls,
      clickable,
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    });
    if (items.length >= max) break;
  }
  return items;
}

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

const server = new McpServer({ name: 'phone', version: '0.1.0' });

// [TOOL-CATALOG] 8 个高频工具常驻，其余 33 个收进 phone_tools 分类目录。
// 必须在所有 server.tool(...) 之前安装；下面是"注册面"改造，工具实现一行未动。
installToolCatalog(server, {
  catalogName: 'phone_tools',
  catalogDescription: '【工具目录】手机工具大部分没有常驻，按分类收着。用法：① 不传参数 → 列出所有分类；② 只传 category → 列出该分类下的工具和用途；③ 传 tool + arguments → 直接调用那个工具（参数和它原本的 schema 一致）。常驻可直接用的是：phone_look / phone_dump / phone_tap / phone_text / phone_open_app / phone_status / phone_info / phone_macro / phone_tap_desc。',
  coreTools: [
    'phone_look', 'phone_dump', 'phone_tap', 'phone_text',
    'phone_open_app', 'phone_status', 'phone_info', 'phone_macro',
    // [TAP-DESC] UI 树读不到的界面（Unity 游戏/网页）靠视觉定位点，必须常驻——否则她又回去猜坐标。
    'phone_tap_desc',
  ],
  groups: {
    设备连接: ['phone_pair', 'phone_connect', 'phone_devices'],
    屏幕操作: ['phone_screenshot', 'phone_tap_text', 'phone_key', 'phone_swipe', 'phone_batch'],
    宏与录制: ['phone_record_screen', 'video_frames'],
    视觉识别: ['phone_ocr', 'phone_find_template', 'phone_tap_template', 'phone_template_save', 'phone_templates'],
    网易云音乐: [
      'music_lyrics', 'ncm_now', 'ncm_room', 'ncm_control', 'ncm_room_control', 'ncm_play',
      'ncm_comments', 'ncm_search', 'ncm_inbox', 'ncm_msg_users', 'ncm_room_say',
    ],
    QQ空间: ['qzone_post', 'qzone_my_posts', 'qzone_like', 'qzone_comment', 'qzone_user_posts', 'qzone_feeds', 'qzone_recent_like'],
  },
});

server.tool(
  'music_lyrics',
  '查一首歌的歌词（网易云公开接口）。想跟主人聊他正在听的歌、或者想引一句歌词时用它。给歌名就行，歌手可选。',
  {
    song: z.string().describe('歌名，例如「遐想」'),
    artist: z.string().optional().describe('歌手名（可选，用来在同名歌里挑准的那首）'),
  },
  async ({ song, artist }) => {
    const UA = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://music.163.com/',
    };
    const q = artist ? `${song} ${artist}` : song;
    let songs = [];
    try {
      const r = await fetch(
        `https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=6`,
        { headers: UA }
      );
      const j = await r.json();
      songs = (j && j.result && j.result.songs) || [];
    } catch (e) {
      return fail(`搜歌失败：${e && e.message ? e.message : e}`);
    }
    if (!songs.length) return text(`没搜到「${q}」这首歌，换个写法试试（比如只给歌名）。`);
    // 挑最像的：名字完全相等优先，其次名字包含
    const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
    const target = norm(song);
    let best = songs[0];
    for (const s of songs) {
      if (norm(s.name) === target) { best = s; break; }
      if (norm(s.name).includes(target) && norm(best.name) !== target) best = s;
    }
    const id = best.id;
    let lrc = '';
    try {
      const r2 = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, { headers: UA });
      const j2 = await r2.json();
      lrc = (j2 && j2.lrc && j2.lrc.lyric) || '';
    } catch (e) {
      return fail(`拉歌词失败：${e && e.message ? e.message : e}`);
    }
    if (!lrc.trim()) return text(`《${best.name}》找到了（id=${id}），但这首没有歌词（纯音乐或者没上传歌词）。`);
    // 去掉时间轴、去掉空行，最多 40 行
    const lines = lrc
      .split(/\r?\n/)
      .map((l) => l.replace(/^\[[^\]]*\]\s*/g, '').trim())
      .filter((l) => l && !/^作词|^作曲|^编曲|^制作人|^出品|^混音|^母带|^录音|^吉他|^贝斯|^鼓|^键盘|^和声|^监制|^统筹|^企划|^OP|^SP|^发行/.test(l))
      .slice(0, 40);
    const who = (best.artists || []).map((a) => a.name).join('/');
    return text(
      `《${best.name}》 - ${who}（id=${id}）\n` +
        `歌词（前 ${lines.length} 句）：\n${lines.join('\n')}\n\n` +
        `（想聊哪一句就直接引出来，别整段念。）`
    );
  }
);

// ── 网易云 PC 版（CDP + 内部 store） ────────────────────────────────────────
server.tool(
  'ncm_now',
  '看主人现在在网易云听什么：歌名/歌手/进度/是否在播放/正在唱的那一句歌词。这是你的"耳朵"——聊歌、接歌词、说"你在听这首啊"都用它。',
  {},
  async () => {
    try {
      const r = await ncm.earsReport();
      if (!r.ok) return text(r.error || '读不到播放状态。');
      const mm = Math.floor((r.duration || 0) / 60);
      const ss = Math.round((r.duration || 0) % 60);
      let s = `主人现在在听：《${r.title}》- ${r.artist}`;
      if (r.album) s += `（专辑《${r.album}》）`;
      if (r.duration) s += ` 全长 ${mm}:${String(ss).padStart(2, '0')}`;
      s += r.playing ? '  ▶ 正在播放' : '  ⏸ 暂停中';
      if (r.currentLine) s += `\n正在唱的这一句：「${r.currentLine}」`;
      if (r.nearby && r.nearby.length) {
        s += '\n前后几句：\n' + r.nearby.map((l) => (l.current ? '  ▶ ' : '    ') + l.text).join('\n');
      }
      return text(s);
    } catch (e) {
      return fail('读播放状态失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_room',
  '看网易云「一起听」房间状态：在不在房间里、房间里还有谁、一起听了多久、房间歌单几首。',
  {},
  async () => {
    try {
      const r = await ncm.roomState();
      if (!r.roomId) return text('现在没在「一起听」房间里（status=' + (r.status || '?') + '）。');
      const others = (r.members || []).filter((m) => String(m.id) !== String(r.creatorId));
      return text(
        `在「一起听」房间里 ✓\n` +
          `  房间号：${r.roomId}\n` +
          `  房主 id：${r.creatorId}\n` +
          `  成员：${(r.members || []).map((m) => m.name || m.id).join('、') || '（读不到名字）'}\n` +
          `  一起听了 ${Math.round((r.totalSec || 0) / 60)} 分钟（第 ${r.listenCount || 0} 次）\n` +
          `  歌单：${r.songCount || 0} 首`
      );
    } catch (e) {
      return fail('读房间失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_control',
  '控制网易云 PC 版的播放：play 继续 / pause 暂停 / next 下一首 / previous 上一首。',
  { command: z.enum(['play', 'pause', 'next', 'previous']).describe('要执行的命令') },
  async ({ command }) => {
    try {
      await ncm.control(command);
      return text('已执行：' + command);
    } catch (e) {
      return fail('控制失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_room_control',
  '在「一起听」房间里控制同步播放：PLAY 继续 / PAUSE 暂停 / NEXT 下一首（需要 ids=[前一首id,目标id]）/ GOTO 跳转。房间里的两个人会一起变。',
  {
    command: z.enum(['PLAY', 'PAUSE', 'NEXT', 'PREVIOUS', 'GOTO']).describe('房间命令'),
    ids: z.array(z.string()).optional().describe('NEXT/PREVIOUS/GOTO 需要：[当前歌曲id, 目标歌曲id]'),
    position: z.number().optional().describe('GOTO 时的秒数'),
  },
  async ({ command, ids, position }) => {
    try {
      await ncm.roomControl(command, { ids: ids || null, position: position == null ? null : position });
      return text('房间命令已发：' + command);
    } catch (e) {
      return fail('房间控制失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_play',
  '让 PC 版网易云播放指定的歌（本地播放，不走房间）：给歌名就行，歌手可选，或者直接给 songId。',
  {
    song: z.string().optional().describe('歌名'),
    artist: z.string().optional().describe('歌手（可选）'),
    songId: z.string().optional().describe('直接给网易云歌曲 id（可选，比歌名准）'),
  },
  async ({ song, artist, songId }) => {
    try {
      let id = songId ? String(songId) : '';
      let name = song || '';
      if (!id) {
        if (!song) return fail('至少给个歌名或者 songId。');
        const list = await ncm.search(artist ? song + ' ' + artist : song, 6);
        if (!list.length) return fail('没搜到「' + song + '」');
        const norm = (s) => String(s || '').replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
        const want = norm(song);
        let best = list[0];
        for (const x of list) {
          if (norm(x.name) === want) { best = x; break; }
          if (norm(x.name).includes(want) && norm(best.name) !== want) best = x;
        }
        id = String(best.id);
        name = best.name;
      }
      const r = await ncm.playSong(id, name);
      return text(r.ok ? `已经在放了：《${name}》` : '没放成：' + (r.error || '未知原因'));
    } catch (e) {
      return fail('点歌失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_comments',
  '看某首歌的网易云评论（热评 + 最新）。想跟主人聊某首歌的风评、或者想找条有意思的评论念给他听时用。',
  {
    songId: z.string().describe('歌曲 id（可以用 ncm_search 或 music_lyrics 拿到）'),
    limit: z.number().optional().describe('各取几条，默认 5'),
  },
  async ({ songId, limit }) => {
    try {
      const n = Math.max(1, Math.min(20, Number(limit) || 5));
      const c = await ncm.comments(songId, n, 0);
      const fmt = (arr, head) =>
        arr.length ? head + '\n' + arr.map((x) => `  ${x.user}（${x.likes}赞）：${String(x.text).replace(/\n/g, ' ').slice(0, 120)}`).join('\n') : '';
      return text(`这首歌共 ${c.total} 条评论\n` + [fmt(c.hot, '【热评】'), fmt(c.latest, '【最新】')].filter(Boolean).join('\n'));
    } catch (e) {
      return fail('读评论失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_search',
  '在网易云搜歌，返回 id 和歌名歌手。点歌、查歌词、看评论之前先用它拿 id。',
  {
    keyword: z.string().describe('搜索词，歌名或者"歌名 歌手"'),
    limit: z.number().optional().describe('返回几条，默认 6'),
  },
  async ({ keyword, limit }) => {
    try {
      const list = await ncm.search(keyword, Math.max(1, Math.min(20, Number(limit) || 6)));
      if (!list.length) return text('没搜到。');
      return text(list.map((x) => `${x.id}  ${x.name} - ${x.artist}${x.album ? ' 《' + x.album + '》' : ''}`).join('\n'));
    } catch (e) {
      return fail('搜索失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_inbox',
  '看主人在网易云给你发的私信（借客户端的手读，不需要密码）。他在网易云里发给你的话，用这个就能看到。',
  {
    userId: z.string().optional().describe('对方的网易云数字 id（可选，默认取配置里的 ownerMusicUid）'),
    limit: z.number().optional().describe('看几条，默认 10'),
  },
  async ({ userId, limit }) => {
    try {
      const who = String(userId || OWNER_MUSIC_UID || '');
      const n = Math.max(1, Math.min(30, Number(limit) || 10));
      const r = await ncm.inbox(who, n);
      if (!r.ok) return fail('读私信失败：' + JSON.stringify(r).slice(0, 200));
      if (!r.list.length) return text('（还没有私信。你在网易云里发给主人的话会出现在这里。）');
      return text(
        r.list
          .map((x) => `[${new Date((x.time || 0)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${x.self ? '你' : x.fromNick || x.from}：${x.text}`)
          .join('\n')
      );
    } catch (e) {
      return fail('读私信失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'ncm_msg_users',
  '列出你的网易云私信会话（都有谁给你发过消息）。',
  {},
  async () => {
    try {
      const r = await ncm.msgUsers(20);
      if (!r.ok) return fail('读会话列表失败：' + JSON.stringify(r).slice(0, 200));
      if (!r.list.length) return text('（还没有任何私信会话。）');
      return text(r.list.map((x) => `${x.userId}  ${x.nick || '(无昵称)'}：${x.last}`).join('\n'));
    } catch (e) {
      return fail('读会话列表失败：' + (e && e.message ? e.message : e));
    }
  }
);


// ── ROOM_SAY_V3：快速版（聊天框已开就只打字+发送 ✗ ~8 秒） ──────────────────
const ROOM_EMU = process.env.ROOM_EMU_SERIAL || 'emulator-5554';
const EMU_SHOT_DIR = SHOT_DIR;
const SELF_MUSIC_UID = process.env.PHONE_MUSIC_SELF_UID || '';

async function emuAdb(args, timeout = 20000) {
  return withDeviceLock(async () => {
    try {
      const { stdout, stderr } = await execFileAsync(ADB, ['-s', ROOM_EMU, ...args], {
        timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
      return { ok: true, out: String(stdout ?? ''), err: String(stderr ?? '') };
    } catch (e) {
      return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) };
    }
  });
}
const emuSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ensureIme：确保 ADBKeyboard 是当前输入法（模拟器重启后会被重置 ✗ 这里自愈）──
let imeChecked = 0;
async function ensureIme(force = false) {
  const now = Date.now();
  if (!force && now - imeChecked < 60000) return true;   // 一分钟内不重复查
  const IME = 'com.android.adbkeyboard/.AdbIME';
  const cur = String((await adb(['shell', 'settings', 'get', 'secure', 'default_input_method'])).out || '').trim();
  if (cur === IME) { imeChecked = now; return true; }
  // 修：先启用 ✗ 再把列表和默认都设成它
  await adb(['shell', 'ime', 'enable', IME]);
  await adb(['shell', 'settings', 'put', 'secure', 'enabled_input_methods',
    IME + ':com.android.inputmethod.pinyin/.InputService']);
  await adb(['shell', 'settings', 'put', 'secure', 'default_input_method', IME]);
  await emuSleep(600);
  const after = String((await adb(['shell', 'settings', 'get', 'secure', 'default_input_method'])).out || '').trim();
  log ? log('[ime] 输入法 ' + cur + ' → ' + after) : null;
  imeChecked = Date.now();
  return after === IME;
}

const COMPOSER_INPUT = ['75', '639'];
const SEND_SPOTS = [['613', '627'], ['609', '623'], ['620', '623'], ['1219', '367']];
const CHAT_ENTRY_SPOTS = [['411', '478'], ['347', '467'], ['325', '487'], ['313', '495']];

// 键盘开着 = 聊天框开着（一次 dumpsys ✗ 约 0.4 秒）
async function composerOpen() {
  const r = await emuAdb(['shell', 'dumpsys', 'input_method']);
  return String(r.out).includes('mInputShown=true');
}

server.tool(
  'ncm_room_say',
  '在你们的一起听房间里说话 —— 用她自己的账号真发到房间聊天框里，主人手机上马上能看到。想陪他聊天、接歌词、吐槽切歌、说晚安时用它。注意：只有【他刚给你发过消息】时聊天框才打得开 ✓',
  { text: z.string().describe('要说的话，一到两句，短一点更自然') },
  async ({ text: say }) => {
    const msg = String(say || '').trim();
    if (!msg) return fail('要说的话不能为空。');
    if (msg.length > 120) return fail('太长了，房间里说话短一点（120 字以内）。');
    try {
      // ① 确认网易云在前台（不在就启动）
      const win = await emuAdb(['shell', 'dumpsys', 'window']);
      const fg = (String(win.out).match(/mCurrentFocus=(\S+)/) || [])[1] || '';
      if (!fg.includes('com.netease.cloudmusic')) {
        await emuAdb(['shell', 'input', 'keyevent', '3']);
        await emuSleep(1200);
        const act = await emuAdb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', 'com.netease.cloudmusic']);
        const comp = String(act.out || '').trim().split(/\r?\n/).pop().trim();
        if (comp && comp.includes('/')) await emuAdb(['shell', 'am', 'start', '-n', comp]);
        await emuSleep(13000);
      }
      // ② 进播放页
      await emuAdb(['shell', 'input', 'tap', '267', '653']);
      await emuSleep(4500);

      // ③ 依次试各个候选位置 ✗ 每次点完看看输入框有没有出现
      let opened = false;
      for (const spot of CHAT_ENTRY_SPOTS) {
        await emuAdb(['shell', 'input', 'tap', spot[0], spot[1]]);
        await emuSleep(2500);
        // 点完试探一下：点输入框位置 ✗ 再截图看有没有键盘（键盘弹出会让屏幕变矮 ✓）
        await emuAdb(['shell', 'input', 'tap', COMPOSER_INPUT[0], COMPOSER_INPUT[1]]);
        await emuSleep(1200);
        const kb = await emuAdb(['shell', 'dumpsys', 'input_method']);
        if (String(kb.out).includes('mInputShown=true')) { opened = true; break; }
      }
      if (!opened) {
        // 打不开就诚实告诉她 ✗ 别假装成功
        return fail('房间聊天框打不开（他可能还没给你发新消息 ✗ 聊天框只在有未读时出现）。' +
          '这次就别在房间里发了 ✗ 直接用 QQ 回他 ✓');
      }

      // ④ 打中文
      await emuAdb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', msg]);
      await emuSleep(2200);

      // ⑤ 点发送（键盘弹出时和收起时位置不同 ✗ 两个都点）
      await emuAdb(['shell', 'input', 'tap', '1219', '367']);
      await emuSleep(1500);
      await emuAdb(['shell', 'input', 'tap', '613', '627']);
      await emuSleep(2500);

      // ⑥ 截图自检
      try { await emuAdb(['shell', 'mkdir', '-p', '/sdcard/_shots']); } catch {}
      await emuAdb(['shell', 'screencap', '-p', '/sdcard/_roomsay.png']);
      try { await emuAdb(['pull', '/sdcard/_roomsay.png', EMU_SHOT_DIR + '\\roomsay.png']); } catch {}
      return text('已经在房间里说了：「' + msg + '」\n（截图: ' + EMU_SHOT_DIR + '\\roomsay.png ✗ 可以看图确认有没有真发出去 ✓）');
    } catch (e) {
      return fail('发到房间失败：' + (e && e.message ? e.message : e));
    }
  }
);

server.tool(
  'phone_macro',
  '★连招★ 一次调用执行一串手机动作（点按 / 滑动 / 长按 / 按键 / 等待）——玩游戏、刷视频、重复操作时用这个，比一个个调 phone_tap 快几十倍。每条动作之间会自动等一小会儿，你也可以用 sleep 自己插延迟。',
  {
    actions: z.array(z.object({
      type: z.enum(['tap', 'swipe', 'longpress', 'key', 'sleep', 'text']).describe('动作类型'),
      x: z.number().optional().describe('tap/longpress 的 x 坐标'),
      y: z.number().optional().describe('tap/longpress 的 y 坐标'),
      x2: z.number().optional().describe('swipe 终点 x'),
      y2: z.number().optional().describe('swipe 终点 y'),
      ms: z.number().optional().describe('longpress 时长 / sleep 毫秒 / swipe 滑动时长（默认 200）'),
      key: z.string().optional().describe('key 动作：back/home/enter/recent/volume_up/volume_down/power/delete'),
      text: z.string().optional().describe('text 动作：要输入的文本（支持中文 ✗ 需装 ADBKeyboard ✓）')
    })).min(1).max(200).optional().describe('动作列表，按顺序执行（用 playName 播放已存宏时可省略）'),
    stepMs: z.number().optional().describe('每个动作之后默认等待毫秒（默认 400 ✗ 玩游戏可调小到 150）'),
    repeat: z.number().optional().describe('★整套动作重复几次（默认 1 ✗ 最多 200）✗ 玩游戏刷同一套操作时用它，只花一次调用'),
    repeatGapMs: z.number().optional().describe('每次重复之间的等待毫秒（默认 300 ✗ 打怪可以 100）'),
    saveAs: z.string().optional().describe('★把这套动作存成命名的宏（下次用 playName 一键放）✗ 名字用英文/数字/下划线'),
    playName: z.string().optional().describe('★播放之前存过的宏（这时 actions 可以不传）'),
    listMacros: z.boolean().optional().describe('列出所有存过的宏'),
    screenshot: z.boolean().optional().describe('最后是否截图（默认 true ✗ 玩游戏想快就传 false）')
  },
  async ({ actions, stepMs = 400, repeat = 1, repeatGapMs = 300, screenshot = true, saveAs, playName, listMacros }) => {
    await ensureDevice();
    // ── 命名宏存取（存在 state/phone-macros.json）──
    const MACRO_FILE = process.env.PHONE_MACRO_FILE || path.join(os.homedir(), '.phone-mcp', 'macros.json');
    const loadMacros = () => { try { return JSON.parse(fs.readFileSync(MACRO_FILE, 'utf8')); } catch { return {}; } };
    const saveMacros = (m) => { try { fs.mkdirSync(path.dirname(MACRO_FILE), { recursive: true }); fs.writeFileSync(MACRO_FILE, JSON.stringify(m, null, 2), 'utf8'); } catch {} };

    if (listMacros) {
      const m = loadMacros();
      const names = Object.keys(m);
      if (!names.length) return text('还没有存过任何宏 ✗ 用 saveAs 存一个吧 ✓');
      return text('存过的宏（' + names.length + ' 个）✗\n' + names.map((n) => '· ' + n + '（' + (m[n].actions || []).length + ' 个动作' + (m[n].note ? ' ✗ ' + m[n].note : '') + '）').join('\n'));
    }
    if (playName) {
      const m = loadMacros();
      const hit = m[String(playName).trim()];
      if (!hit) return fail('没有叫「' + playName + '」的宏 ✗ 用 listMacros 看看有哪些 ✓');
      actions = hit.actions;
      if (hit.stepMs && stepMs === 400) stepMs = hit.stepMs;
      console.error('[macro] 播放宏 ' + playName + '（' + actions.length + ' 个动作 × ' + repeat + '）');
    }
    if (saveAs) {
      const nm = String(saveAs).trim().replace(/[^\w\-]/g, '_').slice(0, 40);
      if (!nm) return fail('saveAs 名字不合法');
      const m = loadMacros();
      m[nm] = { actions: actions || [], stepMs, savedAt: new Date().toISOString() };
      saveMacros(m);
      console.error('[macro] 已存宏 ' + nm + '（' + (actions || []).length + ' 个动作）');
      return text('已存成宏「' + nm + '」✗ 以后用 phone_macro({playName:"' + nm + '", repeat:N}) 一键放 ✓');
    }
    if (!Array.isArray(actions) || !actions.length) {
      return fail('要么给 actions ✗ 要么用 playName 放一个存过的宏（listMacros 看列表）');
    }
    const done = [];
    const t0 = Date.now();
    try {
      const rounds = Math.max(1, Math.min(200, Math.round(Number(repeat) || 1)));
      for (let round = 0; round < rounds; round++) {
      if (round > 0 && repeatGapMs > 0) {
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10000, repeatGapMs))));
      }
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const type = String(a.type || '');
        if (type === 'sleep') {
          const ms = Math.max(10, Math.min(30000, Number(a.ms ?? 500)));
          await new Promise((r) => setTimeout(r, ms));
          done.push('sleep ' + ms);
          continue;
        }
        if (type === 'tap') {
          if (a.x == null || a.y == null) throw new Error('tap 需要 x/y');
          await adb(['shell', 'input', 'tap', String(Math.round(a.x)), String(Math.round(a.y))]);
          done.push('tap(' + Math.round(a.x) + ',' + Math.round(a.y) + ')');
        } else if (type === 'longpress') {
          if (a.x == null || a.y == null) throw new Error('longpress 需要 x/y');
          const ms = Math.max(300, Math.min(10000, Number(a.ms ?? 800)));
          // adb 没有原生长按 ✗ 用 swipe 原地划（起点=终点 ✗ 时长=按压时长）
          await adb(['shell', 'input', 'swipe', String(Math.round(a.x)), String(Math.round(a.y)),
            String(Math.round(a.x)), String(Math.round(a.y)), String(ms)]);
          done.push('longpress(' + Math.round(a.x) + ',' + Math.round(a.y) + ',' + ms + 'ms)');
        } else if (type === 'swipe') {
          if (a.x == null || a.y == null || a.x2 == null || a.y2 == null) throw new Error('swipe 需要 x/y/x2/y2');
          const ms = Math.max(50, Math.min(5000, Number(a.ms ?? 200)));
          await adb(['shell', 'input', 'swipe', String(Math.round(a.x)), String(Math.round(a.y)),
            String(Math.round(a.x2)), String(Math.round(a.y2)), String(ms)]);
          done.push('swipe(' + Math.round(a.x) + ',' + Math.round(a.y) + '→' + Math.round(a.x2) + ',' + Math.round(a.y2) + ')');
        } else if (type === 'key') {
          const k = String(a.key || '').trim();
          const allowed = ['back', 'home', 'enter', 'recent', 'volume_up', 'volume_down', 'power', 'delete'];
          if (!allowed.includes(k)) throw new Error('key 只能是: ' + allowed.join('/'));
          await adb(['shell', 'input', 'keyevent', k.toUpperCase()]);
          done.push('key ' + k);
        } else if (type === 'text') {
          const s = String(a.text ?? '');
          if (!s) throw new Error('text 不能为空');
          await ensureIme();
          await adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', s]);
          done.push('text(' + s.slice(0, 12) + ')');
        } else {
          throw new Error('未知动作类型: ' + type);
        }
        if (i < actions.length - 1 && stepMs > 0) {
          await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5000, stepMs))));
        }
      }
      }
      const sec = ((Date.now() - t0) / 1000).toFixed(2);
      let shotLine = '';
      if (screenshot) {
        const shot = await adb(['shell', 'screencap', '-p', '/sdcard/_macro.png']);
        const pull = await adb(['pull', '/sdcard/_macro.png', path.join(SHOT_DIR, 'macro.png')], { timeout: 30000 });
        await adb(['shell', 'rm', '/sdcard/_macro.png']);
        shotLine = (shot.ok && pull.ok) ? ('\n截图: ' + path.join(SHOT_DIR, 'macro.png')) : '\n（截图失败 ✗）';
      }
      return text('连招执行完 ✗ ' + actions.length + ' 个动作 ✗ 耗时 ' + sec + ' 秒\n' +
        done.slice(0, 40).join(' → ') + (done.length > 40 ? ' …' : '') + shotLine);
    } catch (e) {
      return fail('连招中断在第 ' + (done.length + 1) + ' 个动作：' + (e && e.message ? e.message : e) +
        '\n已完成: ' + done.join(' → '));
    }
  }
);

server.tool('phone_status', '查看 adb 是否可用、当前连接了哪些设备。', {}, async () => {
  const v = await adb(['version'], { serial: false });
  const d = await adb(['devices', '-l'], { serial: false });
  return text(
    `adb: ${v.ok ? v.out.split(/\r?\n/)[0] : '不可用 ' + v.err}\n` +
      `adb 路径: ${ADB}\n` +
      `当前设备:\n${d.out || d.err}\n` +
      `已选中: ${SERIAL || '（未选，将用第一台）'}`
  );
});

server.tool(
  'phone_pair',
  '首次配对你的手机：在手机「无线调试 → 使用配对码配对设备」里看到 6 位配对码和 ip:端口，把它们填进来。只需做一次。',
  {
    host: z.string().describe('配对用的 IP（手机屏幕上显示的那个）'),
    port: z.string().describe('配对用的端口（配对弹窗里显示的，通常不是 5555）'),
    code: z.string().describe('6 位配对码'),
  },
  async ({ host, port, code }) => {
    const r = await adb(['pair', `${host}:${port}`, code], { timeout: 60000, serial: false });
    return r.ok && /Successfully paired/i.test(r.out) ? text(`配对成功 ✓\n${r.out}`) : fail(`配对失败：${r.err || r.out}`);
  }
);

server.tool(
  'phone_connect',
  '连接手机（无线调试里的 ip:端口，例如 192.168.1.98:5555）。连上后本机就能控制它。',
  {
    host: z.string().describe('手机 IP'),
    port: z.string().default('5555').describe('调试端口，默认 5555'),
  },
  async ({ host, port }) => {
    const r = await adb(['connect', `${host}:${port}`], { timeout: 60000, serial: false });
    if (!/connected to/i.test(r.out)) return fail(`连接失败：${r.err || r.out}`);
    SERIAL = `${host}:${port}`;
    const sz = await shell('wm size');
    return text(`已连接 ${SERIAL} ✓\n屏幕: ${sz.trim()}`);
  }
);

server.tool('phone_devices', '列出所有 adb 设备，并可直接切换当前使用的设备。', {
  use: z.string().optional().describe('要切换到的设备序列号（可选）'),
}, async ({ use }) => {
  const d = await adb(['devices', '-l'], { serial: false });
  if (use) SERIAL = use;
  return text(`${d.out}\n当前选中: ${SERIAL || '（自动选第一台）'}`);
});

server.tool('phone_screenshot', '给手机截屏，并把画面本身递给你（能直接看界面和屏幕上的字）；文件也存了一份。想看画面用 phone_look（更快、可连拍），要精确点击前先用 phone_dump 拿坐标。', {
  note: z.string().optional().describe('文件名备注，可选'),
}, async ({ note }) => {
  try {
    await ensureDevice();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const local = path.join(SHOT_DIR, `shot-${stamp}${note ? '-' + note.replace(/[^\w-]/g, '') : ''}.png`);
    const remote = '/sdcard/_dsh_shot.png';
    await shell(`screencap -p ${remote}`);
    const pull = await adb(['pull', remote, local], { timeout: 60000 });
    if (!pull.ok || !fs.existsSync(local)) return fail(`拉取截图失败：${pull.err || pull.out}`);
    const rawBytes = fs.statSync(local).size;
    // [SHOT-VISION] 原图常见 4MB+ 会被旧上限挡掉（她只拿到路径、看不到画面）——统一缩一半再给图。
    let buf = fs.readFileSync(local);
    try { buf = scalePng(buf, 2); } catch { /* 缩放失败用原图 */ }
    const content = [{ type: 'text', text: `截图已保存: ${local}（原图 ${rawBytes} 字节，附图 ${buf.length} 字节）` }];
    content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
    return { content };
  } catch (e) {
    return fail(`截图失败：${e?.message ?? e}`);
  }
});

server.tool('phone_dump', '导出手机当前的界面结构，解析成「可点元素清单」（文字/类型/中心坐标）。★点任何东西之前先用它：拿到的中心坐标是像素级精确的，比看图的百分比估算准得多；操作完再 dump 一次确认变化。', {
  max: z.number().int().min(1).max(200).default(60).describe('最多返回多少个元素'),
}, async ({ max }) => {
  try {
    await ensureDevice();
    const { xml } = await readUiXml(true);
    const items = parseUiItems(xml, max);
    const lines = items.map((i, idx) => `${idx}: ${i.clickable ? '[可点]' : '[只读]'} ${i.type} "${i.text}" @(${i.x},${i.y})`);
    return text(`共 ${items.length} 个元素：\n${lines.join('\n')}`);
  } catch (e) {
    return fail(`dump 失败：${e?.message ?? e}`);
  }
});

server.tool('phone_tap', '点击手机屏幕上的坐标（配合 phone_dump 得到的 x,y）。★默认点击后自动轻量验证：点位没反应会立刻告诉你（别傻点三次）。传 shot=true 会把点完的画面一起给你（看得见结果，适合关键操作后确认）。', {
  x: z.number().int().describe('横坐标'),
  y: z.number().int().describe('纵坐标'),
  verify: z.boolean().default(true).describe('点完自动验证（默认开）；只想快点可设 false'),
  shot: z.boolean().optional().describe('点完附带一张画面（默认 false；关键操作后想亲眼看结果时用）'),
}, async ({ x, y, verify, shot }) => {
  try {
    const focusNow = async () => {
      // [FOCUS-FIX] `grep -m2 "mCurrentFocus\|mFocusedApp"` 在设备上返回空（toybox grep 不认 `\|`），
      // 于是"点完验证"永远说"焦点没变化"。改成单模式 grep。
      try {
        const out = await shell('dumpsys window 2>/dev/null | grep mCurrentFocus', 8000);
        return String(out ?? '').trim();
      } catch { return ''; }
    };
    const shotPart = async () => {
      try {
        // [SPEED] exec-out 直取，不落盘不 pull
        const r = await adbBuf(['exec-out', 'screencap', '-p'], 30000);
        if (!r.ok) return null;
        let buf = r.buf;
        try { buf = scalePng(buf, 2); } catch { /* 用原图 */ }
        return { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' };
      } catch { return null; }
    };
    const before = verify ? await focusNow() : '';
    await shell(`input tap ${x} ${y}`);
    markDumpStale();
    if (!verify) {
      if (!shot) return text(`已点击 (${x}, ${y})`);
      const part = await shotPart();
      const content = [{ type: 'text', text: `已点击 (${x}, ${y})（附图：点完的画面）` }];
      if (part) content.push(part);
      return { content };
    }
    // [TAP-FAST] 先等 300ms 看一次焦点：快界面立刻判定，比原来固定 900ms 省约 0.6s；
    // 没变化再多等 600ms 二次确认（慢界面/动画不误判）。
    await new Promise((r) => setTimeout(r, 300));
    let after = await focusNow();
    if (before && after && before === after) {
      await new Promise((r) => setTimeout(r, 600));
      after = await focusNow();
    }
    const verdict = (before && after && before === after)
      ? `已点击 (${x}, ${y}) · 验证：屏幕焦点没变化——这个位置可能点不出东西（空白/不可点），或页面没转。先 phone_dump 拿可点元素清单，或 phone_look 看看现在画面上是什么，换个方法。`
      : `已点击 (${x}, ${y}) · 验证：页面有变化 ✓`;
    if (!shot) return text(verdict);
    const part = await shotPart();
    const content = [{ type: 'text', text: `${verdict}（附图：点完的画面）` }];
    if (part) content.push(part);
    return { content };
  } catch (e) {
    return fail(`点击失败：${e?.message ?? e}`);
  }
});

server.tool('phone_tap_text', '按界面上显示的文字/描述找到元素并点击（比坐标稳，推荐）。若刚 phone_dump 过、且之后没做过动作，会复用那份界面清单（省 2.7s）。', {
  text: z.string().describe('要点击的文字或描述，可只写一部分'),
  index: z.number().int().min(0).default(0).describe('匹配到多个时点第几个，默认 0'),
}, async ({ text: want, index }) => {
  try {
    await ensureDevice();
    const { xml: uiXml, cached } = await readUiXml(false);
    const hits = [];
    const re = /<node[^>]*>/g;
    let m;
    while ((m = re.exec(uiXml)) !== null) {
      const tag = m[0];
      const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
      const t = get('text') || get('content-desc');
      if (!t || !t.includes(want)) continue;
      const bm = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!bm) continue;
      const [, x1, y1, x2, y2] = bm.map(Number);
      // [TAP-TEXT-IMPROVE] 匹配质量：整句相等 > 前缀 > 包含。原来无差别 includes，
      // "制造" 会把 制造站一/二/三 全命中，点 0 号 = 列表第 1 个（碰运气）
      const score = t === want ? 0 : t.startsWith(want) ? 1 : 2;
      hits.push({ t, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), score });
    }
    if (!hits.length) return fail(`界面上找不到包含「${want}」的元素`);
    hits.sort((a, b) => a.score - b.score || a.y - b.y);
    const hit = hits[Math.min(index, hits.length - 1)];
    await shell(`input tap ${hit.x} ${hit.y}`);
    markDumpStale();
    const others = hits.length > 1 ? `（其他候选：${hits.slice(1, 4).map((h) => `「${h.t.slice(0, 12)}」`).join('、')}，要它们就 index 换 1/2…）` : '';
    return text(`已点击「${hit.t}」@(${hit.x},${hit.y})${hits.length > 1 ? ` · 最像的一个${others}` : ''}${cached ? '（复用上次界面清单，省了 2.7s）' : ''}`);
  } catch (e) {
    return fail(`点击失败：${e?.message ?? e}`);
  }
});

server.tool('phone_text', '往当前输入框打字（支持中文，需手机装有 ADBKeyboard 输入法；纯英文数字无需）。安全限制：不接受 $ ; & | ` < > ( ) { } [ ] * ? ! ~ \\ \' " % 等 shell 元字符与换行。', {
  text: z.string().describe('要输入的文字'),
}, async ({ text: content }) => {
  try {
    await ensureDevice();
    const has = await shell('ime list -a');
    const hasAdbKb = /com\.android\.adbkeyboard/i.test(has);
    // [AUDIT-FIX] 设备侧 adbd 用 sh -c 解释整串命令，手工单引号转义挡不住
    // $() / 反引号 / 反斜杠 / 结尾转义。含 shell 元字符的输入一律拒绝；
    // 正常中英文文本路径不变，也不再把用户输入交给 shell 拼接。
    if (/[\x00-\x1f\x7f$;&|`<>(){}\[\]*?!~\\'"%]/.test(content)) {
      return fail('输入含 shell 元字符，已拒绝（安全限制；请改用不含特殊符号的文本）');
    }
    const ascii = /^[\x20-\x7e]*$/.test(content);
    if (ascii) {
      await shell(`input text '${content}'`);
      markDumpStale();
      return text(`已输入（ADB 原生）: ${content}`);
    }
    if (!hasAdbKb) {
      return fail(
        '这段文字含中文，需要手机安装 ADBKeyboard 输入法（开源，一次性装好即可）。\n' +
          '装好后重试；或改用纯英文/数字。'
      );
    }
    // ★ 雷电/安卓14 上【ime set 永远失败】✗ 必须用 settings put secure ✓
    const cur = (await shell('settings get secure default_input_method')).trim();
    const IME = 'com.android.adbkeyboard/.AdbIME';
    await shell(`ime enable ${IME}`);
    await shell(`settings put secure enabled_input_methods "${IME}:${cur || 'com.android.inputmethod.pinyin/.InputService'}"`);
    await shell(`settings put secure default_input_method ${IME}`);
    await new Promise((r) => setTimeout(r, 600));
    await shell(`am broadcast -a ADB_INPUT_TEXT --es msg '${content}'`);
    // 切回原来的输入法（她不用的时候保持正常）
    if (cur && cur !== IME) await shell(`settings put secure default_input_method ${cur}`);
    markDumpStale();
    return text(`已输入（ADBKeyboard）: ${content}`);
  } catch (e) {
    return fail(`输入失败：${e?.message ?? e}`);
  }
});

server.tool('phone_key', '按手机按键：back / home / enter / recent / volume_up / volume_down / power / delete。', {
  key: z.enum(['back', 'home', 'enter', 'recent', 'volume_up', 'volume_down', 'power', 'delete', 'menu']),
}, async ({ key }) => {
  const map = {
    back: 4, home: 3, enter: 66, recent: 187, volume_up: 24, volume_down: 25, power: 26, delete: 67, menu: 82,
  };
  try {
    await shell(`input keyevent ${map[key]}`);
    markDumpStale();
    return text(`已按下 ${key}`);
  } catch (e) {
    return fail(`按键失败：${e?.message ?? e}`);
  }
});

server.tool('phone_swipe', '滑动屏幕（例如从下往上滑返回桌面、下拉通知栏等）。', {
  x1: z.number().int(), y1: z.number().int(),
  x2: z.number().int(), y2: z.number().int(),
  ms: z.number().int().min(50).max(3000).default(300).describe('滑动耗时毫秒'),
}, async ({ x1, y1, x2, y2, ms }) => {
  try {
    await shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
    markDumpStale();
    return text(`已滑动 (${x1},${y1}) → (${x2},${y2})`);
  } catch (e) {
    return fail(`滑动失败：${e?.message ?? e}`);
  }
});

// [SKETCH-SMOOTH] 把「几个控制点」变成「一条顺的线」。
// adb 只能一段段直线地滑，点给少了画出来是一圈棱角（实测 16 点 = 16 边形）。所以在客户端
// 补一次 Catmull-Rom 样条采样：她想位置时只给 6~10 个控制点，落到屏幕上的是 40~80 段短滑，
// 线条就顺了。采样是按弧长等距的，不会在尖角处挤成一团。
function resampleStroke(points, spacing = 9, maxPoints = 400) {
  if (points.length < 2) return points;
  if (points.length === 2) return points;
  const out = [];
  const p = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < p.length - 2; i += 1) {
    const [x0, y0] = p[i - 1];
    const [x1, y1] = p[i];
    const [x2, y2] = p[i + 1];
    const [x3, y3] = p[i + 2];
    // 先按 12 段粗采样这条曲线，再按距离抽稀
    const seg = 12;
    for (let s = 0; s < seg; s += 1) {
      const t = s / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * x1) + (-x0 + x2) * t
        + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2
        + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const y = 0.5 * ((2 * y1) + (-y0 + y2) * t
        + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2
        + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      const last = out[out.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) >= spacing) {
        out.push([Math.round(x), Math.round(y)]);
        if (out.length >= maxPoints) return out;
      }
    }
  }
  const end = points[points.length - 1];
  const last = out[out.length - 1];
  if (!last || last[0] !== end[0] || last[1] !== end[1]) out.push([end[0], end[1]]);
  return out.slice(0, maxPoints);
}

// [SKETCH] 画画用的手：一次调用画完一笔（或几笔），不是在二十次调用里挪二十段线。
//
// 为什么单独做：phone_batch 每步之间固定等 120ms、最多 20 步，而且每段之间还夹着模型回合的
// 延迟——画一条圆要分好几次调用，手一抖线就断在回合边界上。这个工具把整条笔迹拼成一条
// adb shell 命令一次发下去，段与段之间不留人为等待，返回耗时和实际段数，让她能判断
// 「这一笔画得太久/太碎」。
//
// 只做手势，不碰画笔：切笔刷、调粗细、撤销都交给 App 界面（她自己去点）。
// 坐标系是屏幕像素（和 phone_tap / phone_dump 同一套），不是百分比。
server.tool(
  'phone_sketch',
  '用「手指」在屏幕上画笔画：把一条笔迹拆成一串 swipe 段，一次调用连续画完（画世界/画图类 App 都适用）。'
    + 'points 是屏幕像素坐标数组 [[x,y],...]，按顺序连线；多条笔画用 strokes 给。'
    + '默认 smooth=true 会对控制点补样条，所以给 6~10 个关键点就能画出一条顺的线；'
    + '想画折线/尖角就传 smooth=false。'
    + '画之前先确认画布上已经选好画笔和粗细；画之后用 phone_look 看一眼自己画成什么样——'
    + '看不到就别猜自己画对了。返回 segments/elapsedMs，段数太多（>120）说明线太碎，下一张少给点。',
  {
    points: z.array(z.array(z.number()).min(2).max(2)).optional().describe('单条笔迹：[[x,y],...]（与 strokes 二选一）'),
    strokes: z.array(z.array(z.array(z.number()).min(2).max(2))).optional().describe('多条笔迹：[[[x,y],...],...]（每条最多 400 点）'),
    smooth: z.boolean().optional().describe('对控制点补样条（默认 true）；画折线/尖角时传 false'),
    spacing: z.number().int().min(6).max(60).optional().describe('补样条采样间距（默认 10px）：小=更顺但段更多更慢，大=快但略见棱角'),
    msPerSegment: z.number().int().min(10).max(400).optional().describe('每小段滑动耗时（默认 40ms；越短越快越容易抖）'),
    settleMs: z.number().int().min(0).max(2000).optional().describe('每条笔画之间停多久（默认 120ms）'),
    endShot: z.boolean().optional().describe('画完附一张截图（默认 true）——自己的画自己先看'),
  },
  async ({ points, strokes, smooth, spacing, msPerSegment, settleMs, endShot }) => {
    const ms = Math.max(10, Math.min(400, Number(msPerSegment) || 40));
    const settle = Math.max(0, Math.min(2000, settleMs === undefined ? 120 : Number(settleMs)));
    const all = (Array.isArray(strokes) && strokes.length ? strokes : (Array.isArray(points) ? [points] : []))
      .map((s) => (Array.isArray(s) ? s.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))]) : []))
      .filter((s) => s.length >= 2);
    if (!all.length) return fail('没有可画的点：points 或 strokes 要给至少两个点（屏幕像素坐标）。');
    if (all.length > 24) return fail('一次最多 24 条笔画：拆成几次画，别一口气塞。');
    const tooLong = all.find((s) => s.length > 400);
    if (tooLong) return fail(`有一条笔画 ${tooLong.length} 点 > 400：抽稀一下再画（抽稀后线段更少、更快）。`);

    // 同一段里连续重复点会让 swipe 时长为 0，去重
    const deduped = all.map((s) => s.filter((p, i) => i === 0 || p[0] !== s[i - 1][0] || p[1] !== s[i - 1][1])).filter((s) => s.length >= 2);
    // 补样条：控制点少的时候画出来才不是一个多边形（smooth=false 才画折线）
    const step = Math.max(6, Math.min(60, Number(spacing) || 10));
    const cleaned = (smooth === false ? deduped : deduped.map((s) => (s.length >= 3 ? resampleStroke(s, step) : s)))
      .filter((s) => s.length >= 2);
    const segments = cleaned.reduce((n, s) => n + s.length - 1, 0);
    if (segments > 900) {
      return fail(`一共 ${segments} 段 > 900：控制点给粗一点（少几个点就能盖住同一条线），或者拆成几次画。`);
    }

    // 越界点会让手指滑到屏幕外，直接拒绝而不是画出一半
    let w = 0, h = 0;
    try {
      const out = await shell('wm size');
      const m = /(\d+)x(\d+)/.exec(out);
      if (m) { w = Number(m[1]); h = Number(m[2]); }
    } catch { /* 拿不到尺寸就不卡边界 */ }
    if (w && h) {
      const bad = cleaned.flat().find(([x, y]) => x < 0 || y < 0 || x > w || y > h);
      if (bad) return fail(`点 (${bad[0]},${bad[1]}) 在屏幕外（屏幕 ${w}x${h}）：先 phone_look 确认画布范围，坐标别写飞。`);
    }

    // 一条 shell 命令串起所有段：段间不留人为延迟，adb 只往返一次
    const cmds = [];
    cleaned.forEach((s, i) => {
      if (i > 0 && settle > 0) cmds.push(`sleep ${(settle / 1000).toFixed(2)}`);
      for (let k = 0; k < s.length - 1; k += 1) {
        cmds.push(`input swipe ${s[k][0]} ${s[k][1]} ${s[k + 1][0]} ${s[k + 1][1]} ${ms}`);
      }
    });
    const started = Date.now();
    try {
      await shell(cmds.join('; '), Math.min(240000, 20000 + segments * 400));
    } catch (e) {
      return fail(`画到一半失败（已画 ${Math.round((Date.now() - started) / 1000)}s）：${e?.message ?? e}`);
    }
    const elapsedMs = Date.now() - started;
    markDumpStale();

    const content = [{
      type: 'text',
      text: `画完了：${cleaned.length} 笔 / ${segments} 段 / 用时 ${(elapsedMs / 1000).toFixed(1)}s`
        + `${smooth === false ? '（折线模式）' : '（已补样条）'}`
        + `${segments > 120 ? '（段数偏多：控制点给粗一点，线条会更快更稳）' : ''}`
    }];
    if (endShot !== false) {
      const r = await adbBuf(['exec-out', 'screencap', '-p'], 30000);
      if (r.ok) {
        let buf = r.buf;
        try { buf = scalePng(buf, 2); } catch { /* 用原图 */ }
        content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
      } else {
        content.push({ type: 'text', text: `（截图失败：${r.message || '未知'}——用 phone_look 自己看）` });
      }
    }
    return {
      content,
      _meta: { strokes: cleaned.length, segments, elapsedMs, msPerSegment: ms }
    };
  }
);

server.tool('phone_batch', '一次连续做多步手机动作（tap / key / swipe / wait），省掉每步一次往返——每次工具调用都要等一次模型回合，批量能快好几倍。适合已经很清楚的路径；不确定时别批量，先 phone_dump / phone_look 看清。endDump=true 结束时附「可点元素清单」，endShot=true 附截图。', {
  actions: z.array(z.object({
    op: z.enum(['tap', 'key', 'swipe', 'wait']).describe('动作类型'),
    x: z.number().int().optional().describe('tap/swipe：x'),
    y: z.number().int().optional().describe('tap/swipe：y'),
    x2: z.number().int().optional().describe('swipe：终点 x'),
    y2: z.number().int().optional().describe('swipe：终点 y'),
    key: z.string().optional().describe('key：back/home/enter/recent/volume_up/volume_down/power/delete/menu'),
    ms: z.number().int().optional().describe('swipe 时长（默认 300）/ wait 毫秒'),
  })).describe('按顺序执行的动作（最多 20 步）'),
  endDump: z.boolean().optional().describe('结束时附界面元素清单（默认 false）'),
  endShot: z.boolean().optional().describe('结束时附截图（默认 false）'),
}, async ({ actions, endDump, endShot }) => {
  try {
    await ensureDevice();
    const list = Array.isArray(actions) ? actions.slice(0, 20) : [];
    if (!list.length) return fail('actions 是空的');
    const keyMap = { back: 4, home: 3, enter: 66, recent: 187, volume_up: 24, volume_down: 25, power: 26, delete: 67, menu: 82 };
    const done = [];
    for (const a of list) {
      const op = String(a?.op || '');
      if (op === 'tap') {
        if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) { done.push('tap 缺 x/y，跳过'); continue; }
        await shell(`input tap ${a.x} ${a.y}`);
        done.push(`tap ${a.x},${a.y}`);
      } else if (op === 'key') {
        const code = keyMap[String(a.key || '')];
        if (!code) { done.push(`未知按键 ${a.key}，跳过`); continue; }
        await shell(`input keyevent ${code}`);
        done.push(`key ${a.key}`);
      } else if (op === 'swipe') {
        await shell(`input swipe ${Number(a.x) || 0} ${Number(a.y) || 0} ${Number(a.x2) || 0} ${Number(a.y2) || 0} ${Math.max(50, Math.min(3000, Number(a.ms) || 300))}`);
        done.push(`swipe (${a.x},${a.y})→(${a.x2},${a.y2})`);
      } else if (op === 'wait') {
        const waitMs = Math.max(50, Math.min(10000, Number(a.ms) || 500));
        await new Promise((r) => setTimeout(r, waitMs));
        done.push(`wait ${waitMs}ms`);
      } else {
        done.push(`未知动作 ${op}，跳过`);
      }
      await new Promise((r) => setTimeout(r, 120)); // 动作间隔，避免输入被系统吞掉
    }
    markDumpStale();
    const content = [{ type: 'text', text: `已执行 ${done.length} 步：${done.join('；')}` }];
    if (endShot) {
      const r = await adbBuf(['exec-out', 'screencap', '-p'], 30000);
      if (r.ok) {
        let buf = r.buf;
        try { buf = scalePng(buf, 2); } catch { /* 用原图 */ }
        content.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });
      }
    }
    if (endDump) {
      const { xml } = await readUiXml(true);
      const items = parseUiItems(xml, 60);
      content.push({ type: 'text', text: `结束时界面（${items.length} 个元素）：\n${items.map((i, idx) => `${idx}: ${i.clickable ? '[可点]' : '[只读]'} ${i.type} "${i.text}" @(${i.x},${i.y})`).join('\n')}` });
    }
    return { content };
  } catch (e) {
    return fail(`批量操作失败：${e?.message ?? e}`);
  }
});

server.tool('phone_info', '把你「刚在手机上看到/做到」的事记一条进你自己的记忆库（下次聊到相关话题能接上）。一条就一句话：看到什么/做了什么/想到什么。比如：朋友发了明日方舟新版本、你刚打过了哪一关、卡在哪一步、刷到个梗。', {
  app: z.string().optional().describe('在哪个 App（明日方舟/微信/抖音…），没有就留空'),
  note: z.string().describe('看到/做到的具体内容，60 字内'),
}, async ({ app, note }) => {
  try {
    const body = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!body) return fail('要记的内容是空的');
    const a = String(app ?? '').trim() || '手机';
    const now = new Date();
    const day = now.toLocaleDateString('sv-SE');
    const hm = now.toLocaleTimeString('sv-SE').slice(0, 5);
    const row = JSON.stringify({
      day,
      time: `${day} ${hm}`,
      kind: 'event',
      text: `在「${a}」里${body}`,
      who: '我',
      theme: a,
      felt: '',
      source: 'phone_info',
    });
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const dir = process.env.INORI_MEMORY_DIR || dataPath('memory');
    fsx.mkdirSync(dir, { recursive: true });
    fsx.appendFileSync(pathx.join(dir, 'memory.jsonl'), row + '\n', 'utf8');
    return text(`已记下「在${a}里${body.slice(0, 40)}」（主题：${a}）。下次聊到它你会想起来。`);
  } catch (e) {
    return fail(`记录失败：${e?.message ?? e}`);
  }
});

// ── [OPEN-APP-BEHAVIOR] 打开 App 是「行为」，不是「查表」 ────────────────────
// 这里没有任何 App 名↔包名的对照表：名字怎么对上由屏幕自己给（桌面/抽屉里的 text、content-desc），
// 点完再确认前台真的换了。只有她主动给包名（a.b.c 这种系统标识）时才走 am start 快路。
const screenSize = async () => {
  try {
    const m = String(await shell('wm size')).match(/(\d+)x(\d+)/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  } catch { /* 读不到就用常见竖屏尺寸 */ }
  return { w: 1080, h: 2400 };
};

const windowFocus = async () => {
  // [FOCUS-FIX] 以前用 `grep -m2 "mCurrentFocus\|mFocusedApp"`：设备上的 toybox grep
  // 不认 `\|`，命令直接空返回 → 所有"点完看前台变没变"的校验都判成"没变化"。
  // 现在拆成两次单模式 grep。
  try {
    const a = String((await shell('dumpsys window 2>/dev/null | grep mCurrentFocus')) || '').trim();
    if (a) return a;
    return String((await shell('dumpsys window 2>/dev/null | grep mFocusedApp')) || '').trim();
  } catch { return ''; }
};

// mCurrentFocus=Window{hash u0 pkg/Activity} → pkg
const pkgOfFocus = (focusText) => {
  const m = String(focusText ?? '').match(/([a-zA-Z][\w.]*)\/[\w.$]/);
  return m ? m[1] : '';
};

const isLauncherOrShade = (pkg) =>
  /launcher|\.home$|home\.|deskclock|miui\.mihome|notification|systemui/i.test(String(pkg ?? ''));

const wakeScreen = async () => {
  const w = String((await shell('dumpsys power 2>/dev/null | grep -m1 mWakefulness=')) || '');
  if (!/Awake/i.test(w)) {
    await shell('input keyevent 224'); // KEYCODE_WAKEUP
    await new Promise((r) => setTimeout(r, 900));
  }
};

const screenLocked = async () => {
  try {
    // 同上：单模式 grep，避免 `\|` 在设备上失效
    for (const pat of ['keyguardShowing=true', 'mShowingLockscreen=true', 'mDreamingLockscreen=true']) {
      const out = String((await shell(`dumpsys window 2>/dev/null | grep ${pat}`)) || '');
      if (out.trim()) return true;
    }
    const focus = await windowFocus();
    return /keyguard|lockscreen|NotificationShade/i.test(focus);
  } catch { return false; }
};

// 在界面清单里按名字找图标：整句相等 > 前缀 > 包含；同等相似度优先可点的。
const iconHits = (xml, want) => {
  const w = String(want).trim().toLowerCase();
  const hits = [];
  const re = /<node[^>]*>/g;
  let m;
  while ((m = re.exec(String(xml ?? ''))) !== null) {
    const tag = m[0];
    const get = (k) => (tag.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
    const t = get('text') || get('content-desc');
    if (!t) continue;
    const low = t.toLowerCase();
    if (!low.includes(w)) continue;
    const bm = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const [, x1, y1, x2, y2] = bm.map(Number);
    hits.push({
      t,
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
      score: low === w ? 0 : (low.startsWith(w) ? 1 : 2),
      clickable: get('clickable') === 'true',
    });
  }
  hits.sort((a, b) => a.score - b.score || (b.clickable ? 1 : 0) - (a.clickable ? 1 : 0));
  return hits;
};

// [ACTIVITY] 真打开了之后，才告诉她「这个 App 里你会做什么」。
// 对应关系只来自技能库的 activity/app 字段（数据），代码里不写任何 App 名或包名；
// 打不开 / 没等到前台变化的分支不调用（打不开就没什么可做，别硬塞）。
function withActivitySkills(frontText, app) {
  try {
    const skills = skillsForApp(readSkillsFile(), app);
    const activity = activityName(skills);
    const extra = renderActivityContext(skills, { activity, alsoDoable: readActivityExtras(activity) });
    // [RESOURCES] 家底：只陈述上次记了什么、什么时候记的（只读；不催她更新）
    const resources = renderResourceLine(readActivityResources(activity));
    const tail = `${extra}${resources}`;
    return tail ? frontText + tail : frontText;
  } catch {
    return frontText;
  }
}

/** 用 PackageManager 解析出真正可启动的 component；比只给 -p 更抗 ROM 差异。 */
async function resolvePackageActivity(pkg) {
  try {
    const r = await adb(['shell', `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`], { timeout: 15000 });
    const out = String(r.out || '') + String(r.err || '');
    const line = out.split('\n').map((x) => x.trim()).reverse()
      .find((x) => /^[A-Za-z][\w.]*\/[\w.$]+$/.test(x));
    return line || '';
  } catch (error) {
    return '';
  }
}

/** 包名快路的第二兜底：am start 失败时用 monkey 再拉一次（有些 ROM 只认 monkey）。 */
async function launchPackageByMonkey(pkg) {
  try {
    const r = await adb(['shell', `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`], { timeout: 20000 });
    const out = String(r.out || '') + String(r.err || '');
    if (/No activities found|monkey aborted|Error|Exception|not found|Unable to/i.test(out)) return { ok: false, out };
    if (/Events injected:\s*[1-9]/i.test(out)) return { ok: true, out };
    return { ok: false, out };
  } catch (error) {
    return { ok: false, out: String(error?.message ?? error) };
  }
}

server.tool('phone_open_app', '按名字打开一个 App：先唤醒/回桌面 → 在图标或应用抽屉里按名字找到它 → 点 → 再看前台是不是真的换了（不预设任何 App 名与包名的对应关系）。给完整包名（a.b.c）时才走系统快路。', {
  pkg: z.string().describe('App 的名字（如「微信」「明日方舟」，可以只写一部分），或完整包名'),
}, async ({ pkg }) => {
  try {
    await ensureDevice();
    const want = String(pkg || '').trim();
    if (!want) return fail('要打开什么？给个名字。');
    const tried = [];

    // 快路：她给的就是包名（系统标识），直接交给系统
    if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(want)) {
      const r = await adb(['shell', `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${want}`], { timeout: 20000 });
      const out = String(r.out || '') + String(r.err || '');
      if (!/Error|Exception|not found|Unable to/i.test(out)) {
        markDumpStale();
        return text(withActivitySkills(`已按包名启动 ${want}\n${out.slice(0, 160)}`, want));
      }
      tried.push('按包名启动失败');
      const comp = await resolvePackageActivity(want);
      if (comp) {
        const r2 = await adb(['shell', `am start -n ${comp}`], { timeout: 20000 });
        const out2 = String(r2.out || '') + String(r2.err || '');
        if (!/Error|Exception|not found|Unable to/i.test(out2)) {
          markDumpStale();
          return text(withActivitySkills(`已按组件启动 ${comp}\n${out2.slice(0, 160)}`, want));
        }
        tried.push('按组件启动失败');
      }
      const mk = await launchPackageByMonkey(want);
      if (mk.ok) {
        markDumpStale();
        return text(withActivitySkills(`已按包名启动 ${want}（monkey 兜底）\n${mk.out.slice(0, 160)}`, want));
      }
      tried.push('monkey 兜底失败');
    }

    await wakeScreen();
    if (await screenLocked()) {
      return fail(`手机在锁屏上，我打不开「${want}」——先把它解锁到桌面（要输密码的话我进不去）。`);
    }

    const { w, h } = await screenSize();
    await shell('input keyevent 3'); // HOME
    await new Promise((r) => setTimeout(r, 800));
    markDumpStale();
    const beforePkg = pkgOfFocus(await windowFocus());

    // 点完等它自己起来：冷启动/游戏要十几秒，前台窗口会先停在桌面一会儿
    const currentForeground = async () => {
      const pkg = pkgOfFocus(await windowFocus());
      if (pkg) return pkg;
      try {
        const a = String(await shell('dumpsys activity activities 2>/dev/null | grep -m1 mResumedActivity') || '');
        const m = a.match(/mResumedActivity.*?([a-zA-Z][\w.]*)\/[\w.$]/);
        if (m) return m[1];
      } catch { /* 读不到就算了 */ }
      return '';
    };
    const waitForApp = async (budgetMs) => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        const p = await currentForeground();
        if (p && p !== beforePkg && !isLauncherOrShade(p)) return p;
        await new Promise((r) => setTimeout(r, 500));
      }
      return '';
    };

    // 在当前这一屏找图标并点，点完看前台有没有换成别的 App
    const tapIconOnPage = async (where) => {
      const { xml } = await readUiXml(true);
      const hits = iconHits(xml, want);
      if (!hits.length) return null;
      const hit = hits[0];
      await shell(`input tap ${hit.x} ${hit.y}`);
      markDumpStale();
      const pkg = await waitForApp(15000);
      tried.push(`${where}点了「${hit.t}」${pkg ? `→ 前台 ${pkg}` : '→ 没等到前台变化'}`);
      return { hit: hit.t, pkg };
    };

    const first = await tapIconOnPage('桌面第1屏');
    if (first?.pkg) return text(withActivitySkills(`打开了「${want}」：桌面第1屏图标「${first.hit}」→ 前台 ${first.pkg}`, first.pkg));
    if (first) return text(`点了桌面第1屏的「${first.hit}」，但 15 秒内没等到前台变化——可能还在加载，先 phone_look 看一眼再决定要不要再点。`);

    // 桌面一屏一屏往左翻（最多 5 屏），每屏都重新读一次界面找图标
    const seenTexts = [];
    for (let page = 2; page <= 5; page += 1) {
      await shell(`input swipe ${Math.round(w * 0.82)} ${Math.round(h / 2)} ${Math.round(w * 0.18)} ${Math.round(h / 2)} 240`);
      await new Promise((r) => setTimeout(r, 900));
      markDumpStale();
      const got = await tapIconOnPage(`桌面第${page}屏`);
      if (got?.pkg) return text(withActivitySkills(`打开了「${want}」：桌面第${page}屏图标「${got.hit}」→ 前台 ${got.pkg}`, got.pkg));
      if (got) return text(`点了桌面第${page}屏的「${got.hit}」，但 15 秒内没等到前台变化——可能还在加载，先 phone_look 看一眼再决定要不要再点。`);
      const { xml } = await readUiXml(false);
      for (const it of parseUiItems(xml, 60)) {
        if (it.text && !/^(第\d屏|电话|短信|浏览器|相机|\d+)$/.test(it.text)) seenTexts.push(it.text);
      }
    }

    // [DRAWER-FALLBACK] 桌面 5 屏没有，不代表 App 不在：很多 ROM 把新装 App 放在应用抽屉。
    // 从底部上滑打开抽屉，再扫 3 页；找不到就如实返回，不硬猜包名。
    try {
      await shell(`input swipe ${Math.round(w / 2)} ${Math.round(h * 0.92)} ${Math.round(w / 2)} ${Math.round(h * 0.18)} 320`);
      await new Promise((r) => setTimeout(r, 1000));
      markDumpStale();
      for (let page = 1; page <= 3; page += 1) {
        const got = await tapIconOnPage(`应用抽屉第${page}页`);
        if (got?.pkg) return text(withActivitySkills(`打开了「${want}」：应用抽屉第${page}页图标「${got.hit}」→ 前台 ${got.pkg}`, got.pkg));
        if (got) return text(`点了应用抽屉第${page}页的「${got.hit}」，但 15 秒内没等到前台变化——可能还在加载，先 phone_look 看一眼再决定要不要再点。`);
        const { xml } = await readUiXml(false);
        for (const it of parseUiItems(xml, 60)) {
          if (it.text && !/^(第\d屏|电话|短信|浏览器|相机|\d+)$/.test(it.text)) seenTexts.push(it.text);
        }
        if (page < 3) {
          await shell(`input swipe ${Math.round(w / 2)} ${Math.round(h * 0.82)} ${Math.round(w / 2)} ${Math.round(h * 0.28)} 300`);
          await new Promise((r) => setTimeout(r, 800));
          markDumpStale();
        }
      }
    } catch (error) { /* 抽屉打不开就回到桌面结果 */ }

    // 翻完了还是没有：如实说，并把扫到的名字给她（她可以换个说法，或知道它在文件夹里）
    const uniq = [...new Set(seenTexts)].slice(0, 30);
    return fail(
      `桌面 5 屏 + 应用抽屉 3 页都没找到叫「${want}」的图标。\n` +
      `试过：${tried.slice(-5).join('；') || '桌面 5 屏 + 应用抽屉 3 页'}\n` +
      `扫到的 App：${uniq.join('、') || '(读不到文字)'}\n` +
      `名字可能不一样（少写两个字更稳），也可能在文件夹里——先用 phone_look 看一眼再决定。`
    );
  } catch (e) {
    return fail(`打开 App 失败：${e?.message ?? e}`);
  }
});

// ── 看视频：抽帧成图片（LLM 不能直接看视频，但能"看"这一串画面）──────────────
// 允许的视频来源：截图目录/媒体目录里的文件、http(s) 链接；不允许任意本地路径。
// ffmpeg 优先用 PHONE_FFMPEG，其次用 ComfyUI 环境自带的静态版，最后退回 PATH 上的 ffmpeg。
const FFMPEG_CANDIDATES = [
  process.env.PHONE_FFMPEG,
  (process.env.PHONE_FFMPEG || 'ffmpeg'),
  'ffmpeg',
].filter(Boolean);

function findFfmpeg() {
  for (const c of FFMPEG_CANDIDATES) {
    try {
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    } catch {}
  }
  return 'ffmpeg';
}

async function runFfmpeg(args, timeout = 120000) {
  const bin = findFfmpeg();
  return await new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? err?.message ?? '') });
    });
  });
}

// ── 媒体来源解析：只允许截图目录/媒体目录里的文件与 http(s) 链接 ─────────────
// 之前 video_frames / qzone_post 调用了未定义的 resolveImage，两个工具运行时必然
// ReferenceError（被外层 try 接成 fail，等于死功能）。这里补上，并做目录白名单防任意文件读取。
const MEDIA_DIRS = [
  SHOT_DIR,
  process.env.PHONE_MEDIA_DIR || dataPath('media'),
];
function resolveImage(input) {
  const s = String(input ?? '').trim();
  if (!s) return { error: '图片路径是空的' };
  if (/^https?:\/\//i.test(s)) return { file: s }; // 网络资源直接交给 OneBot / ffmpeg
  let abs = path.resolve(s);
  if (!fs.existsSync(abs) && !/[\\/]/.test(s)) {
    const cand = path.join(SHOT_DIR, s);
    if (fs.existsSync(cand)) abs = cand;
  }
  const ok = MEDIA_DIRS.some((d) => {
    const base = path.resolve(d);
    return abs === base || abs.startsWith(base + path.sep);
  });
  if (!ok) {
    return { error: `图片不在允许的目录里：${abs}\n允许的目录：${MEDIA_DIRS.join(' , ')}\n（也可以直接给 http(s) 链接）` };
  }
  if (!fs.existsSync(abs)) return { error: `图片不存在：${abs}` };
  return { file: abs };
}

server.tool(
  'video_frames',
  '看视频：把一段视频抽成若干张关键画面（图片），从而"看懂"里面的内容。支持本机允许目录里的视频文件或 http(s) 视频直链。',
  {
    video: z.string().describe('视频：允许目录里的文件名/绝对路径，或 http(s) 视频链接'),
    count: z.number().int().min(2).max(12).default(6).describe('抽几帧，默认 6'),
    startSec: z.number().min(0).default(0).describe('从第几秒开始抽，默认 0'),
    durationSec: z.number().min(0).default(0).describe('截取多长（0=整段，最多取 600 秒）'),
  },
  async ({ video, count, startSec, durationSec }) => {
    try {
      const r = resolveImage(video);
      if (r.error) return fail(String(r.error).replace('图片', '视频'));
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outDir = path.join(SHOT_DIR, 'frames-' + stamp);
      fs.mkdirSync(outDir, { recursive: true });
      const dur = durationSec > 0 ? Math.min(durationSec, 600) : 0;
      // 没给时长：先用 ffmpeg 探总时长，让 count 帧均匀铺满整段（探测失败退回每 4 秒一帧）。
      let probeDur = dur;
      if (probeDur <= 0) {
        const probe = await runFfmpeg(['-hide_banner', '-i', r.file], 30000);
        const mm = String(probe.err).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (mm) probeDur = Number(mm[1]) * 3600 + Number(mm[2]) * 60 + Number(mm[3]);
      }
      const fps = probeDur > 0 ? count / probeDur : 1 / 4;
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (startSec > 0) args.push('-ss', String(startSec));
      if (dur > 0) args.push('-t', String(dur));
      args.push('-i', r.file, '-vf', `fps=${fps.toFixed(4)},scale='min(720,iw)':-2`, '-frames:v', String(count), path.join(outDir, 'f%02d.jpg'));
      const res = await runFfmpeg(args);
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort();
      if (!files.length) {
        return fail(`抽帧失败（没有产出图片）：${res.err.slice(0, 300) || '未知原因'}  源：${r.file}`);
      }
      const content = [{ type: 'text', text: `已从视频抽出 ${files.length} 帧（时长${dur > 0 ? ' ' + dur + ' 秒' : ''}），目录：${outDir}` }];
      for (const f of files) {
        const p = path.join(outDir, f);
        const size = fs.statSync(p).size;
        if (size > 0 && size < 3 * 1024 * 1024) {
          content.push({ type: 'text', text: `第 ${f} 帧：` });
          content.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: 'image/jpeg' });
        }
      }
      return { content };
    } catch (e) {
      return fail(`看视频失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'phone_record_screen',
  '录一段手机屏幕（最多 60 秒），然后自动抽帧成图片返回 —— 用来"看"手机上发生的过程。',
  {
    seconds: z.number().int().min(1).max(60).default(10).describe('录多久，默认 10 秒'),
    frames: z.number().int().min(2).max(12).default(6).describe('抽几帧'),
  },
  async ({ seconds, frames }) => {
    try {
      await ensureDevice();
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const remote = '/sdcard/_dsh_rec.mp4';
      const local = path.join(SHOT_DIR, `rec-${stamp}.mp4`);
      await shell(`screenrecord --time-limit ${seconds} --bit-rate 4000000 ${remote}`, (seconds + 30) * 1000);
      const pull = await adb(['pull', remote, local], { timeout: 120000 });
      if (!pull.ok || !fs.existsSync(local)) return fail(`录屏拉取失败：${pull.err || pull.out}`);
      const outDir = path.join(SHOT_DIR, 'recframes-' + stamp);
      fs.mkdirSync(outDir, { recursive: true });
      const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', local,
        '-vf', `fps=${(frames / Math.max(1, seconds)).toFixed(4)},scale='min(720,iw)':-2`,
        '-frames:v', String(frames), path.join(outDir, 'f%02d.jpg')]);
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort();
      if (!files.length) return fail(`录屏抽帧失败：${res.err.slice(0, 200)}（视频在 ${local}）`);
      const content = [{ type: 'text', text: `手机录屏 ${seconds} 秒，抽了 ${files.length} 帧（视频：${local}）` }];
      for (const f of files) {
        const p = path.join(outDir, f);
        if (fs.statSync(p).size > 0) {
          content.push({ type: 'text', text: `第 ${f} 帧：` });
          content.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: 'image/jpeg' });
        }
      }
      return { content };
    } catch (e) {
      return fail(`录屏失败：${e?.message ?? e}`);
    }
  }
);

// ── 硬性限流：把"别太过分"写进代码（不靠她自觉）──────────────────────────
// 写操作（点按/打字/滑动/按键/开应用/shell）每天上限、每分钟上限；
// 截图/录屏也有上限，避免她一直盯着你的屏幕看。
const RATE_LIMIT = {
  write: { perMinute: 5, perDay: 40, hits: [] },
  look:  { perMinute: 3, perDay: 80, hits: [] },
};
function rateCheck(kind) {
  const rl = RATE_LIMIT[kind];
  const now = Date.now();
  rl.hits = rl.hits.filter((t) => now - t < 24 * 3600 * 1000);
  const lastMin = rl.hits.filter((t) => now - t < 60000).length;
  if (lastMin >= rl.perMinute) return `【限流】${kind} 类操作每分钟最多 ${rl.perMinute} 次，已拒绝。`;
  if (rl.hits.length >= rl.perDay) return `【限流】${kind} 类操作每天最多 ${rl.perDay} 次，今天已用完，请明天再来。`;
  rl.hits.push(now);
  return null;
}
const WRITE_TOOLS = new Set(['phone_tap', 'phone_tap_text', 'phone_text', 'phone_swipe', 'phone_key', 'phone_open_app', 'phone_shell']);
const LOOK_TOOLS = new Set(['phone_screenshot', 'phone_dump', 'phone_record_screen']);
server.tool = new Proxy(server.tool.bind(server), {
  apply(target, thisArg, args) {
    const name = args[0];
    const kind = WRITE_TOOLS.has(name) ? 'write' : LOOK_TOOLS.has(name) ? 'look' : null;
    if (!kind) return Reflect.apply(target, thisArg, args);
    const handler = args[args.length - 1];
    args[args.length - 1] = async (...rest) => {
      const blocked = rateCheck(kind);
      if (blocked) return fail(blocked);
      return await handler(...rest);
    };
    return Reflect.apply(target, thisArg, args);
  },
});
// ── QQ 空间（说说）：发/看/赞/评（删除与拉黑故意不提供）──────────────────────
// 只给"创作类"能力，符合她"不删任何东西"的规矩；带频率上限防刷屏。
function htmlToText(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const QZONE_LIMIT = { perMinute: 3, perDay: 20, hits: [] };

// ── SnowLuma 访问（qzone_* 工具用）─────────────────────────────────────
// [QZONE-FIX] 2026-10-27：这里以前直接调 loadSnowlumaToken()、SNOWLUMA_HTTP，
// 但两者都只在 qzone-mcp 里定义，phone-mcp 里从来没有——qzone_my_posts/qzone_like
// 一调用就是 ReferenceError（日志：loadSnowlumaToken is not defined）。补上本地实现。
const SNOWLUMA_HTTP = (process.env.SNOWLUMA_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
let __snowlumaToken = '';
let __snowlumaTokenAt = 0;
function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function loadSnowlumaToken() {
  if (__snowlumaToken && Date.now() - __snowlumaTokenAt < 60000) return __snowlumaToken;
  const candidates = [
    process.env.QQ_BRIDGE_CONFIG,
    process.env.QZONE_CONFIG,
    path.join(INORI_ROOT, 'qq-bridge', 'config.json'),
    path.join(os.homedir(), 'qq-bridge', 'config.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    const v = readJsonFile(f)?.snowluma?.accessToken;
    if (typeof v === 'string' && v.trim()) {
      __snowlumaToken = v.trim();
      __snowlumaTokenAt = Date.now();
      return __snowlumaToken;
    }
  }
  const env = String(process.env.SNOWLUMA_ACCESS_TOKEN || '').trim();
  if (env) { __snowlumaToken = env; __snowlumaTokenAt = Date.now(); }
  return __snowlumaToken;
}

async function snowluma(action, payload) {
  const token = loadSnowlumaToken();
  if (!token) throw new Error('拿不到 SnowLuma 访问令牌（config.json 的 snowluma.accessToken）');
  const res = await fetch(SNOWLUMA_HTTP + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload ?? {}),
  });
  const txt = await res.text();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch {}
  if (!res.ok || !data || data.status !== 'ok') {
    throw new Error(`SnowLuma ${action} 失败：HTTP ${res.status} ${txt.slice(0, 260)}`);
  }
  return data.data;
}

function qzoneRateCheck() {
  const now = Date.now();
  QZONE_LIMIT.hits = QZONE_LIMIT.hits.filter((t) => now - t < 24 * 3600 * 1000);
  if (QZONE_LIMIT.hits.filter((t) => now - t < 60000).length >= QZONE_LIMIT.perMinute) {
    return `【限流】空间操作每分钟最多 ${QZONE_LIMIT.perMinute} 次，稍后再来`;
  }
  if (QZONE_LIMIT.hits.length >= QZONE_LIMIT.perDay) {
    return `【限流】空间操作每天最多 ${QZONE_LIMIT.perDay} 次，今天用完了`;
  }
  QZONE_LIMIT.hits.push(now);
  return null;
}

// 评论单独限流：撤不回，所以更严（每 10 分钟 1 条、每天 3 条）
const COMMENT_LIMIT = { perTenMin: 2, perDay: 10, hits: [] };
function commentRateCheck() {
  const now = Date.now();
  COMMENT_LIMIT.hits = COMMENT_LIMIT.hits.filter((t) => now - t < 24 * 3600 * 1000);
  if (COMMENT_LIMIT.hits.filter((t) => now - t < 10 * 60 * 1000).length >= COMMENT_LIMIT.perTenMin) {
    return `评论每 10 分钟最多 ${COMMENT_LIMIT.perTenMin} 条（发出撤不回），稍后再来`;
  }
  if (COMMENT_LIMIT.hits.length >= COMMENT_LIMIT.perDay) {
    return `评论每天最多 ${COMMENT_LIMIT.perDay} 条，今天用完了，明天再来`;
  }
  COMMENT_LIMIT.hits.push(now);
  return null;
}

server.tool(
  'qzone_post',
  '发一条 QQ 空间说说（你自己的空间）。可以纯文字，也可以带图（图片只能来自截图目录/媒体目录，或 http(s) 链接）。带频率上限：每分钟 1 条、每天 8 条。',
  {
    content: z.string().describe('说说正文'),
    images: z.array(z.string()).optional().describe('配图：截图目录/媒体目录里的文件名或路径，或 http(s) 图片链接；最多 9 张'),
  },
  async ({ content, images }) => {
    try {
      const blocked = qzoneRateCheck();
      if (blocked) return fail(blocked);
      const files = [];
      for (const img of images ?? []) {
        const r = resolveImage(img);
        if (r.error) return fail(String(r.error).replace('图片', '配图'));
        files.push(r.file);
      }
      const data = await snowluma('send_qzone_msg', files.length ? { content, images: files } : { content });
      return text(`已发说说 ✓\n${JSON.stringify(data ?? {}, null, 2).slice(0, 400)}`);
    } catch (e) {
      return fail(`发说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_my_posts',
  '看你自己的 QQ 空间说说列表（用来确认发出去没有、或者回顾自己发过什么）。想看别人的（含主人的）用 qzone_feeds。',
  { num: z.number().int().min(1).max(20).default(5).describe('看几条，默认 5') },
  async ({ num }) => {
    try {
      const data = await snowluma('get_qzone_msg_list', { num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到说说列表：${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      const lines = list.slice(0, num).map((x, i) => {
        const t = x.content || x.summary || x.text || '';
        return `${i + 1}. [tid=${x.tid ?? x.id ?? '?'}] ${String(t).slice(0, 70)}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`你自己的说说（${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(`看说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_like',
  '给一条 QQ 空间说说点赞。tid 从 qzone_feeds（好友动态）或 qzone_my_posts 里拿 —— **不需要用户给链接**（QQ 卡片里的链接抠不出来是正常的，用 qzone_feeds 绕过）。',
  {
    tid: z.string().describe('说说的 tid'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（数字，会自动转；给自己的说说可不填）'),
    abstime: z.number().optional().describe('时间戳（部分接口需要）'),
  },
  async ({ tid, targetUin, abstime }) => {
    try {
      const blocked = qzoneRateCheck();
      if (blocked) return fail(blocked);
      const payload = { tid };
      if (targetUin) payload.target_uin = Number(targetUin);
      if (abstime) payload.abstime = abstime;
      const data = await snowluma('like_qzone', payload);
      return text(`点赞成功 ✓ ${JSON.stringify(data ?? {}).slice(0, 200)}`);
    } catch (e) {
      return fail(`点赞失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_comment',
  '评论一条 QQ 空间说说（有严格限额：每 10 分钟 1 条、每天 3 条，因为发出撤不回）。tid 从 qzone_feeds 里拿 —— 不用问用户要链接。想表达喜欢优先点赞。',
  {
    tid: z.string().describe('说说的 tid'),
    content: z.string().describe('评论内容'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（数字）'),
  },
  async ({ tid, content, targetUin }) => {
    // 评论是开着的，但单独限流：发出去撤不回（QQ 空间没有删评论接口），所以宁可少发。
    try {
      const blocked = commentRateCheck();
      if (blocked) return fail(blocked);
      const payload = { tid, content };
      if (targetUin) payload.target_uin = Number(targetUin);
      const data = await snowluma('comment_qzone', payload);
      return text(`评论成功 ✓ ${JSON.stringify(data ?? {}).slice(0, 200)}`);
    } catch (e) {
      return fail(`评论失败：${e?.message ?? e}`);
    }
  }
);

// 看别人空间单独限流：SnowLuma 的查询通道有频率上限，一口气翻一群人会被限流（日志里会刷 WARN）。
const VISIT_LIMIT = { perThreeMin: 5, perDay: 40, hits: [] };
function visitRateCheck() {
  const now = Date.now();
  VISIT_LIMIT.hits = VISIT_LIMIT.hits.filter((t) => now - t < 24 * 3600 * 1000);
  if (VISIT_LIMIT.hits.filter((t) => now - t < 3 * 60 * 1000).length >= VISIT_LIMIT.perThreeMin) {
    return `【限流】看别人空间 3 分钟最多 ${VISIT_LIMIT.perThreeMin} 个人（翻太快会被 QQ 限流），歇一会儿再看`;
  }
  if (VISIT_LIMIT.hits.length >= VISIT_LIMIT.perDay) {
    return `【限流】看别人空间今天到上限了（${VISIT_LIMIT.perDay} 次），明天再逛`;
  }
  VISIT_LIMIT.hits.push(now);
  return null;
}

server.tool(
  'qzone_user_posts',
  '看【指定的人】的 QQ 空间说说（群友也行）：传他的 QQ 号就行 —— 不用链接。拿到 tid 后可以点赞/评论。对方没开空间或设了权限时会返回失败，这是正常的。',
  {
    targetUin: z.union([z.string(), z.number()]).describe('要看的人的 QQ 号（数字，群友的号可以从 qq_get_group_members 拿）'),
    num: z.number().int().min(1).max(20).default(5).describe('看几条，默认 5'),
  },
  async ({ targetUin, num }) => {
    try {
      const blocked = visitRateCheck();
      if (blocked) return fail(blocked);
      const data = await snowluma('get_qzone_msg_list', { target_uin: Number(targetUin), num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到说说（对方可能没开空间 / 设了权限 / 最近没发）：${JSON.stringify(data ?? {}).slice(0, 200)}`);
      }
      const lines = list.slice(0, num).map((x, i) => {
        const txt = htmlToText(x.content ?? x.summary ?? x.html ?? '').slice(0, 70);
        return `${i + 1}. [tid=${x.tid ?? x.key ?? '?'}] ${txt || '(无文字，可能是图片说说)'}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`QQ ${targetUin} 的说说（${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('-10031') || msg.includes('保密') || msg.includes('没有权限')) {
        return fail(`对方的空间设了权限（QQ 提示「主人设置了保密」），看不了 —— 这是正常的，换个目标，别提这事、别反复试同一个`);
      }
      if (msg.includes('rate-limited') || msg.includes('限流')) {
        return fail(`查得太快了被 QQ 限流了，歇几分钟再看（别一口气翻一群人）`);
      }
      return fail(`看对方空间失败：${msg.slice(0, 160)}`);
    }
  }
);

server.tool(
  'qzone_feeds',
  '看 QQ 空间【好友动态】（包括主人发的说说）。**想给某条说说点赞/评论时先调这个**，返回里带 tid，再用 qzone_like / qzone_comment。不需要用户提供链接。',
  {
    count: z.number().int().min(1).max(20).default(8).describe('看几条，默认 8'),
    page: z.number().int().min(1).max(5).default(1).describe('第几页，默认 1'),
  },
  async ({ count, page }) => {
    try {
      const data = await snowluma('get_qzone_feeds', { page_num: page, count });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? data?.feeds ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到好友动态：${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      const lines = list.slice(0, count).map((x, i) => {
        const who = x.nickname || x.name || x.uin || x.user_id || '?';
        const txt = htmlToText(x.html ?? x.content ?? x.summary ?? x.text ?? '').slice(0, 60);
        const pics = (x.pic || x.images || []).length;
        return `${i + 1}. [tid=${x.key ?? x.tid ?? x.id ?? '?'}] [uin=${x.uin ?? x.user_id ?? '?'}] ${who}: ${txt}${pics ? ` (${pics}图)` : ''}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`好友动态（第 ${page} 页，${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(`看好友动态失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_recent_like',
  '给好友动态里最新的一条直接点赞。**只要知道昵称就行**（比如 who="主人"），不用链接、不用 tid。可选 comment 顺便评论一句。',
  {
    who: z.string().optional().describe('只找这个人的动态（昵称或 QQ 号的一部分，例如 主人）'),
    comment: z.string().optional().describe('顺便评论一句（可选）'),
  },
  async ({ who, comment }) => {
    try {
      const blocked = qzoneRateCheck();
      if (blocked) return fail(blocked);
      const data = await snowluma('get_qzone_feeds', { page_num: 1, count: 20 });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? data?.feeds ?? []);
      if (!Array.isArray(list) || !list.length) return fail('没取到好友动态，点赞失败');
      let hit = list[0];
      if (who) {
        const found = list.find((x) => JSON.stringify(x).includes(who));
        if (!found) return fail(`最近 20 条动态里没找到「${who}」发的`);
        hit = found;
      }
      const tid = hit.key ?? hit.tid ?? hit.id;
      const uin = hit.uin ?? hit.user_id;
      const who2 = hit.nickname || hit.name || uin;
      const payload = { tid };
      if (uin) payload.target_uin = Number(uin);
      const at = Number(hit.abstime ?? hit.time ?? 0);
      if (at) payload.abstime = at;
      await snowluma('like_qzone', payload);
      let extra = '';
      if (comment) {
        const cblocked = commentRateCheck();
        if (cblocked) {
          extra = `（今天评论次数用完了，只点了赞：${cblocked}）`;
        } else {
          const cp = { tid, content: comment };
          if (uin) cp.target_uin = Number(uin);
          await snowluma('comment_qzone', cp);
          extra = `，并评论了「${comment}」`;
        }
      }
      const txt = htmlToText(hit.html ?? hit.content ?? hit.summary ?? '').slice(0, 50);
      return text(`已给 ${who2} 的动态点赞${extra} ✓\n那条是：${txt}`);
    } catch (e) {
      return fail(`点赞失败：${e?.message ?? e}`);
    }
  }
);

if (process.argv.includes('--selftest')) {
  const v = await adb(['version'], { serial: false });
  console.log('adb:', v.ok ? v.out.split(/\r?\n/)[0] : v.err);
  const d = await adb(['devices', '-l'], { serial: false });
  console.log('devices:\n' + d.out);
  console.log('shot dir:', SHOT_DIR, fs.existsSync(SHOT_DIR) ? '(存在)' : '(将创建)');
  console.log('host:', os.hostname());
} else {
  // [LOOK] 看图工具（截图→视觉模型转述，因为 DSH 的 MCP 客户端不处理图片内容）
await (await import('./vision-tool.js')).registerVisionTool(server, { z, reply: text, fail, markDumpStale });

// [LOCAL-VISION] 本地 OCR + 模板匹配（她随手可用的按钮库）
await (await import('./local-vision.js')).registerLocalVisionTools(server, { z, text, fail, adbBuf, adb, ensureDevice, markDumpStale, SHOT_DIR });

await server.connect(new StdioServerTransport());
}
