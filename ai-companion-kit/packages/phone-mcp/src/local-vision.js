// local-vision.js · 手机画面本地识别工具（OCR + 模板匹配 + 模板保存）
//
// 价值取向（用户拍板）：一切以「她随手可用的工具」为价值。所以这里做的是：
//   - phone_ocr            ：把当前画面上的字读出来（本地，不联网、不花云 token）
//   - phone_find_template  ：在画面里找一张图/按钮（模板匹配，毫秒级）
//   - phone_tap_template   ：找到就点（比按坐标手算稳）
//   - phone_template_save  ：把画面上一块区域存成模板（她可以自己攒按钮）
//   - phone_templates      ：看看现在有哪些模板
//
// 实现：常驻 Python 服务（vision/phone_vision_server.py，RapidOCR + OpenCV）。
// 首次调用自动拉起；之后每次只付推理时间（模型常驻内存）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
// [SCREEN-GUARD] 熄屏时 screencap 是黑的：截屏前先唤醒、黑帧重试一次、仍黑就明说（2026-10-29）
import { ensureAwake, wakeKey, grabWithLuma, isBlackFrame, blackFrameReason } from './screen-guard.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VISION_DIR = path.join(PKG_ROOT, 'vision');
const TEMPLATES_DIR = path.join(VISION_DIR, 'templates');
const SERVER_SCRIPT = path.join(VISION_DIR, 'phone_vision_server.py');
const LOG_FILE = path.join(VISION_DIR, 'phone-vision.log');
const VENV_PY = process.platform === 'win32'
  ? path.join(PKG_ROOT, '.venv', 'Scripts', 'python.exe')
  : path.join(PKG_ROOT, '.venv', 'bin', 'python');
const PORT = Number(process.env.PHONE_VISION_PORT) || 8791;
const INDEX_FILE = path.join(TEMPLATES_DIR, "index.json");

/** 模板备注索引：{name: {note, source, box, at}}。仅用于列表展示，不参与匹配。 */
function loadIndex() { try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); } catch { return {}; } }
function saveIndex(idx) { try { fs.mkdirSync(TEMPLATES_DIR, { recursive: true }); fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 1)); } catch { /* 索引失败不影响模板本身 */ } }
const BASE = `http://127.0.0.1:${PORT}`;

// [AUDIT-FIX] 本地视觉服务不再是裸端口：启动时下发随机 token，POST 必须携带。
// token 持久化在 vision/.vision-token，保证服务由别的进程拉起时口径一致；
// 文件权限 0600，且只写在本包目录内。
const TOKEN_FILE = path.join(VISION_DIR, '.vision-token');
const VISION_TOKEN = (() => {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* 首次启动 */ }
  const generated = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(VISION_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 只读安装：本次进程内仍可用 */ }
  return generated;
})();

let serverStarting = null;

