// watch-video.js · 看视频并总结（B站 API 快路径 + 画面层兜底）
//
// 综合两种主流做法：
//   ① API 派（bilichat 类）：标题/UP/简介/字幕/弹幕 → 文字总结，2-5 秒，不下载视频
//   ② 抽帧/多模态派：没字幕时用关键帧拼图（B站 videoshot 接口，免 ffmpeg）或让她用手机看画面
//
// 返回结构化文本：她拿这些文字自己组织总结；画面层给出预览帧 URL 供她在需要时看图。
// 设计原则：拿不到的不硬编——没字幕就明说只拿到标题/简介/弹幕。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BILI_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://www.bilibili.com/',
};

// [SSRF] 统一走 safe-fetch：禁止内网/环回/链路本地/带凭据 URL，并逐跳重校验重定向。
// 原实现 genericMeta 直接 fetch(url)，等于给聊天里任意 URL 开了一条只读 SSRF 通道。
// 网络层可被测试注入（与项目其它模块"注入 safeFetch"的约定一致），生产默认用真实 safe-fetch。
import { safeFetch as realSafeFetch, validateFetchUrl as realValidateFetchUrl } from '../shared/safe-fetch.js';
const REAL_NET = Object.freeze({ safeFetch: realSafeFetch, validateFetchUrl: realValidateFetchUrl });
function net() {
  const injected = globalThis.__WATCH_VIDEO_NET__;
  return injected && typeof injected === 'object' ? injected : REAL_NET;
}

async function fetchJson(url, headers = BILI_HEADERS, timeoutMs = 12000) {
  // 即使是硬编码域名，也做一次目标校验（防 API 回传的 URL 被污染/被首跳劫持）。
  await net().validateFetchUrl(url);
  // 禁止跟随重定向：否则"首跳校验通过、重定向到内网"可绕过上面的目标校验。
  const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** 从 B站链接里提取 bvid 或 aid */
function parseBilibili(url) {
  const m = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/.exec(url);
  if (m) return { bvid: m[1] };
  const a = /bilibili\.com\/video\/av(\d+)/i.exec(url);
  if (a) return { aid: a[1] };
  const s = /b23\.tv\/([0-9A-Za-z]+)/.exec(url);
  if (s) return { short: s[1] };
  return null;
}

// [BILI-COMMENTS] B站搜索/热评：参照 dsh-aurabot-qq（MIT）的 WBI 签名与接口路径。
// 只读：搜索、看热评。发评论/回评论要登录 Cookie（SESSDATA/bili_jct），本仓库没配，不碰。
import { createHash } from 'node:crypto';
const WBI_MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiCache = null;
export function wbiSign(params, imgKey, subKey, now = Date.now()) {
  const raw = imgKey + subKey;
  const mixin = WBI_MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.round(now / 1000) };
  const query = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return query + '&w_rid=' + createHash('md5').update(query + mixin).digest('hex');
}
async function biliWbi() {
  if (wbiCache && Date.now() - wbiCache.at < 6 * 3600_000) return wbiCache;
  const j = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const key = (u) => String(u || "").split("/").pop().split(".")[0];
  const img = key(j?.data?.wbi_img?.img_url);
  const sub = key(j?.data?.wbi_img?.sub_url);
  if (!img || !sub) throw new Error("拿不到 B 站 WBI 签名 key");
  wbiCache = { img, sub, at: Date.now() };
  return wbiCache;
}
/** 搜索视频：keyword 必填；返回 [{bvid,aid,title,owner,play,pubdate,duration,desc}] */
export async function biliSearch(keyword, { page = 1, limit = 8 } = {}) {
  const kw = String(keyword ?? "").trim();
  if (!kw) throw new Error("要搜什么？给个关键词");
  const w = await biliWbi();
  const q = wbiSign({ search_type: 'video', keyword: kw, page }, w.img, w.sub);
  const j = await fetchJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${q}`);
  if (j.code !== 0) throw new Error(`B站搜索接口 ${j.code}: ${j.message}`);
  return (j.data?.result ?? []).filter((v) => v && v.bvid).slice(0, limit).map((v) => ({
    bvid: v.bvid, aid: v.aid, title: String(v.title || "").replace(/<[^>]+>/g, ""), owner: v.author,
    play: Number(v.play) || 0, view: Number(v.play) || 0, danmaku: 0,
    pubdate: (v.pubdate || 0) * 1000, duration: v.duration,
    desc: String(v.description || "").replace(/<[^>]+>/g, "").slice(0, 200),
    pic: String(v.pic || '').startsWith('//') ? `https:${v.pic}` : String(v.pic || ''),
    tags: Array.isArray(v.tag) ? v.tag.map((t) => String(t || '')).filter(Boolean).slice(0, 8) : [],
  }));
}
/** 热评：ref 可以是 bvid 字符串或 info 对象（需要 aid）。返回 [{name,text,like,replies}] */
export async function biliComments(ref, { limit = 8 } = {}) {
  let aid = ref && typeof ref === "object" ? Number(ref.aid) || 0 : 0;
  if (!aid) {
    const info = ref && typeof ref === "object" ? ref : await biliInfo({ bvid: String(ref).trim() });
    aid = Number(info?.aid) || 0;
  }
  if (!aid) return [];
  const w = await biliWbi();
  const q = wbiSign({ type: 1, oid: aid, mode: 3, plat: 1, web_location: 1315875 }, w.img, w.sub);
  const j = await fetchJson(`https://api.bilibili.com/x/v2/reply/wbi/main?${q}`);
  if (j.code !== 0) return [];
  return (j.data?.replies ?? []).slice(0, limit).map((r) => ({
    name: r.member?.uname, mid: r.mid, like: r.like, replies: r.rcount || 0,
    text: String(r.content?.message || "").replace(/\s+/g, " ").slice(0, 200),
  }));
}

