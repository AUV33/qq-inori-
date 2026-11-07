// inori-imagegen.js · 按需拉起的本地生图后端（stable-diffusion.cpp 的 sd-server）
//
// 为什么是「按需拉起」而不是常驻：
//   这台机器是 RTX 4060 Laptop（8GB 显存，但本地 llama-server 常占掉 5GB 左右）+
//   16GB 内存且已提交 29GB/31GB。生图模型一常驻，等于把剩下的显存和内存都吃掉，
//   她平时聊天、记忆检索（embedding/rerank 也要显存）就会开始排队。所以她只在
//   「真要一张图」的时候把它拉起来，画完闲 idleMs 就关掉，把资源还回去。
//
// 为什么是 sd.cpp 而不是 ComfyUI/A1111：
//   这台机器没有余量再养一套 Python 环境（ComfyUI 的依赖 + SDXL 的 6.9GB 权重，
//   在 1.5GB 可用内存 / 3GB 可用显存下根本装不下）。sd.cpp 是单个 exe + GGUF 量化模型
//   （Anything V3 q8_0 约 1.1GB），mmap 加载、显存占用小，并且自带 A1111 兼容的
//   /sdapi/v1/txt2img；冷启动几秒、出 512x768 图个位数秒。
//
// 这个模块只负责「进程生命周期 + 一次出图」，不碰聊天、不碰发送：
//   ensure()   拉起来并等它能应答（已在跑就直接返回）
//   generate() 出图，返回 PNG buffer
//   stop()     关掉（吃掉的显存/内存立刻还回去）
// 其余接线在 app.mjs（保存 + 发到 QQ）和 mcp-snowluma-safe.js（qq_image 工具）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const IMAGEGEN_DEFAULTS = {
  enabled: true,
  // 相对仓库根目录（或绝对路径）
  binPath: 'tools/sd-vulkan/sd-server.exe',
  modelPath: 'tools/sd-models/anything-v3-q8.gguf',
  host: '127.0.0.1',
  port: 8189,
  // SD1.5 的原生分辨率是 512，768 竖图更接近「一张画」，也更省显存
  width: 512,
  height: 768,
  steps: 24,
  cfgScale: 7,
  sampler: 'euler_a',
  // SD1.5 时代公认的负向词：不加就是六根手指、糊脸、签名水印
  negative: 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, artist name',
  timeoutMs: 240000,
  startupTimeoutMs: 180000,
  // 空闲多久关掉（毫秒）：默认 5 分钟——够她连着画两三张，又不会一直占着卡
  idleMs: 300000,
  // 可用物理内存低于这个数就不拉（宁可不画，也不把整机拖到交换区）
  minFreeMemMB: 700,
  maxPerHour: 12,
  pollMs: 700
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可用物理内存（MB）。Windows 上 os.freemem 就是 FreePhysicalMemory。 */
export function freeMemMB() {
  return Math.round(os.freemem() / (1024 * 1024));
}

/** 把「相对仓库根目录」的路径解析成绝对路径 */
function resolvePath(rootDir, p) {
  const v = String(p ?? '').trim();
  if (!v) return '';
  return path.isAbsolute(v) ? v : path.join(rootDir, v);
}

export function normalizePrompt(raw) {
  const prompt = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) return { ok: false, reason: 'prompt 是空的：写几个英文标签（例如 1girl, white dress, night sky）再出图。' };
  if (prompt.length > 1200) return { ok: false, reason: `prompt 太长（${prompt.length} 字）：标签留 15~30 个就够。` };
  if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(prompt)) {
    return {
      ok: false,
      reason: '这个模型只认英文 danbooru 标签，中文写进去只会出糊图。比如「雨里的女孩」→ '
        + '1girl, standing in rain, wet hair, city street, night, cinematic lighting。'
    };
  }
  return { ok: true, prompt };
}

