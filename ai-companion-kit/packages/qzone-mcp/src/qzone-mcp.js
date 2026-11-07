// qzone-mcp · QQ 空间 MCP 服务器（stdio）
//
// 干什么：让 AI 自己发 QQ 空间说说、看好友动态、点赞、评论。
//
// 用法：
//   1) 机器上跑着 SnowLuma（QQ 网关），OneBot HTTP 在 127.0.0.1:3000
//   2) npx qzone-mcp
//   3) 在任意支持 MCP 的客户端里配上它
//
// 环境变量（都可选）：
//   SNOWLUMA_HTTP_URL       OneBot HTTP 地址（默认 http://127.0.0.1:3000）
//   SNOWLUMA_ACCESS_TOKEN   访问令牌（默认从 qq-bridge 的 config.json 里读）
//   QZONE_CONFIG            配置文件路径（默认自动探测 config.json）
//   QZONE_IMAGE_DIRS        允许发图的目录，多个用 ; 分隔（默认 图库 + 她工坊 + 系统图片）
//
// 设计要点：
// - 不依赖 adb、不依赖手机，只要能连上 SnowLuma 就能用。
// - 只给「创作类」能力：发、看、赞、评。**删除和拉黑故意不提供** —— 发出去的话收不回来，这是刻意的限制。
// - 评论有本地去重账本（同一条 30 天内只评一次）+ 回评用「@对方 内容」（空间评论是平铺的）。
// - 每类操作都带频率上限，防止一口气刷屏。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveGuardFile, loadComments, saveComments, findPriorComment, recordComment, renderReplyContent } from './qzone-comment-guard.js';
// [TOOL-CATALOG] 核心常驻 + 分类目录按需调用（省 token：未常驻的工具不再随每次请求发 schema）
import { installToolCatalog } from '../../shared/mcp-tool-catalog.mjs';

// ── 配置 ────────────────────────────────────────────────────────────────
const SNOWLUMA_HTTP = (process.env.SNOWLUMA_HTTP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

const CONFIG_CANDIDATES = [
  process.env.QZONE_CONFIG,
  process.env.QQ_BRIDGE_CONFIG,
  process.env.HER_BRIDGE_DIR && path.join(process.env.HER_BRIDGE_DIR, 'config.json'),
  path.join(process.cwd(), 'config.json'),
  path.join(process.cwd(), '..', 'config.json'),
  path.join(os.homedir(), 'qq-bridge', 'config.json'),
].filter(Boolean);

// 允许发图的目录：只认这几个地方，别的路径一律拒绝
// 默认值按仓库位置推算。以前写死的作者本机图库路径在别的机器上不存在，
// 结果就是「发图必然被拒」——她连一张图都放不上去。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.HER_BRIDGE_DIR
  ? path.dirname(path.resolve(process.env.HER_BRIDGE_DIR))
  : path.resolve(HERE, '../../../..');

const GALLERY_DIR = path.join(REPO_ROOT, 'data', 'pics');      // 图库：放进去就能被她看见
const WORKSHOP_DIR = path.join(REPO_ROOT, 'data', 'workshop'); // 她工坊里存下的图

// 图库不存在就建一个（提示词里让她「先 qzone_images 看看图库」，不能给它一个空目录 404）
// 必须在 IMAGE_DIRS 过滤之前建，否则第一次启动时图库会被当成「不存在」跳过
try { fs.mkdirSync(GALLERY_DIR, { recursive: true }); } catch {}
try {
  const readme = path.join(GALLERY_DIR, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '这里是她的图库。把图片放进这个文件夹，她发说说时就能配上（qzone_images 看有什么，qzone_post 的 images 填文件名或完整路径）。\n', 'utf8');
  }
} catch {}

const IMAGE_DIR_CANDIDATES = (process.env.QZONE_IMAGE_DIRS
  || [GALLERY_DIR, WORKSHOP_DIR, path.join(os.homedir(), 'Pictures')].join(';'))
  .split(';').map((s) => s.trim()).filter(Boolean);

