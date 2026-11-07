// 媒体获取与图片识别：本地文件白名单、OneBot 图片、人脸、媒体列表、vision 提问。
//
// 从 app.mjs 的 main() 搬出（P3-RW-49，2026-11-01）。所有网络/文件/视觉调用注入；
// 模块只做路径校验、mime 推断与串行下载。
import os from 'node:os';
import { execFile } from 'node:child_process';
import { extractGifFrames, isGifBuffer } from './gif-frames.js';
import { validateFetchUrl } from '../shared/safe-fetch.js';
import { seeVideo } from '../../../../ai-companion-kit/packages/shared/video-understanding.js';

// 单张图片像素上限（防"图片炸弹"解码拖垮 DSH）。
// [WIRING-FIX] 2026-11-03：原先只在工厂内声明，app.mjs 的 consoleDeps 却按同名 getter 暴露给
// console-server（上传校验要用），标识符在那边不存在 ⇒ 上传分支一读就 ReferenceError。提升到模块级并导出。
export const MAX_MEDIA_PIXELS = 64_000_000;
/**
 * @param {object} ctx
 */
export function createMediaService(ctx) {
  const {
    fs, path, log, cfg, getBot, vision, getImageDimensions,
    looksLikeImageBuffer, mimeFromBuffer, mimeFromUrl, safeFetchBuffer,
    MAX_MEDIA_BYTES = 4 * 1024 * 1024, // [WIRING-FIX] 由 app.mjs 单一来源注入
    MAX_MEDIA_STORE_PER_KEY = 500, // [WIRING-FIX] 同上：媒体元数据缓存上限
  } = ctx;
  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_IMAGE_PARTS = 5; // 一条 prompt 里最多几张图（动图抽帧也计入）

  function gifFramesOf(buffer) {
    if (!isGifBuffer(buffer)) return null;
    try {
      const info = extractGifFrames(buffer, { maxFrames: 3, maxDecodeFrames: 60, maxPixels: 8_000_000 });
      return info?.animated ? info : null;
    } catch { return null; }
  }

  function isAnimatedSticker(media) {
    return String(media?.subType ?? '') === '1' || /动画表情/.test(String(media?.summary ?? ''));
  }

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // [VIDEO] 视频本体抽帧。ffmpeg 是可选外部二进制（PHONE_FFMPEG / voice.ffmpegPath / PATH），
  // 没有就返回空数组，由调用方给出直链与看片指引；URL 先过 safe-fetch 校验再交给 ffmpeg。
  async function framesFromVideoFile(url, { count = 4 } = {}) {
    const src = String(url ?? '');
    if (!/^https?:\/\//i.test(src)) return [];
    try {
      await validateFetchUrl(src);
    } catch {
      return [];
    }
    const ffmpeg = process.env.PHONE_FFMPEG || cfg?.socialV2?.voice?.ffmpegPath || 'ffmpeg';
    let tmp = null;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-'));
      const pattern = path.join(tmp, 'f%02d.jpg');
      await new Promise((resolve, reject) => {
        execFile(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-i', src,
          '-vf', 'fps=1/5', '-frames:v', String(Math.max(1, Number(count) || 4)),
          '-q:v', '5', pattern,
        ], { timeout: 12_000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
      const files = fs.readdirSync(tmp).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
      const out = [];
      for (let i = 0; i < files.length; i += 1) {
        const buf = fs.readFileSync(path.join(tmp, files[i]));
        if (buf.length > 0 && buf.length <= MAX_MEDIA_BYTES) {
          out.push({ data: buf.toString('base64'), mimeType: 'image/jpeg', at: i * 5 });
        }
      }
      return out;
    } catch (error) {
      log?.(`视频抽帧失败：${error?.message ?? error}`);
      return [];
    } finally {
      if (tmp) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await getBot().getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await getBot().fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    let imageParts = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
          imageParts += 1;
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          const mimeType = img.mimeType || 'image/jpeg';
          // [GIF] 动图抽 2~3 帧一起递过去；vision 会标注“连续 N 帧，按顺序看变化”。
          // 抽不动/不是动图就退回单帧，并如实告诉模型“只看到第一帧”。
          const gif = gifFramesOf(img.buffer);
          const animatedLabel = isAnimatedSticker(media) ? '动画表情' : '动图';
          if (gif) {
            const room = Math.max(0, MAX_IMAGE_PARTS - imageParts);
            if (room >= 1) {
              const use = gif.frames.slice(0, room);
              parts.push({ type: 'text', text: `[图片${index}（${animatedLabel}，抽了 ${use.length} 帧看变化）]` });
              for (const f of use) {
                parts.push({ type: 'image', mediaType: 'image/png', data: f.png.toString('base64'), name: `qq-image-${index}-f${f.index + 1}.png` });
                imageParts += 1;
              }
            } else {
              parts.push({ type: 'text', text: `[图片${index}（${animatedLabel}，本条图片数量已达上限，未展开帧）]` });
            }
          } else {
            const label = mimeType === 'image/gif' ? `（${animatedLabel}，只读取第一帧）` : '';
            parts.push({ type: 'text', text: `[图片${index}${label}]` });
            parts.push({ type: 'image', mediaType: mimeType, data: img.buffer.toString('base64'), name: `qq-image-${index}.${(mimeType || 'image/jpeg').split('/')[1]}` });
            imageParts += 1;
          }
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
        // [VIDEO] 封面只是第一眼；视频本体从这里真正进入她的画面。
        if (media.kind === 'video-thumb' && (media.videoUrl || media.videoFile)) {
          const room = Math.max(0, MAX_IMAGE_PARTS - imageParts);
          const frames = room > 0
            ? await seeVideo(media.videoUrl, {
              framesFromVideo: framesFromVideoFile,
              maxFrames: Math.min(room, cfg?.video?.fullUnderstand ? 12 : 4),
            })
            : [];
          if (frames.length) {
            parts.push({
              type: 'text',
              text: `[视频本体：抽了 ${frames.length} 帧，按时间顺序看变化${cfg?.video?.fullUnderstand ? '；这是全片抽帧，请按每帧的时刻把内容串起来' : ''}]`,
            });
            for (const f of frames) {
              const size = Buffer.from(f.data, 'base64').length;
              if (totalBytes + size > MAX_MEDIA_BYTES) break;
              totalBytes += size;
              parts.push({ type: 'image', mediaType: f.mimeType || 'image/jpeg', data: f.data, name: `qq-video-${index}-${f.at ?? 0}.jpg` });
              imageParts += 1;
            }
          } else {
            parts.push({
              type: 'text',
              text: `[视频本体：${media.videoUrl || media.videoFile}（时长 ${media.duration ?? '?'} 秒）。这段没抽到帧——${media.videoUrl ? '用 mcp__phone__video_frames 传这个直链看画面' : '网关只给了缓存文件名，没有可抽帧的直链，需要本地媒体目录或让网关补 URL'}；别只当它是一张封面。${cfg?.video?.fullUnderstand ? '全片理解已开：请逐段看完再形成想法。' : ''}]`,
            });
          }
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += img.buffer.length;
          const mimeType = img.mimeType || 'image/jpeg';
          const gif = gifFramesOf(img.buffer);
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType,
            // data 保留原始字节（表情自动收藏要按原图算 md5 / 发原图），帧另放 frames。
            data: img.buffer.toString('base64'),
            animated: !!gif,
            frameCount: gif?.frameCount,
            totalDurationMs: gif?.totalDurationMs,
            frames: gif ? gif.frames.map((f) => ({ mimeType: 'image/png', data: f.png.toString('base64'), index: f.index, delayMs: f.delayMs })) : undefined,
            text: gif ? `动图，抽了 ${gif.frames.length} 帧` : ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  // 内部看图：与 /api/console/vision 同一条链路（独立 vision 会话 + 事件订阅 + 超时兜底）
  async function visionAsk(images, question, mimeType = 'image/png', timeoutMs = 90000) {
    let sendImages = images;
    let sendMime = mimeType;
    try {
      if (Array.isArray(images) && images.length === 1) {
        // 只先看前 8 个 base64 字符判断是不是 GIF，避免给每张 PNG/JPEG 都解一遍大 buffer。
        const head = Buffer.from(String(images[0]).slice(0, 8), 'base64');
        if (head.length >= 6 && head.toString('ascii', 0, 3) === 'GIF') {
          const gif = gifFramesOf(Buffer.from(String(images[0]), 'base64'));
          if (gif) {
            sendImages = gif.frames.map((f) => f.png.toString('base64'));
            sendMime = 'image/png';
          }
        }
      }
    } catch (error) { /* 抽帧失败就按单帧问 */ globalThis.__ignoredCatch?.(error, 'media-service.mjs:313'); }
    return vision.ask(sendImages, question, { mimeType: sendMime, timeoutMs });
  }


  return {
    base64FromMaybe, isSafeLocalMediaPath, isProbablySafeImageFileRef,
    fetchOneBotImage, fetchFaceMedia, resolveMediaList, fetchMediaData, visionAsk,
  };
}