/** ① 视频基本信息 */
async function biliInfo(ref) {
  const q = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
  const j = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${q}`);
  if (j.code !== 0) throw new Error(`B站接口 ${j.code}: ${j.message}`);
  const d = j.data;
  return {
    bvid: d.bvid, aid: d.aid, title: d.title, owner: d.owner?.name, desc: d.desc,
    duration: d.duration, view: d.stat?.view, danmaku: d.stat?.danmaku,
    cover: d.pic, cid: d.pages?.[0]?.cid ?? d.cid, pages: (d.pages ?? []).map((p) => p.part).slice(0, 8),
  };
}

/** ② 字幕：优先接口（无 cookie 常拿不到），失败返回空。
 *  返回里带 timed（带时间戳的行）——感知循环按 30s 窗口切字幕用。 */
async function biliSubtitle(info) {
  try {
    const j = await fetchJson(`https://api.bilibili.com/x/player/v2?bvid=${info.bvid}&cid=${info.cid}`);
    if (j.code !== 0) return null;
    const sub = j.data?.subtitle;
    const list = sub?.subtitles ?? [];
    if (!list.length) return null;
    // 取第一条有 url 的字幕（通常是中文）
    const pick = list.find((s) => s.url) ?? null;
    if (!pick) return null;
    const body = await fetchJson(pick.url.startsWith('//') ? 'https:' + pick.url : pick.url);
    const raw = (body?.body ?? []).filter((b) => b?.content);
    if (!raw.length) return null;
    const timed = raw.map((b) => ({ t: Math.max(0, Math.floor(Number(b.from) || 0)), text: String(b.content) }));
    return { lang: pick.lan, text: timed.map((l) => l.text).join('\n'), count: timed.length, timed };
  } catch {
    return null;
  }
}