function isDir(d) {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

const MISSING_IMAGE_DIRS = IMAGE_DIR_CANDIDATES.filter((d) => !isDir(d));
const IMAGE_DIRS = IMAGE_DIR_CANDIDATES.filter(isDir);

const MAX_IMAGES = 9;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

// 她通常只会说个文件名，不会给绝对路径 —— 在图库里按名字找
function findImageByName(name) {
  const want = String(name).toLowerCase();
  const hits = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= 20) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (e.name.toLowerCase() === want) hits.unshift(full);
      else if (e.name.toLowerCase().includes(want)) hits.push(full);
    }
  };
  for (const d of IMAGE_DIRS) walk(d, 2);
  return hits[0] || null;
}

// ── 图库：分类文件夹 + 收藏索引 ──────────────────────────────────────────
// index.json 记「这张图是在哪一类、当初为什么存」，qzone_images 才能按情绪/主题找图，
// 而不是让她对着一堆 IMG_1234.jpg 猜。
const GALLERY_INDEX = path.join(GALLERY_DIR, 'index.json');

function loadGalleryIndex() {
  const j = readJson(GALLERY_INDEX);
  return { version: 1, items: Array.isArray(j?.items) ? j.items : [] };
}

function saveGalleryIndex(idx) {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });
  fs.writeFileSync(GALLERY_INDEX, JSON.stringify(idx, null, 2), 'utf8');
}

const relOf = (full) => path.relative(GALLERY_DIR, full).split(path.sep).join('/');

function sanitizeFolder(folder) {
  const s = String(folder ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 24);
  return s || '随手';
}

function sanitizeName(name) {
  return String(name ?? '')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .trim()
    .slice(0, 40);
}

function guessExt(name, source, buf) {
  const fromName = path.extname(String(name ?? '')).toLowerCase();
  if (IMAGE_EXT.has(fromName)) return fromName;
  if (/^https?:/i.test(String(source))) {
    try {
      const e = path.extname(new URL(source).pathname).toLowerCase();
      if (IMAGE_EXT.has(e)) return e;
    } catch {}
  }
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b[0] === 0x47 && b[1] === 0x49) return '.gif';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return '.bmp';
  return '.jpg';
}

// 存一张她喜欢的图：链接就下载，本地图就复制；按内容去重；顺手记一句「为什么存」
async function savePicture({ source, folder, name, note, tags }) {
  const s = String(source ?? '').trim();
  if (!s) return { error: '来源是空的：给个 http(s) 链接，或者图库里已有图片的路径/文件名' };

  let buf;
  if (/^https?:\/\//i.test(s)) {
    let res;
    try {
      res = await fetch(s, { redirect: 'follow' });
    } catch (e) {
      return { error: `下载失败：${e?.message ?? e}` };
    }
    if (!res.ok) return { error: `下载失败：HTTP ${res.status}` };
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 20 * 1024 * 1024) return { error: '图片太大（>20MB），不存' };
    buf = Buffer.from(ab);
  } else {
    const r = resolveImage(s);
    if (r.error) return { error: r.error };
    try { buf = fs.readFileSync(r.file); } catch (e) { return { error: `读取本地图失败：${e?.message ?? e}` }; }
  }
  if (!buf.length) return { error: '拿到的图片是空的' };

  const sha1 = createHash('sha1').update(buf).digest('hex');
  const idx = loadGalleryIndex();
  const dup = idx.items.find((it) => it.sha1 === sha1);
  if (dup) {
    const full = path.join(GALLERY_DIR, String(dup.id));
    if (fs.existsSync(full)) return { ok: true, duplicated: true, path: full, item: dup };
  }

  const dirName = sanitizeFolder(folder);
  const ext = guessExt(name, s, buf);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const base = sanitizeName(name) || `${stamp}-${sha1.slice(0, 8)}`;
  const targetDir = path.join(GALLERY_DIR, dirName);
  let full = path.join(targetDir, base + ext);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (let i = 2; fs.existsSync(full) && i < 50; i += 1) full = path.join(targetDir, `${base}-${i}${ext}`);
    fs.writeFileSync(full, buf);
  } catch (e) {
    return { error: `存图失败（写不进图库 ${targetDir}）：${e?.message ?? e}` };
  }

  const item = {
    id: relOf(full),
    folder: dirName,
    note: String(note ?? '').trim().slice(0, 200),
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12),
    sha1,
    addedAt: new Date().toISOString(),
    source: s.slice(0, 300),
  };
  idx.items.unshift(item);
  try { saveGalleryIndex(idx); } catch {}
  return { ok: true, duplicated: false, path: full, item };
}

