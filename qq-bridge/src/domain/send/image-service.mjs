// 生图服务（qq_image）。
//
// 从 app.mjs 的 main() 搬出（P3-RW-3，2026-10-31）：按需拉起生图后端、落盘、发到会话。
// 与 phone_sketch「她自己画」是两条路；纪律：后端没起来/内存不够如实报错，不编「画好了」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksLikeImageBuffer } from '../shared/safe-fetch.js';

const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * @param {object} ctx
 * @param {object} ctx.cfg
 * @param {(key:string)=>Function|null} ctx.captureSendGuard
 * @param {()=>object} ctx.getOutgoing
 * @param {(ms:number)=>Promise<void>} ctx.sleep
 * @param {(min:number,max:number)=>number} ctx.randInt
 * @param {Function} ctx.fetch
 * @param {(action:string,res:object,body:object)=>string} ctx.oneBotError
 * @param {object} ctx.imagegen
 * @param {()=>number} ctx.freeMemMB
 * @param {(...parts:string[])=>string} ctx.projectPath
 * @param {(...parts:string[])=>string} ctx.stateDataPath
 */
export function createImageService({
  cfg,
  captureSendGuard,
  getOutgoing,
  sleep,
  randInt,
  fetch,
  oneBotError,
  imagegen,
  freeMemMB,
  projectPath,
  stateDataPath,
}) {
  function imagePaths() {
    return {
      outDir: projectPath('media', 'pics'),
      logFile: stateDataPath('imagegen.jsonl')
    };
  }

  /** 允许发本地图的目录：只给项目媒体区、图库、工坊和系统图片目录，别的一律拒绝。 */
  function allowedImageRoots() {
    return [
      projectPath('media'),
      projectPath('data', 'pics'),
      projectPath('data', 'workshop'),
      path.join(os.homedir(), 'Pictures'),
    ];
  }

  /**
   * 解析“要发的本地图片”：白名单目录 + 真身校验 + 大小/格式检查。
   * 只接受本地路径（不接受 URL/base64），防止被 prompt injection 拿去读任意文件。
   */
  function resolveLocalImageFile(file) {
    const raw = String(file ?? '').trim();
    if (!raw) throw new Error('file 不能为空');
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error('只接受本地文件路径（不支持 URL/base64）');
    const abs = path.isAbsolute(raw) ? raw : path.resolve(projectPath(), raw);
    let real;
    try { real = fs.realpathSync(abs); } catch { throw new Error(`文件不存在：${raw}`); }
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error('不是文件');
    if (st.size <= 0) throw new Error('文件是空的');
    if (st.size > MAX_LOCAL_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_LOCAL_IMAGE_BYTES / 1024 / 1024)}MB`);
    let inside = false;
    for (const root of allowedImageRoots()) {
      let realRoot;
      try { realRoot = fs.realpathSync(root); } catch { continue; }
      if (real === realRoot || real.startsWith(realRoot + path.sep)) { inside = true; break; }
    }
    if (!inside) throw new Error('只能发送 media/、data/pics/、data/workshop/、~/Pictures 里的图片');
    const buffer = fs.readFileSync(real);
    if (!looksLikeImageBuffer(buffer)) throw new Error('不是可识别的图片（PNG/JPEG/GIF/WebP）');
    return { absPath: real, name: path.basename(real), bytes: buffer.length, buffer };
  }

  /** 发一张本地图片（GIF 由 QQ 客户端播放动画）。 */
  async function sendImageFileV2(key, file, options = {}) {
    const local = resolveLocalImageFile(file);
    const sent = await sendImageV2(key, local.buffer, options);
    return { messageId: sent?.messageId ?? null, name: local.name, bytes: local.bytes };
  }

  /** 发一张图片（图片段与文字不能同一条消息，配文让她自己再发） */
  async function sendImageV2(key, buffer, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    if (!buffer || !buffer.length) throw new Error('图片是空的，没东西可发');
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (options.atUserId !== undefined && options.atUserId !== null && String(options.atUserId).trim() !== '') {
      const at = String(options.atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => { sendResolve = resolve; sendReject = reject; });
    getOutgoing().enqueue(async () => {
      try {
        // 出图后真人也会顿一下再发，别让图和上一条文字严丝合缝像程序拼的
        await sleep(randInt(600, 1600));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error(oneBotError(action, res, body));
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    return { messageId: data?.message_id ?? null };
  }

  /** 出一张图并存档（args 见 inori-imagegen.generate）。返回 { path, absPath, seed, elapsedMs, cold, sent, messageId } */
  async function imageForV2(key, args = {}) {
    const { outDir, logFile } = imagePaths();
    const started = Date.now();
    let gen;
    try {
      gen = await imagegen.generate({
        prompt: args.prompt,
        negative: args.negative,
        width: args.width,
        height: args.height,
        steps: args.steps,
        cfgScale: args.cfgScale,
        seed: args.seed
      });
    } catch (error) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, JSON.stringify({
          ts: started, ok: false, key, prompt: String(args.prompt ?? '').slice(0, 400), error: String(error?.message ?? error).slice(0, 300)
        }) + '\n');
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'image-service.mjs:2687'); }
      throw error;
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const dir = path.join(outDir, `${y}-${m}-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const slug = String(args.prompt ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2)
      .join('-').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 24) || 'image';
    let name = `${stamp}_${slug}.png`;
    let abs = path.join(dir, name);
    let n = 2;
    // [ATOMIC-CREATE] existsSync + write 是 TOCTOU：同一秒并发/杀毒延迟都可能让两个写入选中同名。
    // wx 独占创建才是权威判定；EEXIST 才换下一个后缀。
    for (;;) {
      try { fs.writeFileSync(abs, gen.buffer, { flag: 'wx' }); break; } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        name = `${stamp}_${slug}_${n++}.png`;
        abs = path.join(dir, name);
      }
    }
    const rel = path.relative(projectPath(), abs).split(path.sep).join('/');

    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({
        ts: Date.now(), ok: true, key, path: rel, prompt: String(args.prompt ?? '').slice(0, 400),
        seed: gen.seed, width: gen.width, height: gen.height, steps: gen.steps,
        elapsedMs: gen.elapsedMs, cold: gen.cold
      }) + '\n');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'image-service.mjs:2714'); }

    let sent = null;
    if (args.send !== false) {
      try {
        sent = await sendImageV2(key, gen.buffer, { replyToMessageId: args.replyToMessageId, atUserId: args.atUserId });
      } catch (error) {
        throw new Error(`图出好了（${rel}）但发不出去：${error?.message ?? error}`);
      }
    }
    return {
      path: rel,
      absPath: abs,
      seed: gen.seed,
      width: gen.width,
      height: gen.height,
      steps: gen.steps,
      elapsedMs: gen.elapsedMs,
      cold: gen.cold,
      sent: Boolean(sent),
      messageId: sent?.messageId ?? null
    };
  }

  /** 生图后端状态（不动手，只说实话） */
  async function imageStatusV2() {
    const st = await imagegen.status();
    return { ...st, freeMemMB: freeMemMB() };
  }

  /** 手动关掉生图后端（控制台/她自己都能收） */
  function imageStopV2() {
    return imagegen.stop();
  }

  // 更新本地 AI 认知（含义/标签/用法）。

  return { imagePaths, sendImageV2, sendImageFileV2, resolveLocalImageFile, imageForV2, imageStatusV2, imageStopV2 };
}