/** ③b 弹幕带时间戳（感知循环的"反应层"：t 秒时人们在说什么、多大声） */
export async function biliDanmakuTimed(info, limit = 1000) {
  try {
    const { body: xml } = await net().safeFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${info.cid}`, 4_000_000);
    const out = [];
    for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
      const t = Math.floor(Number((m[1].split(',') ?? [])[0]) || 0);
      const text = m[2];
      if (!Number.isFinite(t) || !text?.trim()) continue;
      out.push({ t, text: text.trim() });
      if (out.length >= limit) break;
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** 弹幕情绪峰值（纯函数）：30s 分箱，找"哪 30 秒炸了、炸的是什么"。
 *  重复即共识——同句出现 n 次就是观众的情绪强度计量。 */
export function danmakuPeaks(timed, durationSec, { binSec = 30, topBins = 8, minBinTotal = 4, topPhrases = 5 } = {}) {
  if (!Array.isArray(timed) || !timed.length) return null;
  // 脏时间（NaN/非数字）会算出 NaN 分箱并污染峰值排序；作为公共纯函数先过滤，再分箱。
  const rows = timed.filter((d) => d && Number.isFinite(Number(d.t)) && typeof d.text === 'string' && d.text.trim());
  if (!rows.length) return null;
  const dur = Math.max(durationSec || 0, ...rows.map((d) => Number(d.t))) + 1;
  const bins = new Map(); // binStart -> Map(phrase -> n)
  const global = new Map();
  for (const d of rows) {
    const b = Math.floor(Number(d.t) / binSec) * binSec;
    if (!bins.has(b)) bins.set(b, new Map());
    const ph = bins.get(b);
    ph.set(d.text, (ph.get(d.text) || 0) + 1);
    global.set(d.text, (global.get(d.text) || 0) + 1);
  }
  // 只留"词"——纯符号/单字符（？、。、-）不算反应
  const usable = (p) => p.length >= 2 && /[\u4e00-\u9fa5a-zA-Z0-9]/.test(p);
  const peaks = [...bins.entries()]
    .map(([b, ph]) => {
      const top = [...ph.entries()].filter(([p]) => usable(p)).sort((a, c) => c[1] - a[1])[0];
      return { t: b, phrase: top?.[0] ?? '', n: top?.[1] ?? 0, total: [...ph.values()].reduce((a, c) => a + c, 0) };
    })
    .filter((p) => p.total >= minBinTotal && p.phrase)
    .sort((a, c) => c.total - a.total)
    .slice(0, topBins);
  const phrases = [...global.entries()].filter(([p]) => usable(p)).sort((a, c) => c[1] - a[1]).slice(0, topPhrases)
    .map(([phrase, n]) => ({ phrase, n }));
  return { peaks: peaks.length ? peaks : null, phrases, binsUsed: Math.ceil(dur / binSec), timedCount: timed.length };
}

/** ③ 弹幕采样：XML 接口，取高频短句 */
async function biliDanmaku(info, limit = 40) {
  try {
    const { body: xml } = await net().safeFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${info.cid}`, 4_000_000);
    const texts = [...xml.matchAll(/<d[^>]*>([^<]*)<\/d>/g)].map((m) => m[1]).filter(Boolean);
    if (!texts.length) return null;
    // 去重后取前 limit 条（弹幕按时间顺序，前面的一般是开场关注点）
    const seen = new Set();
    const picked = [];
    for (const t of texts) {
      const k = t.trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      picked.push(k);
      if (picked.length >= limit) break;
    }
    return { total: texts.length, sample: picked };
  } catch {
    return null;
  }
}

/** ④ 关键帧拼图（B站 videoshot，免 ffmpeg 的"抽帧"替代）。
 *  新格式：一张 10×10 拼图长条（5s 间隔的缩略图）+ idx 时间线（秒）；拼图覆盖 0~coverage。
 *  旧格式：idx 为空——image 列表就是预览帧（无时刻）。消费方按 idx 有无走两条路。 */
async function biliFrames(info) {
  try {
    const j = await fetchJson(`https://api.bilibili.com/x/player/videoshot?bvid=${info.bvid}&index=1`);
    if (j.code !== 0) return null;
    const d = j.data;
    if (!d?.image?.length) return null;
    const norm = (u) => (u.startsWith('//') ? 'https:' + u : u);
    const idx = Array.isArray(d.index) ? d.index.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0) : null;
    return {
      index: d.index?.length ?? 0,
      idx: idx?.length ? idx : null,
      coverage: idx?.length ? Math.max(...idx) : null, // 拼图覆盖到第几秒（拿不到更多段就到这里）
      images: d.image.slice(0, 6).map(norm),
      imagesAll: d.image.map(norm),
    };
  } catch {
    return null;
  }
}

/** ⑤ 候选池数据源：B站热门榜（免 cookie）。热榜只负责"摆出来"，选哪条是她的权力。 */
export async function biliTrending(count = 12, pn = 1) {
  const j = await fetchJson(`https://api.bilibili.com/x/web-interface/popular?ps=${Math.min(50, count)}&pn=${pn}`);
  if (j.code !== 0) throw new Error(`B站热榜接口 ${j.code}: ${j.message}`);
  return (j.data?.list ?? []).slice(0, count).map((v) => ({
    bvid: v.bvid, title: v.title, owner: v.owner?.name,
    duration: v.duration, view: v.stat?.view, danmaku: v.stat?.danmaku,
    cid: v.cid, pic: v.pic?.startsWith('//') ? 'https:' + v.pic : v.pic,
    desc: (v.desc || '').slice(0, 120), tags: (v.tag ?? []).map((t) => t?.name).filter(Boolean).slice(0, 8),
  }));
}

