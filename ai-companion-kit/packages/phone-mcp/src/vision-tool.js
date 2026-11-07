// vision-tool.js · phone_look：把手机画面直接给模型看（她的模型支持图片输入）
//
// 2026-10-26 改造（用户问「手机画面接收/操作/图片识别」）：
//   旧做法：截图 → 外部视觉 API 转述成文字 → 返回文字（她一帧画面都没真正"看到"，
//   只能读转述，细节丢失；还要多一次外部请求）。
//   新做法：截图 → 把**画面本身**作为 MCP image 内容返回（DSH 会把它作为图片投进她的上下文，
//   她能直接读屏上的字/看 UI；实测 deepseek-flash 目录声明 inputModalities text+image）。
//   文字转述保留为按需：question 或 describe=true 时才额外调视觉 API（省 token/时间）。
//   [LOOK-DEDUP] 仍只对"文字转述"生效（同屏同问 90s 内复用）。
//
// 历史说明（保留）：DSH 0.1.x 的 MCP 客户端不处理图片内容，当时只能转述成文字；
// 当前 DSH 已支持 MCP image 内容（attachment 准入会校验模型是否声明 image 输入）。
// 截图缩放：1080x2400 原图约 4.4MB，2x 降采样后约 1.4MB（视觉与文字识别一致）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { scalePng } from './png-scale.js';
// [SCREEN-GUARD] 熄屏时 screencap 是黑的：截屏前先唤醒、黑帧重试一次、仍黑就明说（2026-10-29）
import { ensureAwake, wakeKey, grabWithLuma, isBlackFrame, blackFrameReason } from './screen-guard.js';
import { toolsPath } from '../../shared/inori-paths.mjs';

const ADB = process.env.PHONE_ADB || toolsPath('platform-tools', 'adb.exe');
const KEY = process.env.PHONE_VISION_KEY || '';
const MODEL = process.env.PHONE_VISION_MODEL || 'deepseek-flash';
const MAX_TOKENS = Number(process.env.PHONE_VISION_MAX_TOKENS) || 2000;
const MAX_FRAMES = 5;

function adbRun(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? ''), message: err?.message ?? '' });
    });
  });
}

// [LOOK-FAST] exec-out 直取 PNG 字节：不落盘、不 pull，一次往返（实测省约 180ms/次）
function adbRunBuf(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
      resolve({ ok: !err && buf.length > 0, buf, message: err?.message ?? '' });
    });
  });
}

// [PNG-SIZE] 从 PNG 头读真实像素尺寸。为什么不用 `wm size`：游戏横屏时 screencap 出的是
// 2400x1080，而 wm size 报竖屏 1080x2400——用后者换算会把坐标转错（2026-10-28 明日方舟实机踩到）。
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function captureOne(tag) {
  // [SCREEN-GUARD] 熄屏/锁屏时 screencap 返回全黑图：先唤醒，截一张，黑帧就按电源键重试一次；
  // 仍黑就返回明确原因（而不是把黑图当画面递给她——2026-10-29 00:21 实机踩到）。
  const shellCmd = (cmd) => adbRun(['shell', cmd], 8000).then((r) => r.out);
  const take = () => adbRunBuf(['exec-out', 'screencap', '-p'], 30000).then((r) => (r.ok ? r.buf : null));
  await ensureAwake(shellCmd, (ms) => new Promise((r) => setTimeout(r, ms)));
  let shot = await grabWithLuma(take);
  if (!shot.buf) return { ok: false, reason: '截图失败：adb 没返回画面' };
  if (isBlackFrame(shot.stats)) {
    await wakeKey(shellCmd);
    await new Promise((r) => setTimeout(r, 800));
    shot = await grabWithLuma(take);
    if (!shot.buf) return { ok: false, reason: '截图失败：adb 没返回画面' };
    if (isBlackFrame(shot.stats)) return { ok: false, reason: blackFrameReason() };
  }
  const raw = shot.buf;
  const dim = pngSize(raw) || {};
  // [PNG-SCALE] 1080x2400 原图约 4.4MB；2x 降采样后约 1.3MB（30%），视觉与文字识别一致。
  const scaled = scalePng(raw, 2);
  const b64 = scaled.toString('base64');
  if (scaled.length < raw.length) {
    console.error(`[phone_look] 截图压缩 ${raw.length}B → ${scaled.length}B（${Math.round(scaled.length / raw.length * 100)}%）`);
  }
  return { ok: true, b64, size: raw.length, scaledSize: scaled.length, w: dim.w, h: dim.h };
}