function listImages({ keyword = '', limit = 10 } = {}) {
  const want = String(keyword ?? '').trim().toLowerCase();
  const idx = loadGalleryIndex();
  const meta = new Map(idx.items.map((it) => [String(it.id), it]));
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (e.name === 'index.json') continue;
      const inGallery = full.startsWith(GALLERY_DIR + path.sep);
      const rel = inGallery ? relOf(full) : null;
      const metaItem = rel ? meta.get(rel) : null;
      const folder = rel ? (path.dirname(rel) === '.' ? '（根）' : path.dirname(rel)) : path.basename(path.dirname(full));
      const note = metaItem?.note ?? '';
      const tags = metaItem?.tags ?? [];
      const hay = `${e.name} ${folder} ${note} ${tags.join(' ')}`.toLowerCase();
      if (want && !hay.includes(want)) continue;
      try {
        const st = fs.statSync(full);
        if (!st.size) continue;
        found.push({ full, name: e.name, size: st.size, mtime: st.mtimeMs, folder, note, tags });
      } catch {}
    }
  };
  for (const d of IMAGE_DIRS) walk(d, 2);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit);
}

// 评论账本：同一条说说 30 天内评过就不重复评（评论撤不回）
const COMMENT_FILE = resolveGuardFile();

// ── 令牌 ────────────────────────────────────────────────────────────────
let __token = null;
let __tokenAt = 0;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadSnowlumaToken() {
  if (__token && Date.now() - __tokenAt < 60000) return __token;

  // ① config.json 的 snowluma.accessToken
  for (const f of CONFIG_CANDIDATES) {
    const c = readJson(f);
    const v = c?.snowluma?.accessToken;
    if (typeof v === 'string' && v.trim()) {
      __token = v.trim(); __tokenAt = Date.now(); return __token;
    }
  }

  // ② 环境变量
  if (process.env.SNOWLUMA_ACCESS_TOKEN) {
    __token = String(process.env.SNOWLUMA_ACCESS_TOKEN).trim();
    __tokenAt = Date.now(); return __token;
  }

  // ③ 兜底：SnowLuma 自己的 config/onebot_<uin>.json
  for (const d of ['E:\\SnowLuma\\config', path.join(os.homedir(), 'SnowLuma', 'config')]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (!/^onebot_.*\.json$/.test(name)) continue;
      const c = readJson(path.join(d, name));
      const v = c?.networks?.httpServer?.accessToken ?? c?.accessToken ?? c?.networks?.accessToken;
      if (typeof v === 'string' && v.trim()) {
        __token = v.trim(); __tokenAt = Date.now(); return __token;
      }
    }
  }
  return null;
}

