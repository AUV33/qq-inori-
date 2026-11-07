// quality-trends.js · 能力质量的时间趋势（纯函数，只做分桶，不读文件）
//
// 目的：控制台不再只显示「现在多少条」，而是能看近 7 / 30 天每天有没有在写、有没有在用。
// 输入是各数据源的原始时间戳（ms 或 ISO 字符串），输出对齐到自然日的序列。

export const TREND_SOURCES = [
  { key: 'memory', label: '记忆写入' },
  { key: 'lessonsAdded', label: '经验新增' },
  { key: 'lessonsUsed', label: '经验被用' },
  { key: 'skillsUsed', label: '技能被用' },
  { key: 'cognitionAdded', label: '认知新增' },
];

export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (!text) return null;
  // 纯日期（memory 的 day 字段）按本地零点算
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const t = Date.parse(`${text}T00:00:00`);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : null;
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 生成从 days 天前到今天的空序列（含今天） */
export function emptySeries(days = 7, now = Date.now()) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const rows = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = dayKey(d.getTime());
    rows.push({ date: key, ...Object.fromEntries(TREND_SOURCES.map((s) => [s.key, 0])) });
  }
  return rows;
}

/**
 * 把各数据源的时间戳分桶。
 * @param {Record<string, Array<number|string>>} input 每个 source key 对应一组时间
 */
export function buildTrends(input = {}, { days = 7, now = Date.now() } = {}) {
  const series = emptySeries(days, now);
  const index = new Map(series.map((row) => [row.date, row]));
  const skipped = {};
  /** 落在窗口外或无法解析的条数，报告里要能看见（否则趋势会骗人） */
  for (const { key } of TREND_SOURCES) {
    const values = Array.isArray(input[key]) ? input[key] : [];
    for (const value of values) {
      const ms = toMs(value);
      if (ms === null) { skipped[key] = (skipped[key] || 0) + 1; continue; }
      const row = index.get(dayKey(ms));
      if (!row) { skipped[key] = (skipped[key] || 0) + 1; continue; }
      row[key] += 1;
    }
  }
  const totals = Object.fromEntries(TREND_SOURCES.map((s) => [s.key, series.reduce((sum, r) => sum + r[s.key], 0)]));
  return { days: series.length, from: series[0]?.date ?? null, to: series.at(-1)?.date ?? null, series, totals, skipped };
}
