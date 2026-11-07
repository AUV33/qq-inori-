// watch-video 金标：WBI 签名 / 弹幕分箱峰值 / 30 秒窗口视图（纯函数）
// + B站接口的解析映射与失败回退（全部注入 fetch 桩，绝不发真实网络请求）。
//
// 模块内 wbiCache 是模块级状态：联网用例各自 import 一个带 query 的全新模块实例，
// 避免用例之间互相喂缓存，也让"nav 只取一次"这类断言可确定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wbiSign, danmakuPeaks, windowView } from '../src/domain/memory/watch-video.js';

// ───────────────────────── 桩 ─────────────────────────

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const textRes = (text, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
  json: async () => JSON.parse(text),
});
const httpError = (status) => ({
  ok: false,
  status,
  json: async () => { throw new Error('no json'); },
  text: async () => 'err',
});

function installFetch(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  const originalNet = globalThis.__WATCH_VIDEO_NET__;
  const matchRoute = (u) => {
    for (const [pattern, handler] of routes) {
      const hit = pattern instanceof RegExp ? pattern.test(u) : u.includes(pattern);
      if (hit) return { handler };
    }
    return null;
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    const hit = matchRoute(u);
    if (hit) return typeof hit.handler === 'function' ? hit.handler(u, opts) : hit.handler;
    throw new Error(`未预期的网络请求：${u}`);
  };
  // safe-fetch 走 node http、不走全局 fetch；用同一组路由桩注入网络层，保证测试零真实网络/零 DNS。
  globalThis.__WATCH_VIDEO_NET__ = {
    validateFetchUrl: async (u) => ({ url: String(u), ip: '203.0.113.10' }),
    safeFetch: async (url, maxChars = 50000) => {
      const u = String(url);
      calls.push({ url: u, opts: { signal: AbortSignal.timeout(15000), maxChars } });
      const hit = matchRoute(u);
      if (!hit) throw new Error(`未预期的网络请求：${u}`);
      const res = typeof hit.handler === 'function' ? hit.handler(u, {}) : hit.handler;
      if (res && typeof res.text === 'function') {
        const body = await res.text();
        return { url: u, statusCode: res.status ?? 200, truncated: false, body };
      }
      return res; // 短链桩：直接给 { url }
    },
  };
  t.after(() => {
    globalThis.fetch = original;
    if (originalNet === undefined) delete globalThis.__WATCH_VIDEO_NET__;
    else globalThis.__WATCH_VIDEO_NET__ = originalNet;
  });
  return calls;
}

let freshSeq = 0;
const freshModule = () => import(`../src/domain/memory/watch-video.js?fresh=${++freshSeq}`);

const WBI_IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const WBI_SUB = 'https://i0.hdslb.com/bfs/wbi/493c17ff3b214577b8628852f1a1de42.png';
const navRoute = [[/\/x\/web-interface\/nav/, jsonRes({ code: 0, data: { wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } })]];
const viewRoute = (data = {}) => [/\/x\/web-interface\/view/, jsonRes({ code: 0, data })];
const dmRoute = (xml) => [/\/x\/v1\/dm\/list\.so/, textRes(xml)];
const shotRoute = (data) => [/\/x\/player\/videoshot/, jsonRes({ code: 0, data })];
const playerRoute = (subtitles = []) => [/\/x\/player\/v2/, jsonRes({ code: 0, data: { subtitle: { subtitles } } })];
const replyRoute = (body) => [/\/x\/v2\/reply\/wbi\/main/, jsonRes(body)];
const searchRoute = (body) => [/\/x\/web-interface\/wbi\/search\/type/, jsonRes(body)];

const infoData = (over = {}) => ({
  bvid: 'BV1xx411c7mD', aid: 12345, title: '标题', owner: { name: 'UP' }, desc: '简介',
  duration: 65, stat: { view: 1000, danmaku: 25 }, pic: '//i0/x.jpg', cid: 999,
  pages: [{ cid: 999, part: 'P1' }, { cid: 998, part: 'P2' }],
  ...over,
});

// ───────────────────────── wbiSign（纯函数）─────────────────────────

test('wbiSign：固定 key/时间下是可回归的金标签名', () => {
  const q = wbiSign({ search_type: 'video', keyword: '测试', page: 1 },
    '7cd084941338484aae1ad9425b84077c', '493c17ff3b214577b8628852f1a1de42', 1700000000000);
  assert.equal(q, 'keyword=%E6%B5%8B%E8%AF%95&page=1&search_type=video&wts=1700000000&w_rid=c50886eb1f9d792e8bbee0e044a94cb7');

  const q2 = wbiSign({ type: 1, oid: 12345, mode: 3, plat: 1, web_location: 1315875 },
    '7cd084941338484aae1ad9425b84077c', '493c17ff3b214577b8628852f1a1de42', 1700000000000);
  assert.equal(q2, 'mode=3&oid=12345&plat=1&type=1&web_location=1315875&wts=1700000000&w_rid=1242694fbe9e80bb74783c8a518f0b5e');
});

