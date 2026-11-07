// @ts-check
// browse-tool.js · 注册「逛帖子」工具（memory-mcp 的独立模块，避免和别人的编辑撞车）
//
// 用户的取向很明确：她想看就让她多看，不要按小时卡得那么死。
// 但仍然保留一道安全阀，防的是第三方站点风控（我们踩过腾讯封号的坑）：
//   每分钟 ≤5 页、每小时 ≤30 页、每天 ≤120 页、两次之间至少 5 秒。
// 这些不是"限制她的兴趣"，是防封号——封了号她连看都看不了。
import fs from 'node:fs';
// [SSRF] 复用本目录 ssrf-safe.js（与 qq-bridge/src/domain/shared/safe-fetch.js 同步的强实现）：
// 解析全部 DNS 地址判私网、连已校验 IP、重定向每跳重校验，免疫 DNS-rebinding(TOCTOU)。
import { safeFetch, validateFetchUrl, isPrivateIp } from './ssrf-safe.js';

// 实测（2026-10-23）：贴吧=反爬滑块、知乎=35字空壳、nga=SPA空壳 都不可用；
// 豆瓣小组 4434 字、虎扑 15852 字可直接读；小黑盒靠无头渲染可读。
// 实测（2026-10-23）：
//   豆瓣小组 253ms/2071字 ✓  虎扑 15852字 ✓
//   小黑盒帖子页 3.9s/7782字 ✓（需渲染）
//   小黑盒首页 25s/78字 ✗（首页太重，别放进来）  贴吧/知乎/nga ✗（反爬/登录墙）
export const SOURCES = [
  'https://www.douban.com/group/explore',                   // 豆瓣小组
  'https://www.hupu.com/',                                  // 虎扑步行街
  'https://www.xiaoheihe.cn/app/bbs/link/51c6729d32e0',     // 小黑盒帖子
];

const LIMITS = {
  perMinute: 5,
  perHour: 30,
  perDay: 120,
  minGapMs: 5000,
};

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

// [DOUBAN-COMMENTS] 豆瓣话题页的评论走 rexxar JSON API（页面 HTML 会 403，但接口可读）。
// 评论是「别人怎么说话」最密集的地方，读帖时一起带回来，喂给后面的语言学习链路。
export function doubanTopicId(url) {
  const m = /(?:www|m)\.douban\.com\/group\/topic\/(\d+)/.exec(String(url ?? ''));
  return m ? m[1] : null;
}

// ── [SSRF] 公网地址校验 ──────────────────────────────────────────────
// 委托给 ssrf-safe.js 的强实现：解析全部 DNS 地址判私网、连已校验 IP、重定向每跳
// 重校验，免疫 DNS-rebinding(TOCTOU)。不再在此自写一份 isPrivateIp（之前那份与
// qq-bridge 的 safe-fetch 不一致，且 fetch 时重新解析域名，正是 SSRF 缺口的根因）。
export function ipIsPublic(ip) { return !isPrivateIp(ip); }

/**
 * 校验一个网址是公网可达的 http(s)。委托 ssrf-safe 的 validateFetchUrl，
 * 保持原 { lookup } 注入签名以兼容既有测试。
 * @param {string} url
 * @param {{lookup?:(host:string,opts:any,cb:(e:any,a?:{address:string,family?:number})=>void)=>void}} [opts]
 */
export async function assertPublicUrl(url, { lookup } = {}) {
  const { url: u } = await validateFetchUrl(url, lookup ? { lookup } : undefined);
  return u.toString();
}

/** 把 rexxar 评论 JSON 变成短句数组（去 HTML/去重/限长）。 */
export function parseDoubanComments(json, { max = 8, maxChars = 120 } = {}) {
  const list = Array.isArray(json?.comments) ? json.comments : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    let text = String(c?.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
    if (seen.has(text)) continue;
    seen.add(text);
    const who = String(c?.author?.name ?? '').trim();
    out.push(who ? `${who}：${text}` : text);
    if (out.length >= max) break;
  }
  return out;
}

async function readDoubanComments(url) {
  const id = doubanTopicId(url);
  if (!id) return [];
  try {
    const api = `https://m.douban.com/rexxar/api/v2/group/topic/${id}/comments?start=0&count=20`;
    // [SSRF] 走 safeFetch：先校验 m.douban.com 全部解析结果均为公网，再连已校验 IP，不重解析。
    const res = await safeFetch(api, 50000);
    const json = JSON.parse(res.body);
    return parseDoubanComments(json);
  } catch { return []; }
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** [SSRF] 渲染进程只放行固定白名单源：Edge 会自行 DNS 解析，无法用已校验 IP 约束。 */
export function canUseEdgeRenderer(url, sources = SOURCES) {
  return sources.includes(url);
}

async function renderViaEdge(url) {
  const edge = EDGE_PATHS.find((p) => fs.existsSync(p));
  if (!edge) return null;
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
      execFile(edge, ['--headless=new', '--disable-gpu', '--no-sandbox', '--dump-dom', '--virtual-time-budget=4000', url],
        { timeout: 25000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))));
    });
  } catch { /* 渲染失败就用手上的 */ return null; }
}