/** 从 A1111 兼容响应的 info 里挖出这张图真正用的种子（拿不到就 null） */
export function parseActualSeed(data) {
  const raw = data?.info;
  if (!raw) return null;
  let info = raw;
  if (typeof raw === 'string') {
    try { info = JSON.parse(raw); } catch { return null; }
  }
  const fromList = Array.isArray(info?.all_seeds) ? Number(info.all_seeds[0]) : NaN;
  if (Number.isFinite(fromList) && fromList >= 0) return fromList;
  const gen = Array.isArray(info?.generation_info) ? info.generation_info[0] : null;
  const fromGen = Number(gen?.sample_params?.seed ?? gen?.seed);
  if (Number.isFinite(fromGen) && fromGen >= 0) return fromGen;
  return null;
}

/**
 * 建一个出图服务管理器。
 * @param {{rootDir: string, cfg: object, log?: Function}} opts
 */export function createImageGen({ rootDir, cfg = {}, log = () => {} } = {}) {
  const c = { ...IMAGEGEN_DEFAULTS, ...(cfg ?? {}) };
  const binPath = resolvePath(rootDir, c.binPath);
  const modelPath = resolvePath(rootDir, c.modelPath);
  const baseUrl = `http://${c.host}:${c.port}`;

  let child = null;
  let starting = null;      // 并发 ensure 共用同一个启动 Promise
  let idleTimer = null;
  let lastUsedAt = 0;
  let lastError = '';
  const genTimes = [];      // 出图时间戳，用于限流
  let chain = Promise.resolve(); // 串行队列：一次只跑一张，别把显存挤爆

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdle() {
    clearIdle();
    const idle = Math.max(1000, Number(c.idleMs) || IMAGEGEN_DEFAULTS.idleMs);
    idleTimer = setTimeout(() => {
      log(`[imagegen] 空闲 ${Math.round(idle / 1000)}s，关掉出图服务把显存还回去`);
      stop();
    }, idle);
    if (idleTimer.unref) idleTimer.unref();
  }

  function isRunning() {
    return Boolean(child && child.exitCode === null && !child.killed);
  }

  // [ORPHAN] Windows 上父进程退出不会带走子进程：桥接被强杀/重启后，sd-server 可能还挂在
  // 8189 上占着 1.7GB 显存。这种「不是我拉起来但在我端口上」的进程必须能收拾掉，
  // 否则下次 ensure() 会以为服务已经就绪（其实我们手上没有它的句柄，闲时也关不掉）。
  async function portOwnerPid() {
    try {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((resolve) => {
        execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          resolve(err ? '' : String(stdout ?? ''));
        });
      });
      const line = out.split(/\r?\n/).find((l) => l.includes(`:${c.port} `) && /LISTENING/i.test(l));
      const m = line ? line.trim().split(/\s+/).pop() : '';
      return /^\d+$/.test(m) ? Number(m) : null;
    } catch {
      return null;
    }
  }

  async function killOrphan() {
    const pid = await portOwnerPid();
    if (!pid) return false;
    log(`[imagegen] 端口 ${c.port} 上有残留的出图服务（pid=${pid}，多半是上次桥接被强杀留下的），先清掉`);
    try {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve());
      });
    } catch (error) { log(`[imagegen] 清理残留 pid=${pid} 失败（后面启动会报端口占用）: ${error?.message ?? error}`); }
    for (let i = 0; i < 10; i += 1) {
      await sleep(300);
      if (!(await portOwnerPid())) return true;
    }
    return false;
  }

  async function httpJson(pathname, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new Error(`HTTP ${res.status}：${String(text).slice(0, 300)}`);
    return data;
  }

  /** 等到服务能应答（sd-server 起来后要载模型，这一步最慢） */
  async function waitReady(deadline) {
    let lastErr = '';
    while (Date.now() < deadline) {
      if (!isRunning() && !starting) {
        // 进程已经退出（比如显存不够/OOM）：把 stderr 里最后一句话带出去
        throw new Error(`出图服务启动后立刻退出了：${lastError || '没有更多信息'}`);
      }
      try {
        await httpJson('/sdapi/v1/progress', { timeoutMs: 3000 });
        return true;
      } catch (error) {
        lastErr = error?.message ?? String(error);
        await sleep(c.pollMs);
      }
    }
    throw new Error(`出图服务 ${Math.round((c.startupTimeoutMs || 180000) / 1000)}s 内没起来：${lastErr || lastError || '超时'}`);
  }

  /** 拉起来（已在跑就直接用）。会先做内存体检——资源不够时宁可报错也不硬拉。 */
  async function ensure() {
    if (c.enabled === false) throw new Error('生图后端没开（imagegen.enabled=false）');
    if (isRunning()) { armIdle(); return { ok: true, reused: true, url: baseUrl }; }
    if (starting) return starting;
    if (!fs.existsSync(binPath)) throw new Error(`找不到 sd-server：${binPath}`);
    if (!fs.existsSync(modelPath)) throw new Error(`找不到出图模型：${modelPath}（先跑 tools/sd-models 的下载/转换）`);

    const free = freeMemMB();
    const need = Number(c.minFreeMemMB) || IMAGEGEN_DEFAULTS.minFreeMemMB;
    if (free < need) {
      throw new Error(`可用内存只剩 ${free}MB（门槛 ${need}MB），现在拉生图服务会把整机拖进交换区。等会儿再画，或者先把别的东西关掉。`);
    }

    starting = (async () => {
      lastError = '';
      // 上一次桥接被强杀可能留下一个还占着端口的 sd-server：先清掉再自己拉，
      // 不然我们拿到的是一个没有句柄、闲时也关不掉的服务。
      if (await portOwnerPid()) await killOrphan();
      const args = [
        '-m', modelPath,
        '--listen-ip', String(c.host),
        '--listen-port', String(c.port),
        // SD1.5 的 VAE 解码是显存尖峰所在，切块解码能省下一截
        '--vae-tiling',
        '--cfg-scale', String(c.cfgScale ?? 7),
        '--steps', String(c.steps ?? 24),
        '--log-level', 'warn'
      ];
      log(`[imagegen] 拉起 sd-server：${binPath}（可用内存 ${free}MB）`);
      const proc = spawn(binPath, args, {
        cwd: path.dirname(binPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child = proc;
      proc.stdout?.on('data', (buf) => { log(`[imagegen] ${String(buf).trim().slice(0, 300)}`); });
      proc.stderr?.on('data', (buf) => {
        const line = String(buf).trim();
        if (line) { lastError = line.slice(0, 400); log(`[imagegen:err] ${lastError}`); }
      });
      proc.on('exit', (code, signal) => {
        log(`[imagegen] sd-server 退出 code=${code} signal=${signal ?? ''}`);
        if (child === proc) child = null;
        clearIdle();
      });
      try {
        await waitReady(Date.now() + (Number(c.startupTimeoutMs) || IMAGEGEN_DEFAULTS.startupTimeoutMs));
        log('[imagegen] 出图服务就绪');
        armIdle();
        return { ok: true, reused: false, url: baseUrl };
      } catch (error) {
        stop();
        throw error;
      }
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /** 关掉服务（幂等） */
  function stop() {
    clearIdle();
    const proc = child;
    child = null;
    if (!proc) {
      // 没句柄也可能有残留（上次被强杀留下的）：顺手清一次，别让 1.7GB 显存一直占着
      void killOrphan();
      return { ok: true, stopped: false };
    }
    try {
      proc.kill();
    } catch (error) {
      log(`[imagegen] 关闭失败：${error?.message ?? error}`);
      void killOrphan();
    }
    // Windows 上 TerminateProcess 该进程即可（sd-server 不起子进程）
    log('[imagegen] 已请求关闭出图服务');
    return { ok: true, stopped: true };
  }

  function rateCheck() {
    const now = Date.now();
    while (genTimes.length && now - genTimes[0] > 3600000) genTimes.shift();
    const max = Number(c.maxPerHour) || IMAGEGEN_DEFAULTS.maxPerHour;
    if (genTimes.length >= max) {
      throw new Error(`这一小时已经出了 ${max} 张图，先歇会儿（限流 imagegen.maxPerHour）。`);
    }
  }

  /**
   * 出一张图。返回 { buffer, seed, width, height, steps, elapsedMs, cold }
   * 串行执行：同一时刻只跑一张，避免显存被两份模型挤爆。
   */
  async function generate(args = {}) {
    const run = async () => {
      const norm = normalizePrompt(args.prompt);
      if (!norm.ok) throw new Error(norm.reason);
      rateCheck();

      const cold = !isRunning();
      await ensure();

      const width = Math.max(64, Math.min(1024, Math.round((Number(args.width) || c.width) / 8) * 8));
      const height = Math.max(64, Math.min(1024, Math.round((Number(args.height) || c.height) / 8) * 8));
      const steps = Math.max(1, Math.min(60, Number(args.steps) || c.steps));
      const seed = Number.isFinite(Number(args.seed)) && Number(args.seed) >= 0 ? Math.floor(Number(args.seed)) : -1;
      const started = Date.now();
      const body = {
        prompt: norm.prompt,
        negative_prompt: String(args.negative || c.negative),
        width,
        height,
        steps,
        cfg_scale: Math.min(20, Math.max(1, Number(args.cfgScale) || c.cfgScale)),
        seed,
        sampler_name: String(args.sampler || c.sampler),
        batch_size: 1
      };
      let data;
      try {
        data = await httpJson('/sdapi/v1/txt2img', {
          method: 'POST',
          body,
          timeoutMs: Number(c.timeoutMs) || IMAGEGEN_DEFAULTS.timeoutMs
        });
      } catch (error) {
        throw new Error(`出图失败：${error?.message ?? error}`);
      }
      const b64 = Array.isArray(data?.images) ? data.images[0] : '';
      if (!b64) throw new Error('出图服务返回里没有图片数据');
      const buffer = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (!buffer.length) throw new Error('出图服务返回的图片是空的');
      genTimes.push(Date.now());
      lastUsedAt = Date.now();
      armIdle();
      return {
        buffer,
        // 随机种子时 parameters.seed 只是把 -1 原样回显；真实种子在 info（A1111 格式）里，
        // 不解析出来她就没法「再画一次同一张」。
        seed: seed >= 0 ? seed : parseActualSeed(data),
        width,
        height,
        steps,
        cold,
        elapsedMs: Date.now() - started
      };
    };
    // 串行排队：前一张没跑完，后一张等着
    const result = chain.then(run, run);
    chain = result.then(() => {}, () => {});
    return result;
  }

  /** 状态：给工具/控制台看「现在能不能画」 */
  async function status() {
    const running = isRunning();
    let healthy = false;
    let models = null;
    if (running) {
      try {
        const opts = await httpJson('/sdapi/v1/options', { timeoutMs: 3000 });
        healthy = true;
        models = opts?.sd_model_checkpoint ?? null;
      } catch { healthy = false; }
    }
    return {
      enabled: c.enabled !== false,
      running,
      healthy,
      url: baseUrl,
      binPath,
      modelPath,
      modelExists: fs.existsSync(modelPath),
      binExists: fs.existsSync(binPath),
      freeMemMB: freeMemMB(),
      minFreeMemMB: c.minFreeMemMB,
      loadedModel: models,
      idleMs: c.idleMs,
      lastUsedAt: lastUsedAt || null,
      generatedLastHour: genTimes.filter((t) => Date.now() - t < 3600000).length,
      maxPerHour: c.maxPerHour,
      lastError: lastError || null
    };
  }

  return { ensure, generate, stop, status, config: c, paths: { binPath, modelPath, baseUrl } };
}