test('wbiSign：参数顺序无关（按 key 排序），wts 由 now 四舍五入到秒', () => {
  const a = wbiSign({ b: 2, a: 1 }, 'x'.repeat(64), 'y'.repeat(64), 1700000000400);
  const b = wbiSign({ a: 1, b: 2 }, 'x'.repeat(64), 'y'.repeat(64), 1700000000400);
  assert.equal(a, b);
  assert.ok(a.includes('a=1&b=2&wts=1700000000'));

  const half = wbiSign({ a: 1 }, 'x'.repeat(64), 'y'.repeat(64), 1700000000500);
  assert.ok(half.includes('wts=1700000001'), 'Math.round 进位');
});

test('wbiSign：值里的 !\'()* 被剔除，空格/中文按 URI 编码，数字转字符串', () => {
  const q = wbiSign({ keyword: "a!'()*b", page: 1 }, 'x'.repeat(64), 'y'.repeat(64), 1700000000123);
  // 独立用 md5(query + 'x'*32) 校验过：query = keyword=ab&page=1&wts=1700000000
  assert.equal(q, 'keyword=ab&page=1&wts=1700000000&w_rid=749c697876bbcab89ed8c10bc661f16d');

  const spaced = wbiSign({ keyword: 'a b' }, 'x'.repeat(64), 'y'.repeat(64), 1700000000000);
  assert.ok(spaced.startsWith('keyword=a%20b&wts='));
  assert.match(spaced, /&w_rid=[0-9a-f]{32}$/);
});

test('wbiSign：不同参数/不同时间得到不同 w_rid', () => {
  const k = (params, now) => wbiSign(params, 'k'.repeat(64), 's'.repeat(64), now);
  assert.notEqual(k({ a: 1 }, 1700000000000), k({ a: 2 }, 1700000000000));
  assert.notEqual(k({ a: 1 }, 1700000000000), k({ a: 1 }, 1700000001000));
});

// ───────────────────────── danmakuPeaks（纯函数）─────────────────────────

test('danmakuPeaks：空/非数组返回 null', () => {
  assert.equal(danmakuPeaks([], 60), null);
  assert.equal(danmakuPeaks(null, 60), null);
  assert.equal(danmakuPeaks(undefined, 60), null);
  assert.equal(danmakuPeaks('x', 60), null);
});

test('danmakuPeaks：30 秒分箱，峰值取箱内最高频词，总量不足的箱丢掉', () => {
  const timed = [
    { t: 0, text: '哈哈' }, { t: 1, text: '哈哈' }, { t: 2, text: '哈' },
    { t: 30, text: '笑死' }, { t: 31, text: '笑死' }, { t: 32, text: '笑死' }, { t: 33, text: '笑死' },
    { t: 60, text: '？' }, { t: 61, text: '？' }, { t: 62, text: '？' }, { t: 63, text: '？' }, { t: 64, text: '？' },
  ];
  const r = danmakuPeaks(timed, 100);
  assert.deepEqual(r.peaks, [{ t: 30, phrase: '笑死', n: 4, total: 4 }],
    'bin0 只有 3 条 < minBinTotal；bin60 全是纯符号，不算“词”');
  assert.deepEqual(r.phrases, [{ phrase: '笑死', n: 4 }, { phrase: '哈哈', n: 2 }], '单字/纯符号不进词表');
  assert.equal(r.timedCount, 12);
  assert.equal(r.binsUsed, Math.ceil((Math.max(100, 64) + 1) / 30));
});

test('danmakuPeaks：binSec / minBinTotal / topBins / topPhrases 可控', () => {
  const timed = [];
  for (let b = 0; b < 6; b += 1) {
    for (let i = 0; i < 4; i += 1) timed.push({ t: b * 10 + i, text: `词${b}` });
  }
  const r = danmakuPeaks(timed, 60, { binSec: 10, minBinTotal: 4, topBins: 3, topPhrases: 2 });
  assert.equal(r.peaks.length, 3);
  assert.deepEqual(r.peaks.map((p) => p.t), [0, 10, 20], '总量相同保持分箱顺序');
  assert.equal(r.phrases.length, 2);
  assert.deepEqual(r.phrases.map((p) => p.phrase), ['词0', '词1']);
  assert.equal(r.binsUsed, 7, 'dur = max(60, 59)+1 = 61 → ceil(61/10)=7');

  const loose = danmakuPeaks([{ t: 0, text: '来了' }, { t: 1, text: '来了' }], 30, { minBinTotal: 2 });
  assert.deepEqual(loose.peaks, [{ t: 0, phrase: '来了', n: 2, total: 2 }]);
});

test('danmakuPeaks：t 在分箱边界上时归到后一箱；duration 缺失/偏小用最大 t 兜底', () => {
  const r = danmakuPeaks([
    { t: 29, text: '前面' }, { t: 30, text: '后面' }, { t: 30, text: '后面' }, { t: 30, text: '后面' }, { t: 30, text: '后面' },
  ], 0);
  assert.equal(r.peaks[0].t, 30, '30 秒归到 [30,60) 这一箱');
  assert.equal(r.peaks[0].n, 4);
  assert.equal(r.binsUsed, 2, 'dur = max(0, 30)+1 = 31 → 2 箱');
});

