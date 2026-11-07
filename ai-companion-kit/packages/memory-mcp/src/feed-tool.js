// @ts-check
// feed-tool.js · 「看帖子流」工具（RSS / RSSHub 路由）
//
// 为什么单独做：browse_posts 是「打开一个网页看正文」，适合单篇；她要看别人
// 最近在聊什么，用 RSS/RSSHub 的「流」更顺——纯文本、无登录墙、不撞反爬。
//
// 自建 RSSHub 的 base 通过环境变量 RSSHUB_BASE 指定（默认用可达的公共镜像，
// 依次回退）。换实例只改这一个变量，工具代码不动。
// [SSRF] 复用本目录 ssrf-safe.js 的 safeFetch：校验全部 DNS 结果、连已校验 IP，免疫 TOCTOU。
import { safeFetch } from './ssrf-safe.js';
const MIRRORS = (() => {
  const env = String(process.env.RSSHUB_BASE ?? '').trim().replace(/\/+$/, '');
  if (env) return [env];
  return [
    'https://rsshub.rssforever.com',
    'https://rsshub.ktachibana.party',
    'https://hub.slarker.me',
  ];
})();

// 默认随机看的几个常见流（公共镜像上实测可用的）
const DEFAULT_ROUTES = ['/hupu/bbs', '/zhihu/daily', '/36kr/newsflashes', '/sspai/matrix'];

const LIMITS = { minGapMs: 3000, perHour: 40 };

function stripTags(html) {
  // 先还原实体再剥标签：反过来的话 &lt;div&gt; 会在剥完标签后被还原成 <div>，
  // 结果把 HTML 当正文塞给她（实测虎扑/知乎的 description 都是转义过的 HTML）。
  let s = String(html ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const cdata = (s) => String(s ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();

function firstTag(block, names) {
  for (const n of names) {
    const m = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(block);
    if (m) return cdata(m[1]);
  }
  return '';
}

/** 解析 RSS 2.0 / Atom / RDF 成 { title, items[] }；解析不出条目就返回空。 */
export function parseFeed(text) {
  const s = String(text ?? '');
  const feedTitle = stripTags(firstTag(s, ['title'])) || '';
  const blocks = [];
  for (const m of s.matchAll(/<item\b[\s\S]*?<\/item>/gi)) blocks.push(m[0]);
  for (const m of s.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) blocks.push(m[0]);
  const items = blocks.map((b) => {
    const title = stripTags(firstTag(b, ['title']));
    const link = stripTags(firstTag(b, ['link'])) || (/<link[^>]+href="([^"]+)"/i.exec(b)?.[1] ?? '');
    const date = stripTags(firstTag(b, ['pubDate', 'updated', 'published', 'dc:date']));
    const desc = stripTags(firstTag(b, ['description', 'summary', 'content'])).slice(0, 140);
    return { title, link, date, desc };
  }).filter((x) => x.title || x.link);
  return { title: feedTitle, items };
}

async function fetchFeed(url) {
  // [SSRF] safeFetch 内部完成公网校验并连已校验 IP，原生 fetch(url) 会重新解析 DNS（TOCTOU），不可直接用。
  const res = await safeFetch(url, 500000);
  return res.body;
}

export function registerFeedTool(server, { z, reply, fail }) {
  const hits = [];
  let lastAt = 0;
  const count = (windowMs, now) => hits.filter((t) => now - t < windowMs).length;

  server.tool(
    'feed_posts',
    '看帖子流（RSS/RSSHub）：给一个 RSS 地址，或 RSSHub 路由（以 / 开头的走内置实例，如 /hupu/bbs 虎扑步行街、/zhihu/daily 知乎日报、/36kr/newsflashes 36氪快讯、/sspai/matrix 少数派）。不填就随机看一个。看多少、看哪条你自己定，只是别刷太快。',
    {
      url: z.string().optional().describe('RSS 地址（http 开头）或 RSSHub 路由（/ 开头）；不填随机看一个'),
      max: z.number().int().min(1).max(20).optional().describe('这次最多看几条，默认 10'),
    },
    async ({ url, max }) => {
      try {
        const now = Date.now();
        const raw = String(url ?? '').trim();
        const target = raw || DEFAULT_ROUTES[Math.floor(Math.random() * DEFAULT_ROUTES.length)];
        const isRoute = target.startsWith('/');
        if (!isRoute && !/^https?:\/\//i.test(target)) return fail('要给 RSS 地址（http 开头）或 RSSHub 路由（/ 开头）');
        // [SSRF] 用户给的完整 RSS 地址，SSRF 校验已在 fetchFeed→safeFetch 内部完成（校验全部 DNS 结果、连已校验 IP），
        // 无需在此重复预校验；若地址为私网/环回，safeFetch 会抛错并在下方被捕获为 fail。

        while (hits.length && now - hits[0] > 3600000) hits.shift();
        if (now - lastAt < LIMITS.minGapMs) return fail(`刚看过一次，歇 ${Math.ceil((LIMITS.minGapMs - (now - lastAt)) / 1000)} 秒再刷。`);
        if (count(3600000, now) >= LIMITS.perHour) return fail(`这一小时看了 ${LIMITS.perHour} 次，够了，等会儿再来。`);

        const bases = isRoute ? MIRRORS : [''];
        let lastErr = '';
        for (const base of bases) {
          const u = isRoute ? base + target : target;
          try {
            const text = await fetchFeed(u);
            const feed = parseFeed(text);
            if (!feed.items.length) { lastErr = `${u} 没解析出条目`; continue; }
            hits.push(now); lastAt = now;
            const n = Math.min(Number(max) || 10, feed.items.length, 20);
            const lines = feed.items.slice(0, n).map((x, i) => {
              const bits = [x.title || '(无标题)'];
              if (x.date) bits.push(x.date);
              const head = `${i + 1}. ${bits.join(' · ')}`;
              const tail = [x.desc ? `   ${x.desc}` : '', x.link ? `   ${x.link}` : ''].filter(Boolean).join('\n');
              return tail ? `${head}\n${tail}` : head;
            });
            return reply(`看完了：${u}\n${feed.title ? `来源：${feed.title}\n` : ''}（这次 ${n} 条，这一小时第 ${count(3600000, Date.now())}/${LIMITS.perHour} 次）\n\n${lines.join('\n')}`);
          } catch (e) { lastErr = `${u} → ${e?.message ?? e}`; }
        }
        return fail(`没看上：${lastErr || 'RSSHub 实例都不可达'}`);
      } catch (e) {
        return fail(`看流水失败：${e?.message ?? e}`);
      }
    }
  );
}