/**
 * [TEST-HOOK] fetchPage / render 可注入，让「自定义 URL 不进入渲染进程」变成确定性测试。
 * 生产不传 opts 时行为与原来完全一致：safeFetch + 真实 Edge。
 */
export async function readPage(url, { fetchPage, render = renderViaEdge } = {}) {
  // [SSRF] 走 safeFetch：解析全部 DNS 结果判私网、连已校验 IP、重定向每跳重校验，
  // 不再用原生 fetch(url)（那会重新解析域名，存在 DNS-rebinding/TOCTOU 缺口）。
  const res = await (fetchPage ? fetchPage(url) : safeFetch(url, 200000));
  const html = res.body || '';
  let title = (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(html)?.[1] ?? '').trim();
  const text = stripTags(html);
  if (text.length >= 300) return { title, text, rendered: false };
  if (!canUseEdgeRenderer(url)) return { title, text, rendered: false };
  const out = await render(url);
  if (out == null) return { title, text, rendered: false };
  const rText = stripTags(out);
  if (rText.length > text.length) {
    title = (/<title[^>]*>([^<]{0,200})<\/title>/i.exec(out)?.[1] ?? title).trim();
    return { title, text: rText, rendered: true };
  }
  return { title, text, rendered: false };
}

export function registerBrowseTool(server, { z, reply, fail }) {
  const hits = [];   // 访问时间戳
  let lastAt = 0;

  const count = (windowMs, now) => hits.filter((t) => now - t < windowMs).length;

  server.tool(
    'browse_posts',
    '去外面逛逛：看看别人在说什么、怎么说话。可以自己指定网址；不指定就随机去一个常去的地方（豆瓣/虎扑/小黑盒）；贴吧、知乎常被反爬/登录墙挡住，别在那儿耗。豆瓣话题页会把评论区一起读出来（评论区也是别人怎么说话的地方）。看多久、看多少你自己定，只是别刷太快（防封号）。',
    {
      url: z.string().optional().describe('想看的网址（http 开头）；不填就随机逛一个'),
    },
    async ({ url }) => {
      try {
        const now = Date.now();
        // 先把网址本身校验掉：非法网址不该被误报成「歇 5 秒」。
        const target = String(url ?? '').trim() || SOURCES[Math.floor(Math.random() * SOURCES.length)];
        if (!/^https?:\/\//i.test(target)) return fail('要给完整网址（http 开头）');
        // [SSRF] 访问前先确认是公网地址，拦掉内网/环回/元数据。
        try { await assertPublicUrl(target); }
        catch (e) { return fail('这个网址不能访问：' + (e?.message ?? e)); }
        // 只保留最近一天的记录
        while (hits.length && now - hits[0] > 86400000) hits.shift();

        if (now - lastAt < LIMITS.minGapMs) {
          return fail(`刚看过一页，歇 ${Math.ceil((LIMITS.minGapMs - (now - lastAt)) / 1000)} 秒再看下一页（防封号）。`);
        }
        if (count(60000, now) >= LIMITS.perMinute) return fail(`这一分钟已经看了 ${LIMITS.perMinute} 页，缓一下。`);
        if (count(3600000, now) >= LIMITS.perHour) return fail(`这一小时看了 ${LIMITS.perHour} 页，够了，等会儿再来。`);
        if (count(86400000, now) >= LIMITS.perDay) return fail(`今天看了 ${LIMITS.perDay} 页，真够了，明天再看。`);

        hits.push(now);
        lastAt = now;
        const page = await readPage(target);
        const body = String(page.text || '').slice(0, 1800);
        if (!body) return fail('这一页没读出内容（可能是登录墙或纯脚本页），换个地方试试。');
        // [DOUBAN-COMMENTS] 话题页把评论一起带回来（拿不到就明说，不编）。
        const comments = await readDoubanComments(target);
        const commentBlock = comments.length
          ? `\n\n评论区（${comments.length} 条，别人的说法）：\n${comments.map((c) => `- ${c}`).join('\n')}`
          : (doubanTopicId(target) ? '\n\n（评论区这次没读出来：接口要登录或限流）' : '');

        const used = count(3600000, Date.now());
        return reply(
          `看完了：${target}\n` +
          (page.title ? `标题：${page.title}\n` : '') +
          (page.rendered ? '（这页要渲染才出内容）\n' : '') +
          `\n${body}${commentBlock}\n\n（这一小时已看 ${used}/${LIMITS.perHour} 页）`
        );
      } catch (e) {
        return fail(`逛失败了：${e?.message ?? e}`);
      }
    }
  );
}