// ── OneBot 调用 ─────────────────────────────────────────────────────────
async function snowluma(action, payload) {
  const token = loadSnowlumaToken();
  if (!token) throw new Error('拿不到访问令牌。设环境变量 SNOWLUMA_ACCESS_TOKEN，或确认 config.json 里有 snowluma.accessToken');
  const res = await fetch(`${SNOWLUMA_HTTP}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload ?? {}),
  });
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch {}
  if (!res.ok || !data || data.status !== 'ok') {
    throw new Error(`${action} 失败：HTTP ${res.status} ${txt.slice(0, 260)}`);
  }
  return data.data;
}

// ── 图片 ────────────────────────────────────────────────────────────────
function resolveImage(input) {
  const s = String(input ?? '').trim();
  if (!s) return { error: '图片路径是空的' };
  if (/^https?:\/\//i.test(s)) return { file: s };        // 网络图直接交给 OneBot
  let abs = path.resolve(s);
  if (!fs.existsSync(abs) && !/[\\/]/.test(s)) {
    // 只给了文件名：去图库/工坊里找
    const hit = findImageByName(s);
    if (hit) abs = hit;
  }
  const ok = IMAGE_DIRS.some((d) => {
    const base = path.resolve(d);
    return abs === base || abs.startsWith(base + path.sep);
  });
  if (!ok) {
    return { error: `图片不在允许的目录里：${abs}\n允许的目录：${IMAGE_DIRS.join(' , ')}\n先用 qzone_images 看看图库里有什么；也可以直接给 http(s) 图片链接。` };
  }
  if (!fs.existsSync(abs)) return { error: `图片不存在：${abs}` };
  return { file: abs };
}

// ── 文本处理 ────────────────────────────────────────────────────────────
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

// ── 限流 ────────────────────────────────────────────────────────────────
function makeLimiter(checks, label) {
  return function check() {
    const now = Date.now();
    this.hits = (this.hits || []).filter((t) => now - t < 24 * 3600 * 1000);
    for (const [ms, max, word] of checks) {
      if (max && this.hits.filter((t) => now - t < ms).length >= max) {
        return `【限流】${label}${word}最多 ${max} 次，稍后再来`;
      }
    }
    this.hits.push(now);
    return null;
  };
}

const limitGeneric = makeLimiter([[60e3, 3, '每分钟']], '空间操作').bind({});
const limitComment = makeLimiter([[10 * 60e3, 2, '每 10 分钟'], [86400e3, 10, '每天']], '评论').bind({});
const limitVisit = makeLimiter([[3 * 60e3, 5, '每 3 分钟（翻太快会被 QQ 限流）'], [86400e3, 40, '每天']], '看别人空间').bind({});

// ── MCP ─────────────────────────────────────────────────────────────────
const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

const server = new McpServer({ name: 'qzone', version: '0.1.0' });

// [TOOL-CATALOG] 4 个高频工具常驻，其余 8 个收进 qzone_tools 分类目录。
// 必须在所有 server.tool(...) 之前安装；只改注册面，工具实现未动。
installToolCatalog(server, {
  catalogName: 'qzone_tools',
  catalogDescription: '【工具目录】空间工具大部分没有常驻，按分类收着。用法：① 不传参数 → 列出所有分类；② 只传 category → 列出该分类下的工具和用途；③ 传 tool + arguments → 直接调用那个工具（参数和它原本的 schema 一致）。常驻可直接用的是：qzone_feeds / qzone_post / qzone_my_posts / qzone_images。',
  coreTools: ['qzone_feeds', 'qzone_post', 'qzone_my_posts', 'qzone_images'],
  groups: {
    互动: ['qzone_like', 'qzone_unlike', 'qzone_comment', 'qzone_recent_like'],
    查看他人: ['qzone_user_posts'],
    图库管理: ['qzone_pic_save'],
    说说管理: ['qzone_delete', 'qzone_set_right'],
  },
});

server.tool(
  'qzone_post',
  '发一条 QQ 空间说说（你自己的空间）。可以纯文字，也可以带图（图只能来自图库/工坊目录，或者 http(s) 链接；最多 9 张）。配图前先用 qzone_images 看看图库里有什么。★配图必须和正文对得上：同一种情绪，或者内容上是同一件事；凑不出对得上的图，就纯文字发——别为了「有图」硬配一张。★默认「好友可见」，想给所有人看传 ugcRight=1，只想自己留着传 64。★带频率上限，别连着发。',
  {
    content: z.string().describe('说说正文'),
    images: z.array(z.string()).max(MAX_IMAGES).optional().describe('配图：图库里的文件名或绝对路径，或 http(s) 图片链接；最多 9 张'),
    ugcRight: z.number().int().refine((v) => [1, 4, 16, 64, 128].includes(v), { message: '只能是 1/4/16/64/128' }).optional()
      .describe('谁能看见：4 好友（默认）、1 所有人、16 部分好友可见、64 仅自己、128 部分好友不可见'),
    targetUins: z.array(z.union([z.string(), z.number()])).optional()
      .describe('ugcRight=16 时可看见的 QQ 号；128 时是不可见的 QQ 号'),
  },
  async ({ content, images, ugcRight, targetUins }) => {
    try {
      const blocked = limitGeneric();
      if (blocked) return fail(blocked);
      // 主人 2026-10-28 拍板：默认收紧到「好友可见」。以前不传就落到 SnowLuma 的默认 1=所有人，
      // 她的账号不该默认对陌生人开放——要公开必须显式传 1。
      const right = ugcRight ?? 4;
      if ((right === 16 || right === 128) && !(targetUins ?? []).length) {
        return fail(`ugcRight=${right} 必须同时给 targetUins（谁能看 / 谁不能看）`);
      }
      const files = [];
      for (const img of images ?? []) {
        const r = resolveImage(img);
        if (r.error) return fail(r.error);
        files.push(r.file);
      }
      const payload = { content, ugc_right: right };
      if (files.length) payload.images = files;
      if (targetUins?.length) payload.target_uins = targetUins.map((u) => Number(u));
      const data = await snowluma('send_qzone_msg', payload);
      return text(`已发说说 ✓${files.length ? `（带 ${files.length} 张图）` : ''}\n${JSON.stringify(data ?? {}, null, 2).slice(0, 400)}`);
    } catch (e) {
      return fail(`发说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_my_posts',
  '看你自己的 QQ 空间说说列表（确认发出去没有、或者回顾自己发过什么）。想看别人的用 qzone_feeds 或 qzone_user_posts。',
  { num: z.number().int().min(1).max(20).default(5).describe('看几条，默认 5') },
  async ({ num }) => {
    try {
      const data = await snowluma('get_qzone_msg_list', { num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到说说列表：${JSON.stringify(data ?? {}).slice(0, 300)}`);
      }
      const lines = list.slice(0, num).map((x, i) => {
        const t = htmlToText(x.content ?? x.summary ?? x.text ?? '').slice(0, 70);
        return `${i + 1}. [tid=${x.tid ?? x.id ?? '?'}] ${t || '(无文字)'}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`你自己的说说（${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(`看说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_like',
  '给一条 QQ 空间说说点赞。tid 从 qzone_feeds 或 qzone_my_posts 里拿，不需要链接。',
  {
    tid: z.string().describe('说说的 tid'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（给自己的说说可不填）'),
    abstime: z.number().optional().describe('时间戳（部分接口需要）'),
  },
  async ({ tid, targetUin, abstime }) => {
    try {
      const blocked = limitGeneric();
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
  '评论一条 QQ 空间说说。**发出撤不回**（没有删评论接口），限额很紧：每 10 分钟 2 条、每天 10 条。同一条说说 30 天内评过会被拦下（本地账本去重），想表达喜欢优先点赞。要回某个人的评论就传 replyTo（昵称/QQ），内容会变成「@对方 你说的」——空间评论是平铺的，@ 就是回评。配图同理：和这条说说对得上才配，凑不出就纯文字。',
  {
    tid: z.string().describe('说说的 tid'),
    content: z.string().describe('评论内容'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（可选）'),
    replyTo: z.string().optional().describe('要回的人（昵称或 QQ 号，可选；填了会变成 @对方 前缀）'),
    images: z.array(z.string()).max(MAX_IMAGES).optional().describe('评论配图（可选）：图库文件名 / 绝对路径 / http(s) 链接；空间评论支持带图'),
  },
  async ({ tid, content, targetUin, replyTo, images }) => {
    try {
      const comments = loadComments(COMMENT_FILE);
      const prior = findPriorComment(comments, tid);
      if (prior) {
        return fail(`这条你 ${prior.ageDays} 天前已经评过：『${prior.content}』。同一条说说别重复评（评论撤不回）；换一条，或者把想说的话留到下次。`);
      }
      const finalContent = renderReplyContent(content, replyTo);
      if (!finalContent) return fail('评论内容是空的');
      const blocked = limitComment();
      if (blocked) return fail(blocked);
      const payload = { tid, content: finalContent };
      if (targetUin) payload.target_uin = Number(targetUin);
      if (images?.length) {
        const files = [];
        for (const img of images) {
          const r = resolveImage(img);
          if (r.error) return fail(r.error);
          files.push(r.file);
        }
        payload.images = files;
      }
      const data = await snowluma('comment_qzone', payload);
      recordComment(comments, tid, finalContent);
      saveComments(COMMENT_FILE, comments);
      return text(`评论成功 ✓ ${JSON.stringify(data ?? {}).slice(0, 200)}`);
    } catch (e) {
      return fail(`评论失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_user_posts',
  '看【指定的人】的 QQ 空间说说（群友也行）：传他的 QQ 号就行，不用链接。拿到 tid 后可以点赞/评论。对方没开空间或设了权限时会失败，这是正常的。',
  {
    targetUin: z.union([z.string(), z.number()]).describe('要看的人的 QQ 号'),
    num: z.number().int().min(1).max(20).default(5).describe('看几条，默认 5'),
  },
  async ({ targetUin, num }) => {
    try {
      const blocked = limitVisit();
      if (blocked) return fail(blocked);
      const data = await snowluma('get_qzone_msg_list', { target_uin: Number(targetUin), num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      if (!Array.isArray(list) || !list.length) {
        return text(`没取到说说（对方可能没开空间 / 设了权限 / 最近没发）：${JSON.stringify(data ?? {}).slice(0, 200)}`);
      }
      const lines = list.slice(0, num).map((x, i) => {
        const t = htmlToText(x.content ?? x.summary ?? x.html ?? '').slice(0, 70);
        return `${i + 1}. [tid=${x.tid ?? x.key ?? '?'}] ${t || '(无文字，可能是图片说说)'}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`QQ ${targetUin} 的说说（${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('-10031') || msg.includes('保密') || msg.includes('没有权限')) {
        return fail('对方的空间设了权限（QQ 提示「主人设置了保密」），看不了 —— 这是正常的，换个目标，别反复试同一个。');
      }
      if (msg.includes('rate-limited') || msg.includes('限流')) {
        return fail('查得太快被 QQ 限流了，歇几分钟再看（别一口气翻一群人）。');
      }
      return fail(`看对方空间失败：${msg.slice(0, 160)}`);
    }
  }
);

server.tool(
  'qzone_feeds',
  '看 QQ 空间【好友动态】（包括主人发的说说）。想给某条说说点赞/评论时先调这个，返回里带 tid。不需要用户提供链接。',
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
        const t = htmlToText(x.html ?? x.content ?? x.summary ?? x.text ?? '').slice(0, 60);
        const pics = (x.pic || x.images || []).length;
        return `${i + 1}. [tid=${x.key ?? x.tid ?? x.id ?? '?'}] [uin=${x.uin ?? x.user_id ?? '?'}] ${who}: ${t}${pics ? ` (${pics}图)` : ''}  赞${x.like_count ?? x.likenum ?? 0} 评${x.comment_count ?? x.cmtenum ?? 0}`;
      });
      return text(`好友动态（第 ${page} 页，${list.length} 条）：\n${lines.join('\n')}`);
    } catch (e) {
      return fail(`看好友动态失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_recent_like',
  '给好友动态里最新的一条直接点赞。只要知道昵称就行（比如 who="主人"），不用链接、不用 tid。可选 comment 顺便评论一句。',
  {
    who: z.string().optional().describe('只找这个人的动态（昵称或 QQ 号的一部分）'),
    comment: z.string().optional().describe('顺便评论一句（可选）'),
  },
  async ({ who, comment }) => {
    try {
      const blocked = limitGeneric();
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
      const name = hit.nickname || hit.name || uin;

      const payload = { tid };
      if (uin) payload.target_uin = Number(uin);
      const at = Number(hit.abstime ?? hit.time ?? 0);
      if (at) payload.abstime = at;
      await snowluma('like_qzone', payload);

      let extra = '';
      if (comment) {
        const comments = loadComments(COMMENT_FILE);
        const prior = findPriorComment(comments, tid);
        const cblocked = prior ? `这条 ${prior.ageDays} 天前评过（『${prior.content}』），不重复评` : limitComment();
        if (cblocked) {
          extra = `（只点了赞：${cblocked}）`;
        } else {
          const cp = { tid, content: comment };
          if (uin) cp.target_uin = Number(uin);
          await snowluma('comment_qzone', cp);
          recordComment(comments, tid, comment);
          saveComments(COMMENT_FILE, comments);
          extra = `，并评论了「${comment}」`;
        }
      }
      const t = htmlToText(hit.html ?? hit.content ?? hit.summary ?? '').slice(0, 50);
      return text(`已给 ${name} 的动态点赞${extra} ✓\n那条是：${t}`);
    } catch (e) {
      return fail(`点赞失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_images',
  '看【图库】里有哪些图片可以发。发说说/评论想配图时先调这个，拿到文件名再填进 qzone_post 的 images（直接填名字就行，不用完整路径）。关键词可以搜文件名、分类文件夹、以及你当初存图时写的备注/标签（比如 "夜" "猫" "想他"）。',
  {
    keyword: z.string().optional().describe('关键词（可选）：匹配文件名 / 分类文件夹 / 收藏备注 / 标签'),
    limit: z.number().int().min(1).max(30).default(10).describe('最多列几张，默认 10'),
  },
  async ({ keyword, limit }) => {
    const list = listImages({ keyword, limit });
    if (!list.length) {
      return text(`图库里没有${keyword ? `和「${keyword}」对得上的` : ''}图片。\n允许的目录：${IMAGE_DIRS.join(' , ')}\n（主人把图放进 ${GALLERY_DIR} 她就能用；也可以直接给 http(s) 图片链接，或者用 qzone_pic_save 把喜欢的图存进来）`);
    }
    const kb = (n) => `${Math.max(1, Math.round(n / 1024))}KB`;
    const when = (t) => new Date(t).toISOString().slice(0, 10);
    const lines = list.map((x, i) => {
      const note = x.note ? ` —— ${x.note}` : '';
      const tags = x.tags?.length ? ` [${x.tags.join('/')}]` : '';
      return `${i + 1}. [${x.folder}] ${x.name}（${kb(x.size)}，${when(x.mtime)}）${note}${tags}`;
    });
    return text(`图库里的图（${list.length} 张）：\n${lines.join('\n')}\n发的时候 images 直接填文件名即可。★配图要和正文对得上（同一种情绪，或者内容上是一件事）；找不到对得上的，就纯文字发，别硬配。`);
  }
);

server.tool(
  'qzone_pic_save',
  '遇到自己喜欢的图，存进图库（以后发说说能配）。给 http(s) 链接，或者图库里已有图片的路径。'
    + 'folder 是一两个词的主题/情绪分类（比如「夜里」「想他」「猫」「游戏」），note 写一句「为什么存它 / 适合什么情绪」——以后靠这句话找图。'
    + '同一张图不会重复存。',
  {
    source: z.string().describe('图片来源：http(s) 链接，或本地图片路径/文件名'),
    folder: z.string().optional().describe('分类文件夹（一两个词，如「夜里」「猫」），默认「随手」'),
    name: z.string().optional().describe('文件名（可选，不填自动按时间+指纹生成）'),
    note: z.string().optional().describe('一句话：为什么喜欢它 / 适合配什么情绪'),
    tags: z.array(z.string()).optional().describe('几个标签（可选，方便以后搜）'),
  },
  async ({ source, folder, name, note, tags }) => {
    const r = await savePicture({ source, folder, name, note, tags });
    if (r.error) return fail(r.error);
    if (r.duplicated) {
      return text(`这张图图库里已经有了（不重复存）：${r.path}\n分类：${r.item?.folder ?? '?'}${r.item?.note ? `｜备注：${r.item.note}` : ''}`);
    }
    return text(`已存进图库 ✓\n文件：${r.path}\n分类：${r.item.folder}${r.item.note ? `\n备注：${r.item.note}` : ''}${r.item.tags.length ? `\n标签：${r.item.tags.join('、')}` : ''}\n发说说时 images 填「${path.basename(r.path)}」就行。`);
  }
);

server.tool(
  'qzone_delete',
  '删除你自己空间里的一条说说（按 tid）。**只有真发错了才用**——删了就没了，恢复不了。发之前先想清楚比删更省事。',
  { tid: z.string().describe('要删的说说 tid（来自 qzone_my_posts / qzone_post 的返回）') },
  async ({ tid }) => {
    try {
      await snowluma('delete_qzone_msg', { tid });
      return text(`已删除说说 ${tid} ✓`);
    } catch (e) {
      return fail(`删说说失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_set_right',
  '改一条【已经发出去的】说说的可见权限（按 tid）。比如后来觉得说多了、只想给好友看。',
  {
    tid: z.string().describe('说说的 tid'),
    ugcRight: z.number().int().refine((v) => [1, 4, 16, 64, 128].includes(v), { message: '只能是 1/4/16/64/128' })
      .describe('1 所有人、4 好友、16 部分好友可见、64 仅自己、128 部分好友不可见'),
    targetUins: z.array(z.union([z.string(), z.number()])).optional().describe('ugcRight=16/128 时的名单'),
  },
  async ({ tid, ugcRight, targetUins }) => {
    try {
      if ((ugcRight === 16 || ugcRight === 128) && !(targetUins ?? []).length) {
        return fail(`ugcRight=${ugcRight} 必须同时给 targetUins`);
      }
      const payload = { tid, ugc_right: ugcRight };
      if (targetUins?.length) payload.target_uins = targetUins.map((u) => Number(u));
      const data = await snowluma('set_qzone_msg_right', payload);
      return text(`权限已改 ✓ ${JSON.stringify(data ?? {}).slice(0, 200)}`);
    } catch (e) {
      return fail(`改权限失败：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'qzone_unlike',
  '取消对一条说说的赞（按 tid）。手滑点错、或者后来觉得不该赞的时候用。',
  {
    tid: z.string().describe('说说的 tid'),
    targetUin: z.union([z.string(), z.number()]).optional().describe('说说主人的 QQ 号（自己的可不填）'),
  },
  async ({ tid, targetUin }) => {
    try {
      const payload = { tid };
      if (targetUin) payload.target_uin = Number(targetUin);
      await snowluma('unlike_qzone', payload);
      return text(`已取消赞 ✓`);
    } catch (e) {
      return fail(`取消赞失败：${e?.message ?? e}`);
    }
  }
);

// ── 启动 ────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  const token = loadSnowlumaToken();
  console.log('OneBot 地址:', SNOWLUMA_HTTP);
  console.log('令牌:', token ? `已拿到（${token.length} 字符）` : '❌ 没找到（设 SNOWLUMA_ACCESS_TOKEN，或确认 config.json 里有 snowluma.accessToken）');
  console.log('允许发图的目录:', IMAGE_DIRS.join(' , ') || '（空 —— 发图会被拒绝，用 QZONE_IMAGE_DIRS 配一个）');
  if (MISSING_IMAGE_DIRS.length) console.log('  跳过（不存在）:', MISSING_IMAGE_DIRS.join(' , '));
  console.log(`图库: ${GALLERY_DIR} → 现有图片 ${listImages({ limit: 30 }).length} 张`);
  if (token) {
    try {
      const d = await snowluma('get_qzone_msg_list', { num: 1 });
      const list = d?.msglist ?? d?.data?.msglist ?? d?.msgs ?? [];
      // 只报条数：说说内容是她自己的，不该顺手刷到终端/截图里
      console.log(`连通性: ✅ 能取到自己的说说（${Array.isArray(list) ? list.length : 0} 条，内容不打印）`);
    } catch (e) {
      console.log('连通性: ❌', e?.message ?? e);
    }
  }
} else {
  await server.connect(new StdioServerTransport());
}
