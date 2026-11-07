// video-understanding.js · 眼睛
//
// 只做一件事：把视频变成她能看见的画面。
// 输入「帧」（URL / 本地路径 / 已解码字节），输出 [{data, mimeType, at}]；看不见就是空数组。
//
// 不负责：总结、字幕、弹幕、记忆、来源追踪、诚实度审计、parts 编码、看多久、看几段。
// 不联网、不读文件、不读全局：取图与 MIME 判断由调用方注入。
// 边界：QQ 视频封面与 phone-mcp 抽帧本来就已经是画面，不需要再经过这里。
// 测试入口：qq-bridge/test/test-video-understanding.test.mjs

/** 帧 → 画面。at 是这一帧在视频里的秒数，没有就 null。 */
export function toEyes(frames) {
  const arr = Array.isArray(frames) ? frames : (frames == null ? [] : [frames]);
  return arr.map((f, i) => {
    const raw = typeof f === 'string' ? { url: f } : (f && typeof f === 'object' ? f : {});
    const at = raw.at != null && Number.isFinite(Number(raw.at)) ? Number(raw.at) : null;
    return {
      url: String(raw.url ?? raw.path ?? ''),
      data: raw.data ?? null,
      mimeType: String(raw.mimeType ?? 'image/jpeg'),
      at,
      index: i,
    };
  }).filter((e) => e.url || e.data);
}

/** 看某一刻：多张拼图按 coverage 均分挑对应那张；单张或没时刻就整组给。 */
export function lookAt(frames, atSec, { coverage } = {}) {
  const eyes = toEyes(frames);
  const cover = Number(coverage) || 0;
  if (eyes.length <= 1 || atSec == null || cover <= 0) return eyes;
  const per = cover / eyes.length;
  const i = Math.max(0, Math.min(eyes.length - 1, Math.floor(Number(atSec) / per)));
  return [eyes[i]];
}

/** 把视频本体变成画面。取帧执行器由调用方注入；没有或失败就是没看见。 */
export async function seeVideo(source, deps = {}) {
  const { framesFromVideo, maxFrames = 4 } = deps ?? {};
  if (typeof framesFromVideo !== 'function' || !source) return [];
  try {
    return await see(await framesFromVideo(source, { count: maxFrames }), deps);
  } catch {
    return [];
  }
}

/** 把帧变成能进上下文的图片字节。看不见就少一张，空数组即「没看见」。 */
export async function see(frames, deps = {}) {
  const { fetchImage, imageMime, limit = 4 } = deps ?? {};
  const out = [];
  for (const eye of toEyes(frames).slice(0, Math.max(0, Number(limit) || 0))) {
    if (eye.data) {
      out.push({ data: eye.data, mimeType: eye.mimeType, at: eye.at });
      continue;
    }
    if (typeof fetchImage !== 'function' || !eye.url) continue;
    try {
      const r = await fetchImage(eye.url, 3 * 1024 * 1024);
      const buf = r?.buffer ?? r;
      if (buf?.length) out.push({
        data: buf.toString('base64'),
        mimeType: imageMime ? imageMime(buf) : eye.mimeType,
        at: eye.at,
      });
    } catch { /* 空数组就是没看见，不需要额外状态 */ }
  }
  return out;
}