async function describeImages(images, question) {
  const content = [{ type: 'text', text: question }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img.b64}` } });
  }
  const t0 = Date.now();
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  const text = j?.choices?.[0]?.message?.content ?? '';
  return { status: res.status, text: String(text), ms: Date.now() - t0, finish: j?.choices?.[0]?.finish_reason, usage: j?.usage };
}

// [TAP-DESC] 视觉定位点击：UI 树读不到的界面（Unity 游戏/网页）用这个，别再凭感觉猜坐标。
async function screenSize() {
  const r = await adbRun(['shell', 'wm', 'size'], 10000);
  const m = /(\d+)\s*x\s*(\d+)/.exec(r.out);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

function parseFoundJson(text) {
  const s = String(text || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function registerVisionTool(server, { z, reply, fail, markDumpStale }) {
  // [LOOK-DEDUP] 同屏同问不重复烧视觉调用（一次转述 ≈ 3-7s + 2K tokens）：
  // 90s 内、画面哈希相同、问题相同 → 直接回上次的结论 + 提示。
  const lastLook = { hash: '', q: '', at: 0, text: '' };
  server.tool(
    'phone_look',
    '看手机屏幕：截屏后把画面本身递给你（你能直接看到界面、读屏上的字、看在放什么）。可以连拍几帧看变化（看视频/动画用 3 帧）。★要精确点击某个控件别用图估坐标——先 phone_dump 拿「可点元素清单」的精确中心坐标再 phone_tap；图用来看懂画面、确认结果。如果只想要一句文字描述（不想看原图），传 question 或 describe=true。',
    {
      question: z.string().optional().describe('可选：让视觉模型用文字回答这个问题（会多花一次视觉调用）'),
      describe: z.boolean().optional().describe('可选：true = 额外要一句文字转述（默认 false，只看原图）'),
      frames: z.number().optional().describe('连拍几帧，1~5，默认 1；看视频/动画时用 3 帧'),
      intervalMs: z.number().optional().describe('帧间隔毫秒，默认 2000'),
    },
    async ({ question, describe, frames, intervalMs }) => {
      const wantDescribe = !!describe || !!String(question ?? '').trim();
      const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(frames) || 1)));
      const gap = Math.max(500, Math.min(10000, Number(intervalMs) || 2000));
      const q = String(question ?? '').trim() ||
        (n > 1 ? '这是一段手机屏幕的连续截图，请描述画面里在发生什么：界面是什么、有没有视频在播放、出现了哪些文字。' :
          '描述这张手机截图：现在是什么界面？上面有哪些文字？');

      const images = [];
      for (let i = 0; i < n; i++) {
        const shot = await captureOne(String(i));
        if (!shot.ok) return fail(shot.reason);
        images.push(shot);
        if (i < n - 1) await new Promise((r) => setTimeout(r, gap));
      }

      // [LOOK-VISION] 直接给画面：她的模型支持图片输入（deepseek-flash 目录声明 text+image），
      // 原图进上下文能读字、看 UI、判断在放什么——比"视觉模型转述成文字"准得多，也省一次外部调用。
      const content = [{
        type: 'text',
        text: `（手机当前画面${n > 1 ? `：连续 ${n} 帧，按顺序看变化` : ''}。图上文字以画面为准；要精确点某个控件请先 phone_dump 拿坐标再 phone_tap。）`,
      }];
      for (const shot of images) content.push({ type: 'image', data: shot.b64, mimeType: 'image/png' });

      // 只在明确要文字转述时才走视觉模型（默认不烧）
      if (wantDescribe) {
        if (!KEY) {
          content.push({ type: 'text', text: '（没配置 PHONE_VISION_KEY，文字转述不可用；上面的原图仍然可以看。）' });
          return { content };
        }
        // [LOOK-DEDUP] 单帧 + 同屏同问 → 用缓存，不重烧视觉
        if (n === 1) {
          const sig = crypto.createHash('sha1').update(images[0].b64.slice(0, 4000)).digest('hex').slice(0, 16);
          if (sig === lastLook.hash && q === lastLook.q && Date.now() - lastLook.at < 90000 && lastLook.text) {
            content.push({ type: 'text', text: `${lastLook.text}\n（和 ${Math.round((Date.now() - lastLook.at) / 1000)} 秒前那次一样：画面没变，别再重看。要看变化就等它动一下，或换 phone_dump。）` });
            return { content };
          }
        }
        try {
          const out = await describeImages(images, q);
          if (out.status !== 200) {
            content.push({ type: 'text', text: `（文字转述失败：视觉模型返回 ${out.status}；上面的原图仍然可以看。）` });
            return { content };
          }
          if (out.finish === 'length' && !out.text) {
            content.push({ type: 'text', text: '（视觉模型把 token 烧在推理上了；上面的原图仍然可以看，需要转述就调大 PHONE_VISION_MAX_TOKENS。）' });
            return { content };
          }
          const meta = `（${n} 帧，${out.ms}ms，api_prompt=${out.usage?.prompt_tokens ?? '?'}tok）`;
          if (n === 1) {
            const sig = crypto.createHash('sha1').update(images[0].b64.slice(0, 4000)).digest('hex').slice(0, 16);
            lastLook.hash = sig; lastLook.q = q; lastLook.at = Date.now(); lastLook.text = out.text.trim();
          }
          content.push({ type: 'text', text: `${out.text.trim()}${meta}` });
        } catch (e) {
          content.push({ type: 'text', text: `（文字转述失败：${e?.message ?? e}；上面的原图仍然可以看。）` });
        }
      }
      return { content };
    }
  );

  // [TAP-DESC] 按描述点：截图 → 视觉模型给归一化坐标 → 换算像素 → input tap。
  // 2026-10-28 实机：她在明日方舟登录页点 (1200,1024)，按钮其实在 (1200,784)——Unity 没有 UI 树，
  // phone_dump 只有一条 Game view、phone_tap_text 找不到元素，只能猜；这个工具就是补这条盲操作的缺。
  server.tool(
    'phone_tap_desc',
    '按描述点屏幕上的东西：给一句目标（如「开始唤醒按钮」），视觉模型看截图返回坐标再点。UI 树读不到的界面（Unity 游戏/网页/视频）用它，比凭感觉猜坐标稳。点完建议 phone_look 确认；没反应就把描述写具体再调一次。',
    {
      description: z.string().describe('要找的目标，一句话，尽量具体（按钮上的字、大概位置、颜色）'),
    },
    async ({ description }) => {
      if (!KEY) return fail('没配置 PHONE_VISION_KEY，视觉定位不可用；先 phone_dump / phone_look 兜底。');
      const shot = await captureOne('tapdesc');
      if (!shot.ok) return fail(shot.reason);
      // 用截图自身的像素尺寸（横屏游戏时与 wm size 不一致）；拿不到才退回 wm size。
      const size = (shot.w && shot.h) ? { w: shot.w, h: shot.h } : ((await screenSize()) || { w: 1080, h: 2400 });
      const prompt = [
        '你是手机屏幕坐标定位器。只输出一行 JSON，不要推理、不要解释。',
        `目标：${String(description)}`,
        '给出目标的矩形框：x1,y1 左上、x2,y2 右下，均为 0~1000 的整数（按整张截图归一化）。',
        '如果目标上有文字，就框**文字本身**（不要框按钮外框/背景条）——文字中心通常最准。',
        '输出格式：{"found":true,"box":[0,0,0,0],"reason":"12字内说明你看到的是什么"}',
        '找不到就输出：{"found":false,"reason":"为什么找不到"}',
      ].join('\n');
      let out;
      try {
        out = await describeImages([shot], prompt);
      } catch (e) {
        return fail(`视觉定位失败：${e?.message ?? e}`);
      }
      if (out.status !== 200) return fail(`视觉定位失败：HTTP ${out.status}`);
      const j = parseFoundJson(out.text);
      if (!j || j.found !== true) {
        const why = j?.reason ? `（${String(j.reason).slice(0, 40)}）` : '';
        return fail(`画面里没找到「${description}」${why}。先用 phone_look 看一眼现在是什么界面，换个更具体的说法再试。`);
      }
      // 优先用矩形框中心（实测单点会压在按钮边缘）；没有框再退回 x,y 单点。
      let nx;
      let ny;
      if (Array.isArray(j.box) && j.box.length === 4 && j.box.every((v) => Number.isFinite(Number(v)))) {
        const [x1, y1, x2, y2] = j.box.map(Number);
        nx = (x1 + x2) / 2;
        ny = (y1 + y2) / 2;
      } else {
        nx = Number(j.x);
        ny = Number(j.y);
      }
      if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1000 || ny < 0 || ny > 1000) {
        return fail(`视觉返回的坐标不可用：${JSON.stringify(j).slice(0, 120)}`);
      }
      const x = Math.round((nx / 1000) * size.w);
      const y = Math.round((ny / 1000) * size.h);
      const tap = await adbRun(['shell', 'input', 'tap', String(x), String(y)], 15000);
      if (!tap.ok) return fail(`点击失败：${tap.message || tap.err}`);
      try { markDumpStale?.(); } catch { /* 失效缓存失败不影响点击 */ }
      return reply(`已点击「${description}」@(${x},${y})（视觉坐标 ${nx},${ny}/1000，屏幕 ${size.w}x${size.h}）。点完用 phone_look 确认；如果没反应，把描述写得更具体再调一次。`);
    }
  );
}