/** ⑥ 一次取齐"感知循环"要的全部上下文（open 时缓存进会话，之后每个 look 都从缓存切窗口）。
 *  ctx = { info, subtitle(timed), peaks, topPhrases, frames, timedDanmakuCount } */
export async function openWatchContext(bvidOrUrl) {
  const u = String(bvidOrUrl ?? '').trim();
  const ref = parseBilibili(u) ?? (u.startsWith('BV') ? { bvid: u } : null);
  if (!ref) throw new Error('需要一个 B站链接或 BV 号');
  let info;
  if (ref.short) {
    const r = await net().safeFetch(`https://b23.tv/${ref.short}`, 2000);
    const parsed = parseBilibili(r.url || '');
    if (!parsed?.bvid) throw new Error('短链解析失败');
    info = await biliInfo(parsed);
  } else {
    info = await biliInfo(ref);
  }
  const [subtitle, timedDanmaku, frames] = await Promise.all([
    biliSubtitle(info), biliDanmakuTimed(info), biliFrames(info),
  ]);
  const peaks = danmakuPeaks(timedDanmaku, info.duration);
  return {
    info, subtitle: subtitle ?? null,
    peaks: peaks?.peaks ?? null, topPhrases: peaks?.phrases ?? null,
    timedDanmakuCount: peaks?.timedCount ?? 0,
    frames: frames ? { idx: frames.idx, coverage: frames.coverage, images: frames.images, imagesAll: frames.imagesAll } : null,
  };
}

/** 窗口视图（纯函数）：切 [fromSec, toSec) 这 30 秒——说了什么 / 弹幕炸在哪 / 看哪几张帧。
 *  这是"人一样接收"的 look 步：不是一次全片摘要，而是此刻 30 秒。 */
export function windowView(ctx, fromSec, toSec) {
  const d = Number(ctx?.info?.duration) || 0;
  const from = Math.max(0, Math.min(fromSec, d));
  const to = Math.min(d, toSec);
  // 字幕：窗口内的行（前后各留 2s 容差，人不是逐字看的）
  const subs = (ctx.subtitle?.timed ?? [])
    .filter((l) => l.t >= from - 2 && l.t < to)
    .slice(0, 40)
    .map((l) => `${l.t}s ${l.text}`);
  // 弹幕峰值：落进这个窗口的
  const wins = (ctx.peaks ?? []).filter((p) => p.t < to && p.t + 30 > from).slice(0, 4);
  // 帧：新格式=一张 10×10 拼图长条（idx 时间线），窗口在覆盖内就把拼图附上；
  // 旧格式（无 idx）= 前几张预览帧。拿不到的不硬编——明说覆盖到哪。
  let frames = [];
  let framesNote = '';
  const f = ctx.frames;
  if (f?.idx?.length && f.imagesAll?.length) {
    const covered = f.idx.some((s) => s >= from - 5 && s < to);
    if (covered) {
      frames = f.imagesAll.slice(0, 1); // 拼图本身（5s 间隔的缩略图网格）
      framesNote = `（拼图长条：5 秒一格的缩略图，覆盖 0:00–${Math.floor(f.coverage / 60)}:${String(f.coverage % 60).padStart(2, '0')}，找这一段对应的格子看。）`;
    } else if (from < f.coverage) {
      frames = f.imagesAll.slice(0, 1);
      framesNote = '（这一段拼图里大概在这张图的某个格子，参考上一段。）';
    } else {
      framesNote = `（画面层只覆盖到 ${Math.floor(f.coverage / 60)}:${String(f.coverage % 60).padStart(2, '0')}，这一段没有帧——B站接口给多少算多少。）`;
    }
  } else if (f?.imagesAll?.length) {
    frames = f.imagesAll.slice(0, 3);
    framesNote = '（关键帧预览图，无时刻对应。）';
  } else {
    framesNote = '（这段没拿到画面——B站 storyboard 没返回。画面层空白，别把没看到说成看到了。）';
  }
  return {
    from, to, subs,
    danmakuMoments: wins.map((p) => ({ t: p.t, phrase: p.phrase, n: p.n, total: p.total })),
    frames,
    framesNote,
    remaining: Math.max(0, d - to),
  };
}