// ───────────────────────── windowView（纯函数）─────────────────────────

const windowCtx = (over = {}) => ({
  info: { duration: 120 },
  subtitle: { timed: [
    { t: 8, text: '前两秒容差内' }, { t: 9, text: '九' }, { t: 12, text: '十二' },
    { t: 25, text: '二十五' }, { t: 30, text: '三十' },
  ] },
  peaks: [
    { t: 0, phrase: '开场', n: 4, total: 9 },
    { t: 5, phrase: '跨窗', n: 2, total: 5 },
    { t: 20, phrase: '边界后', n: 1, total: 4 },
    { t: 25, phrase: '窗内', n: 1, total: 3 },
    { t: 26, phrase: '多余', n: 1, total: 3 },
  ],
  frames: null,
  ...over,
});

test('windowView：切 [from,to)，字幕带前后 2 秒容差，remaining 是剩余秒数', () => {
  const v = windowView(windowCtx(), 10, 20);
  assert.equal(v.from, 10);
  assert.equal(v.to, 20);
  assert.deepEqual(v.subs, ['8s 前两秒容差内', '9s 九', '12s 十二']);
  assert.deepEqual(v.danmakuMoments.map((p) => p.phrase), ['开场', '跨窗'], '只留与窗口重叠的峰值，最多 4 个');
  assert.equal(v.remaining, 100);
  assert.deepEqual(v.frames, []);
  assert.ok(v.framesNote.includes('这段没拿到画面'));
});

test('windowView：越界参数被夹回 [0, duration]，倒序窗口不产出内容', () => {
  const v = windowView(windowCtx(), -10, 999);
  assert.equal(v.from, 0);
  assert.equal(v.to, 120);
  assert.equal(v.remaining, 0);
  assert.equal(v.subs.length, 5, '全片窗口');

  const reversed = windowView(windowCtx(), 50, 40);
  assert.equal(reversed.from, 50);
  assert.equal(reversed.to, 40);
  assert.deepEqual(reversed.subs, []);
  assert.equal(reversed.remaining, 80);
});

test('windowView：字幕最多 40 行、弹幕峰值最多 4 个', () => {
  const timed = Array.from({ length: 60 }, (_, i) => ({ t: i, text: `第${i}句` }));
  const peaks = Array.from({ length: 10 }, (_, i) => ({ t: i, phrase: `p${i}`, n: 1, total: 9 }));
  const v = windowView(windowCtx({ subtitle: { timed }, peaks }), 0, 120);
  assert.equal(v.subs.length, 40);
  assert.equal(v.danmakuMoments.length, 4);
});

test('windowView：新格式拼图——窗口在覆盖内附整条拼图并说明覆盖范围', () => {
  const v = windowView(windowCtx({
    frames: { idx: [0, 5, 10], coverage: 10, imagesAll: ['u0', 'u1', 'u2'], images: ['u0'] },
  }), 0, 20);
  assert.deepEqual(v.frames, ['u0']);
  assert.ok(v.framesNote.includes('拼图长条'));
  assert.ok(v.framesNote.includes('覆盖 0:00–0:10'));
});

test('windowView：新格式拼图——窗口落在覆盖前但无 idx 命中 → 参考上一段', () => {
  const v = windowView(windowCtx({
    frames: { idx: [0, 5, 60], coverage: 60, imagesAll: ['u0', 'u1'], images: ['u0'] },
  }), 20, 30);
  assert.deepEqual(v.frames, ['u0']);
  assert.ok(v.framesNote.includes('参考上一段'));
});

test('windowView：超出拼图覆盖 → 明说只到哪，不硬编画面', () => {
  const v = windowView(windowCtx({
    frames: { idx: [0, 5], coverage: 65, imagesAll: ['u0', 'u1'], images: ['u0'] },
  }), 100, 130);
  assert.deepEqual(v.frames, []);
  assert.ok(v.framesNote.includes('只覆盖到 1:05'));
  assert.ok(v.framesNote.includes('B站接口给多少算多少'));
});

test('windowView：旧格式（无 idx）给 3 张预览帧并说明没有时刻', () => {
  const v = windowView(windowCtx({
    frames: { idx: null, coverage: null, imagesAll: ['a', 'b', 'c', 'd'], images: ['a'] },
  }), 0, 30);
  assert.deepEqual(v.frames, ['a', 'b', 'c']);
  assert.ok(v.framesNote.includes('关键帧预览图，无时刻对应'));
});

test('windowView：ctx 缺字段不炸（duration 缺失/没有 subtitle/peaks）', () => {
  const v = windowView({}, 0, 30);
  assert.equal(v.from, 0);
  assert.equal(v.to, 0);
  assert.deepEqual(v.subs, []);
  assert.deepEqual(v.danmakuMoments, []);
  assert.equal(v.remaining, 0);
});

// ───────────────────────── biliSearch ─────────────────────────