function logLine(s) {
  try {
    fs.mkdirSync(VISION_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${s}\n`, 'utf8');
  } catch { /* 日志失败不影响主路 */ }
}

async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const j = await res.json().catch(() => ({}));
    // [AUDIT-FIX] 必须确认端口上跑的是本次 token 对应的服务：旧版无鉴权服务
    // 或别人拉起的服务一律不复用，避免把图片路径发给不受控进程（fail-closed）。
    return !!j.tokenFp && j.tokenFp === VISION_TOKEN.slice(0, 8);
  } catch { return false; }
}

/** 确保识别服务在线：不在就拉起（约 1~2 秒起服务；模型首次 OCR 时才加载）。 */
export async function ensureVisionServer() {
  if (await health()) return true;
  if (serverStarting) return serverStarting;
  serverStarting = (async () => {
    if (!fs.existsSync(VENV_PY)) {
      throw new Error(`识别服务未安装（缺 ${VENV_PY}）。装法：在 phone-mcp 目录 python -m venv .venv && .venv\\Scripts\\pip install rapidocr_onnxruntime opencv-python-headless`);
    }
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(VENV_PY, [SERVER_SCRIPT], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, PHONE_VISION_PORT: String(PORT), PHONE_VISION_TOKEN: VISION_TOKEN },
      windowsHide: true,
    });
    child.unref();
    logLine(`[phone-vision] 拉起服务 pid=${child.pid} port=${PORT}`);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await health()) { logLine('[phone-vision] 服务就绪'); return true; }
    }
    throw new Error('识别服务启动超时（看 vision/phone-vision.log）');
  })().finally(() => { serverStarting = null; });
  return serverStarting;
}

async function postJson(ep, body, timeoutMs = 30000) {
  await ensureVisionServer();
  const res = await fetch(BASE + ep, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vision-token': VISION_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return j;
}

function resolveTemplate({ name, path: p }) {
  const clean = String(name ?? '').replace(/[^\w\-一-龥]/g, '').slice(0, 40);
  if (p) {
    // [AUDIT-FIX] 模板只能在 templates 目录内；调用方给的绝对路径若越界一律拒绝，
    // 不再把任意路径转交给本地视觉服务去读。
    const abs = path.resolve(TEMPLATES_DIR, p);
    if (abs !== TEMPLATES_DIR && !abs.startsWith(TEMPLATES_DIR + path.sep)) return '';
    return abs;
  }
  if (!clean) return '';
  for (const ext of ['.png', '.jpg']) {
    const f = path.join(TEMPLATES_DIR, clean + ext);
    if (fs.existsSync(f)) return f;
  }
  return path.join(TEMPLATES_DIR, clean + '.png');
}

export function registerLocalVisionTools(server, deps) {
  const { z, text, fail, adbBuf, adb, ensureDevice, markDumpStale, SHOT_DIR } = deps;
  const tmpShot = async () => {
    await ensureDevice();
    // [SCREEN-GUARD] 先让屏幕醒着；黑帧重试一次；仍黑就抛明确原因，不把黑图当画面。
    const shellCmd = (cmd) => adb(['shell', cmd], { timeout: 8000 }).then((r) => r?.out ?? '');
    const take = () => adbBuf(['exec-out', 'screencap', '-p'], 30000).then((r) => (r.ok ? r.buf : null));
    await ensureAwake(shellCmd, (ms) => new Promise((res) => setTimeout(res, ms)));
    let shot = await grabWithLuma(take);
    if (!shot.buf) throw new Error('截图失败：adb 没返回画面');
    if (isBlackFrame(shot.stats)) {
      await wakeKey(shellCmd);
      await new Promise((res) => setTimeout(res, 800));
      shot = await grabWithLuma(take);
      if (!shot.buf) throw new Error('截图失败：adb 没返回画面');
      if (isBlackFrame(shot.stats)) throw new Error(blackFrameReason());
    }
    const dir = SHOT_DIR || path.join(VISION_DIR, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `vision-${Date.now()}.png`);
    fs.writeFileSync(file, shot.buf);
    return file;
  };

  server.tool(
    'phone_ocr',
    '把手机当前画面上的字读出来（本地 OCR，不联网、不花 token）。适合游戏里那种"dump 拿不到字"的画面：按钮名、数值、对话、任务提示都能读。可以只读一块区域（region）省时间；读完给每行字和它的坐标。',
    {
      region: z.object({
        x: z.number().int().min(0), y: z.number().int().min(0),
        w: z.number().int().min(1), h: z.number().int().min(1),
      }).optional().describe('只读这块区域（像素）；不填读全屏'),
      max: z.number().int().min(1).max(200).default(60).describe('最多返回多少行'),
    },
    async ({ region, max }) => {
      try {
        const shot = await tmpShot();
        const j = await postJson('/ocr', { path: shot, region: region || null });
        if (!j.ok) return fail(`识别失败：${j.error || '未知错误'}`);
        const items = (j.items || []).slice(0, max);
        if (!items.length) return text('这一屏没读到字（可能是纯图/纯画面，试试 phone_find_template 或 phone_look）。');
        const lines = items.map((it, i) => `${i}: "${it.text}" (${it.score}) @(${it.center.x},${it.center.y})`);
        const plain = items.map((it) => it.text).join(' ');
        return text(`读到 ${j.items.length} 行（${j.ms}ms）：\n${lines.join('\n')}\n\n整段：${plain.slice(0, 600)}`);
      } catch (e) {
        return fail(`OCR 失败：${e?.message ?? e}`);
      }
    }
  );

  server.tool(
    'phone_find_template',
    '在手机当前的画面里找一张图（模板匹配，毫秒级）。给模板名（用 phone_template_save 存过的）或图片路径；找到会给你中心坐标和分数，找不到会告诉你最高分——分数低就说明界面变了或模板不对。',
    {
      name: z.string().optional().describe('模板名（phone_template_save 存的名字）'),
      path: z.string().optional().describe('模板图片路径（绝对路径或相对 templates 目录）'),
      threshold: z.number().min(0).max(1).default(0.8).describe('分数门槛，默认 0.8；低于它算没找到'),
    },
    async ({ name, path: p, threshold }) => {
      try {
        const tpl = resolveTemplate({ name, path: p });
        if (!tpl || !fs.existsSync(tpl)) return fail(`没有这个模板：${name ?? p ?? '(没给)'}。先用 phone_template_save 存一张，或 phone_templates 看有哪些。`);
        const shot = await tmpShot();
        const j = await postJson('/find', { image: shot, template: tpl, threshold });
        if (!j.ok) return fail(`找图失败：${j.error || '未知错误'}`);
        if (j.hit) return text(`找到了「${path.basename(tpl)}」：分数 ${j.score}，中心 (${j.center.x},${j.center.y})，框 ${j.box.x1},${j.box.y1}-${j.box.x2},${j.box.y2}（${j.ms}ms）。可以直接 phone_tap 这个坐标，或 phone_tap_template 一步到位。`);
        return text(`没找到「${path.basename(tpl)}」：最高才 ${j.score}（门槛 ${threshold}），在 (${j.center.x},${j.center.y})。可能界面不对/模板过时；可以 phone_look 看一眼，或重新 phone_template_save。`);
      } catch (e) {
        return fail(`找图失败：${e?.message ?? e}`);
      }
    }
  );

  server.tool(
    'phone_tap_template',
    '找到那个按钮就直接点（找图 + 点击一步完成，比按坐标稳）。给模板名或路径；找不到就不点，并告诉你分数——不会乱点。',
    {
      name: z.string().optional().describe('模板名'),
      path: z.string().optional().describe('模板图片路径'),
      threshold: z.number().min(0).max(1).default(0.8).describe('分数门槛'),
      verify: z.boolean().default(true).describe('点完验证焦点有没有变（默认开）'),
    },
    async ({ name, path: p, threshold, verify }) => {
      try {
        const tpl = resolveTemplate({ name, path: p });
        if (!tpl || !fs.existsSync(tpl)) return fail(`没有这个模板：${name ?? p ?? '(没给)'}`);
        const shot = await tmpShot();
        const j = await postJson('/find', { image: shot, template: tpl, threshold });
        if (!j.ok) return fail(`找图失败：${j.error || '未知错误'}`);
        if (!j.hit) return text(`没找到「${path.basename(tpl)}」（最高 ${j.score}），这次没点。可以先 phone_look 看一眼再决定。`);
        markDumpStale?.();
        const focus = async () => {
          try {
            const out = await adb(['shell', 'dumpsys window 2>/dev/null | grep -m2 "mCurrentFocus\\|mFocusedApp"'], { timeout: 8000 });
            return String(out?.out ?? '').trim();
          } catch { return ''; }
        };
        const before = verify ? await focus() : '';
        await adb(['shell', 'input', 'tap', String(j.center.x), String(j.center.y)], { timeout: 15000 });
        let verified = '';
        if (verify) {
          await new Promise((r) => setTimeout(r, 600));
          const after = await focus();
          verified = before && after && before === after ? '（焦点没变，可能没点开/还在加载）' : '（画面有变化）';
        }
        return text(`点了「${path.basename(tpl)}」(${j.center.x},${j.center.y})，分数 ${j.score}${verified}`);
      } catch (e) {
        return fail(`点模板失败：${e?.message ?? e}`);
      }
    }
  );

  server.tool(
    'phone_template_save',
    '把一个按钮存成模板（她自己的按钮库）。可以直接说屏幕上的字（text=「开始行动」「点击画面以继续」），会自动按 OCR 找到那块字、裁下来存好——不需要算坐标；也可以给 x/y/w/h。存完就能 phone_tap_template("名字") 一键点它。note 写一句“这是什么”，下次看得懂。',
    {
      name: z.string().describe('模板名（字母数字下划线，比如 start_action）'),
      text: z.string().optional().describe('屏幕上那个按钮的文字：按 OCR 找到它并裁下来（推荐，不用算坐标）'),
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      w: z.number().int().min(1).optional(),
      h: z.number().int().min(1).optional(),
      note: z.string().optional().describe('备注：这按钮是干嘛的（比如“主界面开始行动”）'),
      pad: z.number().int().min(0).max(60).default(10).describe('按文字裁时四周留多少像素（默认 10）'),
    },
    async ({ name, text: label, x, y, w, h, note, pad }) => {
      try {
        const clean = String(name).replace(/[^\w\-]/g, '').slice(0, 40);
        if (!clean) return fail('模板名不合法');
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
        const shot = await tmpShot();
        let box = null;
        let source = 'manual';
        if (label && String(label).trim()) {
          const j = await postJson('/ocr', { path: shot });
          if (!j.ok) return fail(`按文字存模板失败：OCR 不可用（${j.error || '未知'}）。可以改用 x/y/w/h。`);
          const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
          const want = norm(label);
          const items = j.items || [];
          const hit = items.find((it) => norm(it.text) === want)
            || items.find((it) => norm(it.text).includes(want) || want.includes(norm(it.text)));
          if (!hit) return fail(`屏幕上没找到「${label}」。先 phone_ocr 看看现在屏上有哪些字，或者改用 x/y/w/h。`);
          const p = Math.max(0, Number(pad) || 0);
          box = { x: Math.max(0, hit.box.x1 - p), y: Math.max(0, hit.box.y1 - p), w: (hit.box.x2 - hit.box.x1) + p * 2, h: (hit.box.y2 - hit.box.y1) + p * 2 };
          source = 'ocr';
        } else if ([x, y, w, h].every((v) => Number.isFinite(Number(v)))) {
          box = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
        } else {
          return fail('要么给 text（屏幕上的字），要么给 x/y/w/h 四个坐标');
        }
        const out = path.join(TEMPLATES_DIR, clean + '.png');
        const j = await postJson('/crop', { image: shot, x: box.x, y: box.y, w: box.w, h: box.h, out });
        if (!j.ok) return fail(`保存失败：${j.error || '裁剪失败'}`);
        const idx = loadIndex();
        idx[clean] = { note: String(note || '').slice(0, 80), source, box, at: new Date().toISOString() };
        saveIndex(idx);
        return text(`存好了：${clean}（${j.w}×${j.h}，来源 ${source}${label ? `，按「${label}」定位` : ''}${note ? `，备注：${note}` : ''}）。下次 phone_tap_template("${clean}") 找它/点它。`);
      } catch (e) {
        return fail(`保存模板失败：${e?.message ?? e}`);
      }
    }
  );
  server.tool(
    'phone_templates',
    '看看存了哪些模板（她自己的按钮库）。',
    {},
    async () => {
      try {
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
        const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => /\.(png|jpg)$/i.test(f));
        if (!files.length) return text('还没有模板。用 phone_template_save 把常用按钮存下来。');
        const idx = loadIndex();
        return text(`有 ${files.length} 个模板：\n${files.map((f) => {
          const n = f.replace(/\.(png|jpg)$/i, '');
          const rec = idx[n] || {};
          return `- ${n}${rec.note ? `：${rec.note}` : ''}${rec.source ? `（${rec.source}）` : ''}`;
        }).join('\n')}`);
      } catch (e) {
        return fail(`列模板失败：${e?.message ?? e}`);
      }
    }
  );
}