/** 通用网页（非 B站）：抓元信息 */
async function genericMeta(url) {
  try {
    const res = await net().safeFetch(url, 200_000);
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const html = res.body;
    const pick = (re) => (re.exec(html)?.[1] ?? '').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
    return {
      title: pick(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || pick(/<title>([^<]+)<\/title>/i),
      desc: pick(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]+)"/i),
      site: pick(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i),
    };
  } catch { return null; }
}

/**
 * 主入口：返回 { ok, layers: {api, subtitle, danmaku, frames}, text }
 */
export async function watchVideo(url) {
  const u = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '需要一个 http(s) 链接' };

  const ref = parseBilibili(u);
  if (ref) {
    try {
      // 短链先解析
      let info;
      if (ref.short) {
        const r = await net().safeFetch(`https://b23.tv/${ref.short}`, 2000);
        const real = r.url || '';
        const parsed = parseBilibili(real);
        if (!parsed?.bvid) throw new Error('短链解析失败');
        info = await biliInfo(parsed);
      } else {
        info = await biliInfo(ref);
      }
      const [subtitle, danmaku, frames, comments] = await Promise.all([
        biliSubtitle(info), biliDanmaku(info), biliFrames(info), biliComments(info, { limit: 6 }).catch(() => []),
      ]);
      const mm = Math.floor((info.duration ?? 0) / 60);
      const ss = String((info.duration ?? 0) % 60).padStart(2, '0');
      const lines = [
        `【B站视频】${info.title}`,
        `UP主：${info.owner}　时长：${mm}:${ss}　播放：${info.view ?? '-'}　弹幕：${info.danmaku ?? '-'}`,
        info.pages?.length > 1 ? `分P：${info.pages.join(' / ')}` : '',
        `简介：${(info.desc || '（无）').slice(0, 800)}`,
        subtitle ? `\n【字幕 ${subtitle.lang}（${subtitle.count} 行）】\n${subtitle.text.slice(0, 6000)}`
          : '\n【字幕】拿不到（无字幕或需要登录 cookie）',
        danmaku ? `\n【弹幕采样 ${danmaku.sample.length}/${danmaku.total} 条】\n${danmaku.sample.join(' / ')}` : '',
        comments.length ? `\n【热评 ${comments.length} 条（别人的说法）】\n${comments.map((c) => `- ${c.name}：${c.text}${c.like ? `（${c.like} 赞）` : ''}`).join('\n')}` : '',
        frames ? `\n【关键帧】${frames.images.length} 张预览图（B站 storyboard）——★字幕和画面都要看：字幕告诉你说了什么，关键帧告诉你画面是什么样（场景/演示/人物/特效）。` : '\n【关键帧】拿不到',
        subtitle
          ? '\n（有字幕不等于知道画面。总结时把字幕内容和关键帧画面结合起来说。）'
          : '\n（没有字幕：文字层只能靠简介+弹幕推断，别把推断说成"我看了视频"。）',
      ].filter(Boolean);
      return {
        ok: true, platform: 'bilibili',
        layers: { api: { title: info.title, owner: info.owner, duration: info.duration, cid: info.cid }, subtitle: !!subtitle, danmaku: !!danmaku, frames: !!frames, comments: comments.length },
        // [FRAMES] 关键帧图片地址单独带出去，供 MCP 层下载成 image content 进她的上下文
        frameImages: frames?.images ?? [],
        text: lines.join('\n'),
      };
    } catch (error) {
      return { ok: false, error: `B站解析失败：${error?.message ?? error}` };
    }
  }

  // 非 B站：通用网页元信息
  const meta = await genericMeta(u);
  if (!meta) return { ok: false, error: '抓不到这个页面（可能需要登录/被墙/不是网页）' };
  return {
    ok: true, platform: 'other',
    layers: { api: true, subtitle: false, danmaku: false, frames: false },
    text: [
      `【网页】${meta.title || '(无标题)'}`,
      meta.site ? `站点：${meta.site}` : '',
      `描述：${meta.desc || '（无）'}`,
      '（非 B站链接：只拿到页面元信息。要总结视频内容，可以让她用手机打开看画面，或换个能拿到字幕的来源。）',
    ].filter(Boolean).join('\n'),
  };
}