test('biliSearch：关键词为空/空白/非字符串直接抛，不发请求', async (t) => {
  const calls = installFetch(t, []);
  const mod = await freshModule();
  await assert.rejects(mod.biliSearch(''), /要搜什么？给个关键词/);
  await assert.rejects(mod.biliSearch('   '), /要搜什么？给个关键词/);
  await assert.rejects(mod.biliSearch(null), /要搜什么？给个关键词/);
  assert.equal(calls.length, 0);
});

test('biliSearch：映射字段、清洗 HTML、补全图片协议、去无 bvid 项、按 limit 截断', async (t) => {
  const calls = installFetch(t, [
    ...navRoute,
    searchRoute({
      code: 0,
      data: {
        result: [
          {
            bvid: 'BV1a', aid: 1, title: '<em class="keyword">标题</em>A', author: 'UP-A',
            play: '1234', pubdate: 1700000000, duration: '3:05',
            description: '<b>简介</b>正文'.padEnd(300, 'x'), pic: '//i0/pic.jpg',
            tag: ['搞笑', '', '日常', 123, 'a', 'b', 'c', 'd', 'e'],
          },
          { bvid: 'BV1b', aid: 2, title: 'B', author: 'UP-B', play: 0, pubdate: 0, description: '', pic: 'https://i0/full.jpg' },
          { aid: 3, title: '没有 bvid 的脏数据' },
          { bvid: 'BV1c', aid: 4, title: 'C' },
        ],
      },
    }),
  ]);
  const mod = await freshModule();
  const list = await mod.biliSearch('测试 关键词', { page: 2, limit: 2 });

  assert.equal(list.length, 2, '先过滤无 bvid 再按 limit 截断');
  assert.deepEqual(list[0].bvid, 'BV1a');
  assert.equal(list[0].title, '标题A', 'HTML 标签被剥掉');
  assert.equal(list[0].owner, 'UP-A');
  assert.equal(list[0].play, 1234);
  assert.equal(list[0].view, 1234, 'view 与 play 同源');
  assert.equal(list[0].danmaku, 0, '搜索接口没有弹幕数');
  assert.equal(list[0].pubdate, 1700000000 * 1000, '秒 → 毫秒');
  assert.equal(list[0].duration, '3:05');
  assert.ok(list[0].desc.startsWith('简介正文'));
  assert.equal(list[0].desc.length, 200, '简介截断到 200');
  assert.equal(list[0].pic, 'https://i0/pic.jpg');
  assert.deepEqual(list[0].tags, ['搞笑', '日常', '123', 'a', 'b', 'c', 'd', 'e'], '去空、转字符串、最多 8 个');
  assert.equal(list[1].pic, 'https://i0/full.jpg', '已是 https 的不重复加前缀');

  const nav = calls.filter((c) => c.url.includes('/web-interface/nav'));
  assert.equal(nav.length, 1, 'WBI key 只取一次');
  const search = calls.find((c) => c.url.includes('/wbi/search/type'));
  assert.ok(search.url.includes('w_rid='));
  assert.ok(search.url.includes(`keyword=${encodeURIComponent('测试 关键词')}`));
  assert.ok(search.url.includes('page=2'));
  assert.equal(search.opts.signal !== undefined, true, '带超时信号');
});

test('biliSearch：接口 code!=0 / HTTP 错误 / 网络异常都抛出', async (t) => {
  installFetch(t, [...navRoute, searchRoute({ code: -412, message: '请求被拦截' })]);
  const mod = await freshModule();
  await assert.rejects(mod.biliSearch('x'), /B站搜索接口 -412: 请求被拦截/);

  installFetch(t, [[/nav/, httpError(500)]]);
  const http = await freshModule();
  await assert.rejects(http.biliSearch('x'), /HTTP 500/);

  installFetch(t, [[/nav/, () => { throw new Error('断网了'); }]]);
  const offline = await freshModule();
  await assert.rejects(offline.biliSearch('x'), /断网了/);
});

test('biliSearch：nav 拿不到 wbi_img → 明确报错', async (t) => {
  installFetch(t, [[/\/nav/, jsonRes({ code: -101, data: {} })]]);
  const mod = await freshModule();
  await assert.rejects(mod.biliSearch('x'), /拿不到 B 站 WBI 签名 key/);
});

test('biliSearch：result 缺失/为空 → 空数组', async (t) => {
  installFetch(t, [...navRoute, searchRoute({ code: 0, data: {} })]);
  const mod = await freshModule();
  assert.deepEqual(await mod.biliSearch('x'), []);
});

// ───────────────────────── biliComments ─────────────────────────

