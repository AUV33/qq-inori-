// inori-learning-writes.js · 把「她最近写下了什么学习产物」汇成一行（纯函数，零 IO）
//
// 数据源：data/state/learning-trend.jsonl —— 每次学习类文件写入的账本行 {at, op, file, source}。
// 以前这个文件只写不读（审计发现），这里给它一个真正的读端：接进自我模型区。
//
// 纪律：只报事实与次数，不做评价；没有数据就不出这一行。

const BUCKETS = [
  { name: '经验', match: /lessons\.jsonl$/ },
  { name: '技能', match: /skills\.json$/ },
  { name: '学习项', match: /learning-items\.json$/ },
  { name: '练习', match: /practice-sessions\.jsonl$/ },
  { name: '技能草稿', match: /skill-drafts\.json$/ },
  { name: '念头', match: /thoughts\.jsonl$/ },
  { name: '认知', match: /cognition\.jsonl$/ },
  { name: '黑话', match: /slang\.json$/ },
  { name: '记忆', match: /memory(-group_[0-9]+)?\.jsonl$/ },
];

function bucketOf(file = '') {
  const f = String(file || '');
  for (const b of BUCKETS) if (b.match.test(f)) return b.name;
  return '';
}

/**
 * @param {Array} rows learning-trend 行（{at,op,file,source}）
 * @param {{days?:number, now?:number}} opts
 * @returns {{total:number, days:number, byBucket:Record<string,number>}}
 */
export function summarizeLearningWrites(rows, { days = 7, now = Date.now() } = {}) {
  const windowMs = Math.max(1, Number(days) || 7) * 86400000;
  const cutoff = Number(now) - windowMs;
  const byBucket = {};
  let total = 0;
  const lastRows = {}; // 每个文件上一次 rewrite 的行数（用来区分"新增"和"内部整理"）
  for (const r of Array.isArray(rows) ? rows : []) {
    const at = Date.parse(r?.at || '');
    if (!Number.isFinite(at) || at < cutoff) continue;
    const b = bucketOf(r?.file);
    if (!b) continue;
    const file = String(r?.file || '');
    const op = String(r?.op || '');
    if (op === 'rewrite') {
      // [L2] rewrite 是内部整理（投票/过期触发）：只有文件变大的那部分才算"写下新东西"
      const n = Number(r?.rows);
      const prev = Number.isFinite(lastRows[file]) ? lastRows[file] : null;
      lastRows[file] = Number.isFinite(n) ? n : prev;
      if (!Number.isFinite(n) || prev === null || n <= prev) continue;
      byBucket[b] = (byBucket[b] || 0) + (n - prev);
      total += n - prev;
      continue;
    }
    byBucket[b] = (byBucket[b] || 0) + 1;
    total += 1;
  }
  return { total, days: Math.max(1, Number(days) || 7), byBucket };
}

/** 渲染成一行可注入文本；没有写入返回 '' */
export function renderLearningWritesLine(stats) {
  const total = Number(stats?.total) || 0;
  if (!total) return '';
  const parts = Object.entries(stats.byBucket || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} 次`);
  return `【我最近写下的】近 ${stats.days} 天，我往自己的本子里写了 ${total} 次（${parts.join('、')}）。`;
}