test('biliComments：传 info 对象（有 aid）直接查热评并映射字段', async (t) => {
  const calls = installFetch(t, [
    ...navRoute,
    replyRoute({
      code: 0,
      data: {
        replies: [
          { member: { uname: '阿离' }, mid: 7, like: 3, rcount: 2, content: { message: '  说得好   啊  ' + 'x'.repeat(300) } },
          { member: { uname: '路人' }, mid: 8, like: 0, rcount: 0, content: { message: '第二条' } },
        ],
      },
    }),
  ]);
  const mod = await freshModule();
  const list = await mod.biliComments({ aid: 12345, bvid: 'BV1xx' }, { limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '阿离');
  assert.equal(list[0].mid, 7);
  assert.equal(list[0].like, 3);
  assert.equal(list[0].replies, 2);
  assert.equal(list[0].text.includes('  '), false, '连续空白压成一个空格');
  assert.equal(list[0].text.length, 200);

  const reply = calls.find((c) => c.url.includes('/reply/wbi/main'));
  assert.ok(reply.url.includes('oid=12345'));
  assert.ok(reply.url.includes('type=1') && reply.url.includes('mode=3') && reply.url.includes('web_location=1315875'));
  assert.ok(reply.url.includes('w_rid='));
});

test('biliComments：对象没有 aid 直接返回 []，不发请求', async (t) => {
  const calls = installFetch(t, []);
  const mod = await freshModule();
  assert.deepEqual(await mod.biliComments({ bvid: 'BV1xx' }), []);
  assert.equal(calls.length, 0);
});

test('biliComments：字符串 bvid 先查 view 拿 aid，再按 aid 查热评', async (t) => {
  const calls = installFetch(t, [
    ...navRoute,
    viewRoute(infoData()),
    replyRoute({ code: 0, data: { replies: [{ member: { uname: 'a' }, mid: 1, like: 1, content: { message: 'hi' } }] } }),
  ]);
  const mod = await freshModule();
  const list = await mod.biliComments('BV1xx411c7mD', { limit: 8 });
  assert.equal(list.length, 1);
  assert.equal(list[0].replies, 0, 'rcount 缺失归 0');
  assert.ok(calls.some((c) => c.url.includes('bvid=BV1xx411c7mD')));
  assert.ok(calls.find((c) => c.url.includes('/reply/wbi/main')).url.includes('oid=12345'));
});

test('biliComments：接口 code!=0 或没有 replies → 空数组；HTTP 错误向上抛', async (t) => {
  installFetch(t, [...navRoute, replyRoute({ code: -400, message: '风控' })]);
  const mod = await freshModule();
  assert.deepEqual(await mod.biliComments({ aid: 1 }), []);

  installFetch(t, [...navRoute, replyRoute({ code: 0, data: {} })]);
  const empty = await freshModule();
  assert.deepEqual(await empty.biliComments({ aid: 1 }), []);

  installFetch(t, [...navRoute, [/reply/, httpError(500)]]);
  const broken = await freshModule();
  await assert.rejects(broken.biliComments({ aid: 1 }), /HTTP 500/);
});

// ───────────────────────── biliTrending ─────────────────────────

test('biliTrending：映射热榜字段，ps 夹到 50、pn 透传、按 count 截断', async (t) => {
  const list = [
    { bvid: 'BV1', title: '热一', owner: { name: 'UP1' }, duration: 100, stat: { view: 5, danmaku: 6 }, cid: 1, pic: '//i0/a.jpg', desc: 'd'.repeat(200), tag: [{ name: '搞笑' }, null, { name: '' }] },
    { bvid: 'BV2', title: '热二', owner: { name: 'UP2' }, duration: 200, stat: { view: 7, danmaku: 8 }, cid: 2, pic: 'https://i0/b.jpg', desc: '短', tag: [] },
    { bvid: 'BV3', title: '热三' },
  ];
  const calls = installFetch(t, [[/\/x\/web-interface\/popular/, jsonRes({ code: 0, data: { list } })]]);
  const mod = await freshModule();
  const top = await mod.biliTrending(2, 3);
  assert.equal(top.length, 2);
  assert.deepEqual(top[0], {
    bvid: 'BV1', title: '热一', owner: 'UP1', duration: 100, view: 5, danmaku: 6, cid: 1,
    pic: 'https://i0/a.jpg', desc: 'd'.repeat(120), tags: ['搞笑'],
  });
  assert.equal(top[1].pic, 'https://i0/b.jpg');
  assert.ok(calls[0].url.includes('ps=2') && calls[0].url.includes('pn=3'));

  const clamped = installFetch(t, [[/popular/, jsonRes({ code: 0, data: { list } })]]);
  const mod2 = await freshModule();
  await mod2.biliTrending(100);
  assert.ok(clamped[0].url.includes('ps=50'), 'PS 上限 50');
});

test('biliTrending：code!=0 / 没有 list / HTTP 错误', async (t) => {
  installFetch(t, [[/popular/, jsonRes({ code: -404, message: '不存在' })]]);
  const mod = await freshModule();
  await assert.rejects(mod.biliTrending(), /B站热榜接口 -404: 不存在/);

  installFetch(t, [[/popular/, jsonRes({ code: 0, data: {} })]]);
  const empty = await freshModule();
  assert.deepEqual(await empty.biliTrending(), []);

  installFetch(t, [[/popular/, httpError(503)]]);
  const broken = await freshModule();
  await assert.rejects(broken.biliTrending(), /HTTP 503/);
});

// ───────────────────────── biliDanmakuTimed ─────────────────────────

test('biliDanmakuTimed：解析带时间戳弹幕、去空白、脏时间按 0 秒、limit 截断', async (t) => {
  const xml = [
    '<i><d p="12.9,1,25,16777215,1,1,0,0">  你好  </d>',
    '<d p="3.1,1,25,1,1,1,0,0">早</d>',
    '<d p="abc,1,25">脏时间</d>',
    '<d p="5.5">   </d>',
    '<d p="7.5">第七条</d>',
    '</i>',
  ].join('');
  const calls = installFetch(t, [dmRoute(xml)]);
  const mod = await freshModule();
  const timed = await mod.biliDanmakuTimed({ cid: 999 }, 10);
  assert.deepEqual(timed, [
    { t: 12, text: '你好' }, { t: 3, text: '早' }, { t: 0, text: '脏时间' }, { t: 7, text: '第七条' },
  ]);
  assert.ok(calls[0].url.includes('oid=999'));
  assert.equal(calls[0].opts.signal !== undefined, true);
});

test('biliDanmakuTimed：limit 生效、无匹配/请求失败都返回 null', async (t) => {
  installFetch(t, [dmRoute('<d p="1">a</d><d p="2">b</d><d p="3">c</d>')]);
  const mod = await freshModule();
  assert.deepEqual(await mod.biliDanmakuTimed({ cid: 1 }, 2), [{ t: 1, text: 'a' }, { t: 2, text: 'b' }]);

  installFetch(t, [dmRoute('<html>没有弹幕</html>')]);
  const empty = await freshModule();
  assert.equal(await empty.biliDanmakuTimed({ cid: 1 }), null);

  installFetch(t, [[/dm\/list/, () => { throw new Error('超时'); }]]);
  const broken = await freshModule();
  assert.equal(await broken.biliDanmakuTimed({ cid: 1 }), null, '弹幕拿不到不阻断主流程');
});

// ───────────────────────── openWatchContext ─────────────────────────

const subtitleRoute = [
  playerRoute([{ lan: 'ai-zh', url: '' }, { lan: 'zh-CN', url: '//aisubtitle.hdslb.com/a.json' }]),
  [/aisubtitle\.hdslb\.com/, jsonRes({ body: [
    { from: 0.9, content: '第一句' }, { from: 5.2, content: '第二句' }, { from: -3, content: '负时间' },
  ] })],
];

test('openWatchContext：非法输入抛错', async (t) => {
  installFetch(t, []);
  const mod = await freshModule();
  await assert.rejects(mod.openWatchContext(''), /需要一个 B站链接或 BV 号/);
  await assert.rejects(mod.openWatchContext('随便一段话'), /需要一个 B站链接或 BV 号/);
  await assert.rejects(mod.openWatchContext(null), /需要一个 B站链接或 BV 号/);
});

test('openWatchContext：B站链接一次取齐 info/字幕/弹幕峰值/关键帧', async (t) => {
  const xml = [
    '<d p="31.1">笑死</d>', '<d p="31.2">笑死</d>', '<d p="31.3">笑死</d>', '<d p="31.4">笑死</d>',
    '<d p="5.0">来了</d>',
  ].join('');
  const shotImages = Array.from({ length: 8 }, (_, i) => `//i0/${i}.jpg`);
  const calls = installFetch(t, [
    ...navRoute,
    viewRoute(infoData()),
    ...subtitleRoute,
    dmRoute(xml),
    shotRoute({ index: [0, 5, 10], image: shotImages }),
  ]);
  const mod = await freshModule();
  const ctx = await mod.openWatchContext('https://www.bilibili.com/video/BV1xx411c7mD?p=1');

  assert.equal(ctx.info.title, '标题');
  assert.equal(ctx.info.cid, 999, 'cid 取首页');
  assert.equal(ctx.info.owner, 'UP');
  assert.equal(ctx.info.aid, 12345);
  assert.ok(calls.some((c) => c.url.includes('bvid=BV1xx411c7mD')));
  assert.equal(ctx.subtitle.lang, 'zh-CN');
  assert.deepEqual(ctx.subtitle.timed, [
    { t: 0, text: '第一句' }, { t: 5, text: '第二句' }, { t: 0, text: '负时间' },
  ]);
  assert.equal(ctx.subtitle.count, 3);
  assert.deepEqual(ctx.peaks, [{ t: 30, phrase: '笑死', n: 4, total: 4 }]);
  assert.deepEqual(ctx.topPhrases, [{ phrase: '笑死', n: 4 }, { phrase: '来了', n: 1 }]);
  assert.equal(ctx.timedDanmakuCount, 5);
  const httpsImages = shotImages.map((u) => `https:${u}`);
  assert.deepEqual(ctx.frames, {
    idx: [0, 5, 10], coverage: 10,
    images: httpsImages.slice(0, 6), // 预览只带前 6 张，避免一次塞太图
    imagesAll: httpsImages,
  });
});

test('openWatchContext：转场接口全挂也不影响 info，字幕/峰值/帧各自回 null', async (t) => {
  installFetch(t, [
    ...navRoute,
    viewRoute(infoData()),
    [/player\/v2/, httpError(500)],
    dmRoute('<无弹幕>'),
    [/videoshot/, httpError(500)],
  ]);
  const mod = await freshModule();
  const ctx = await mod.openWatchContext('BV1xx411c7mD');
  assert.equal(ctx.info.bvid, 'BV1xx411c7mD');
  assert.equal(ctx.subtitle, null);
  assert.equal(ctx.peaks, null);
  assert.equal(ctx.topPhrases, null);
  assert.equal(ctx.timedDanmakuCount, 0);
  assert.equal(ctx.frames, null);
});

test('openWatchContext：av 号走 aid 查询；短链先解析再查 view', async (t) => {
  const calls = installFetch(t, [
    ...navRoute,
    viewRoute(infoData()),
    [/b23\.tv\/abc123/, { ok: true, url: 'https://www.bilibili.com/video/BV1yy411c7mD', headers: {} }],
    ...subtitleRoute,
    dmRoute(''),
    shotRoute({ image: [] }),
  ]);
  const mod = await freshModule();
  const byShort = await mod.openWatchContext('https://b23.tv/abc123');
  assert.equal(byShort.info.bvid, 'BV1xx411c7mD');
  assert.ok(calls.some((c) => c.url.includes('b23.tv/abc123')));
  assert.ok(calls.some((c) => c.url.includes('bvid=BV1yy411c7mD')));

  const avCalls = installFetch(t, [...navRoute, viewRoute(infoData({ bvid: 'BV1av', aid: 777 })), ...subtitleRoute, dmRoute(''), shotRoute({ image: [] })]);
  const mod2 = await freshModule();
  await mod2.openWatchContext('https://www.bilibili.com/video/av777');
  assert.ok(avCalls.some((c) => c.url.includes('aid=777')));
});

test('openWatchContext：短链解析失败 / view 接口报错 → 抛错', async (t) => {
  installFetch(t, [[/b23\.tv/, { ok: true, url: 'https://www.bilibili.com/' }]]);
  const mod = await freshModule();
  await assert.rejects(mod.openWatchContext('https://b23.tv/nope'), /短链解析失败/);

  installFetch(t, [[/\/x\/web-interface\/view/, jsonRes({ code: -404, message: '啥都木有' })]]);
  const missing = await freshModule();
  await assert.rejects(missing.openWatchContext('BV1xx411c7mD'), /B站接口 -404: 啥都木有/);
});

// ───────────────────────── watchVideo ─────────────────────────

test('watchVideo：不是 http(s) 链接直接拒，不发请求', async (t) => {
  const calls = installFetch(t, []);
  const mod = await freshModule();
  for (const bad of ['', 'BV1xx411c7mD', 'ftp://x/y', null, '   ']) {
    const r = await mod.watchVideo(bad);
    assert.deepEqual(r, { ok: false, error: '需要一个 http(s) 链接' });
  }
  assert.equal(calls.length, 0);
});

test('watchVideo：B站全链路——字幕/弹幕/热评/关键帧拼成结构化文本', async (t) => {
  installFetch(t, [
    ...navRoute,
    viewRoute(infoData()),
    ...subtitleRoute,
    dmRoute('<d p="1">哈哈</d><d p="2">哈哈</d><d p="3">来了</d>'),
    shotRoute({ index: [0, 5, 10], image: ['//i0/a.jpg', '//i0/b.jpg'] }),
    replyRoute({ code: 0, data: { replies: [{ member: { uname: '阿离' }, mid: 1, like: 3, content: { message: '说得好' } }] } }),
  ]);
  const mod = await freshModule();
  const r = await mod.watchVideo('https://www.bilibili.com/video/BV1xx411c7mD');

  assert.equal(r.ok, true);
  assert.equal(r.platform, 'bilibili');
  assert.deepEqual(r.layers, {
    api: { title: '标题', owner: 'UP', duration: 65, cid: 999 },
    subtitle: true, danmaku: true, frames: true, comments: 1,
  });
  assert.deepEqual(r.frameImages, ['https://i0/a.jpg', 'https://i0/b.jpg']);
  assert.ok(r.text.includes('【B站视频】标题'));
  assert.ok(r.text.includes('UP主：UP　时长：1:05　播放：1000　弹幕：25'), '秒数补零');
  assert.ok(r.text.includes('分P：P1 / P2'));
  assert.ok(r.text.includes('简介：简介'));
  assert.ok(r.text.includes('【字幕 zh-CN（3 行）】'));
  assert.ok(r.text.includes('第一句'));
  assert.ok(r.text.includes('【弹幕采样 2/3 条】'));
  assert.ok(r.text.includes('哈哈 / 来了'), '去重后按出现顺序');
  assert.ok(r.text.includes('【热评 1 条（别人的说法）】'));
  assert.ok(r.text.includes('- 阿离：说得好（3 赞）'));
  assert.ok(r.text.includes('【关键帧】2 张预览图'));
  assert.ok(r.text.includes('有字幕不等于知道画面'));
});

test('watchVideo：B站拿不到字幕/弹幕/帧/热评时如实说明，不硬编', async (t) => {
  installFetch(t, [
    ...navRoute,
    viewRoute(infoData({ duration: 59, pages: [], stat: undefined })),
    [/player\/v2/, jsonRes({ code: 0, data: { subtitle: { subtitles: [] } } })],
    dmRoute('<i></i>'),
    [/videoshot/, jsonRes({ code: 0, data: { image: [] } })],
    replyRoute({ code: -400, message: '风控' }),
  ]);
  const mod = await freshModule();
  const r = await mod.watchVideo('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(r.ok, true);
  assert.equal(r.layers.subtitle, false);
  assert.equal(r.layers.danmaku, false);
  assert.equal(r.layers.frames, false);
  assert.equal(r.layers.comments, 0);
  assert.deepEqual(r.frameImages, []);
  assert.ok(r.text.includes('【字幕】拿不到（无字幕或需要登录 cookie）'));
  assert.ok(r.text.includes('【关键帧】拿不到'));
  assert.ok(!r.text.includes('【弹幕采样'));
  assert.ok(!r.text.includes('【热评'));
  assert.ok(r.text.includes('没有字幕：文字层只能靠简介+弹幕推断'));
  assert.ok(r.text.includes('时长：0:59'), '59 秒补零');
  assert.ok(!r.text.includes('分P：'), '单 P 不显示分P行');
});

test('watchVideo：评论接口被吞掉（catch → []），主结果仍是 ok', async (t) => {
  installFetch(t, [
    ...navRoute,
    viewRoute(infoData()),
    ...subtitleRoute,
    dmRoute(''),
    shotRoute({ image: [] }),
    [/reply/, () => { throw new Error('评论超时'); }],
  ]);
  const mod = await freshModule();
  const r = await mod.watchVideo('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(r.ok, true);
  assert.equal(r.layers.comments, 0);
  assert.ok(!r.text.includes('【热评'));
});

test('watchVideo：B站解析失败统一包成 B站解析失败', async (t) => {
  installFetch(t, [[/\/view/, jsonRes({ code: -404, message: '稿件不见了' })]]);
  const mod = await freshModule();
  const r = await mod.watchVideo('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.deepEqual(r, { ok: false, error: 'B站解析失败：B站接口 -404: 稿件不见了' });
});

test('watchVideo：短链也能解析到真实视频', async (t) => {
  const calls = installFetch(t, [
    [/b23\.tv\/xyz/, { ok: true, url: 'https://www.bilibili.com/video/BV1zz411c7mD', headers: {} }],
    ...navRoute,
    viewRoute(infoData({ bvid: 'BV1zz411c7mD' })),
    ...subtitleRoute,
    dmRoute(''),
    shotRoute({ image: [] }),
  ]);
  const mod = await freshModule();
  const r = await mod.watchVideo('https://b23.tv/xyz');
  assert.equal(r.ok, true);
  assert.equal(r.layers.api.title, '标题');
  assert.ok(calls.some((c) => c.url.includes('b23.tv/xyz')));
});

test('watchVideo：非 B站网页抓 og/description/site_name，去标签与实体', async (t) => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="一篇 &amp; 好文章 <b>标题</b>">
    <meta property="og:description" content="描述 &amp; 摘要">
    <meta property="og:site_name" content="某站">
    <title>备用标题</title></head><body>x</body></html>`;
  const calls = installFetch(t, [[/example\.com/, textRes(html)]]);
  const mod = await freshModule();
  const r = await mod.watchVideo('https://example.com/post/1');
  assert.equal(r.ok, true);
  assert.equal(r.platform, 'other');
  assert.deepEqual(r.layers, { api: true, subtitle: false, danmaku: false, frames: false });
  assert.ok(r.text.includes('【网页】一篇 & 好文章 标题'), `实际：${r.text}`);
  assert.ok(r.text.includes('站点：某站'));
  assert.ok(r.text.includes('描述：描述 & 摘要'));
  assert.ok(r.text.includes('只拿到页面元信息'));
  assert.equal(calls[0].opts.signal !== undefined, true);
});

test('watchVideo：非 B站页面缺 og 时回落到 <title>，都没有就写（无标题）', async (t) => {
  installFetch(t, [[/a\.test/, textRes('<html><head><title>纯标题</title></head></html>')]]);
  const mod = await freshModule();
  assert.ok((await mod.watchVideo('https://a.test/')).text.includes('【网页】纯标题'));

  installFetch(t, [[/b\.test/, textRes('<html><head></head><body>空</body></html>')]]);
  const mod2 = await freshModule();
  const empty = await mod2.watchVideo('https://b.test/');
  assert.ok(empty.text.includes('【网页】(无标题)'));
  assert.ok(empty.text.includes('描述：（无）'));
});

test('watchVideo：非 B站页面抓不到 → 明确的失败原因', async (t) => {
  installFetch(t, [[/c\.test/, () => { throw new Error('被墙'); }]]);
  const mod = await freshModule();
  assert.deepEqual(await mod.watchVideo('https://c.test/'), {
    ok: false, error: '抓不到这个页面（可能需要登录/被墙/不是网页）',
  });
});
