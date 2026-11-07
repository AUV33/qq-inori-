// inori-learning-review.js · 周度账本的只读渲染（纯函数，零 IO）
//
// 数据源：learning-report.mjs 写出的 learning-report-summary.json。
// 只在周日注入；没有摘要就返回空串，不硬造。
export function renderWeeklyReview(summary, { maxChars = 320 } = {}) {
  if (!summary || !summary.at) return '';
  const at = Date.parse(summary.at);
  if (!Number.isFinite(at) || Date.now() - at > 14 * 86400000) return '';
  const t = summary.tasks || {};
  const items = summary.items || {};
  const practice = summary.practice || {};
  const drafts = summary.drafts || {};
  const lines = [
    '【本周学习账本】',
    `- 任务：成功 ${Number(t.success) || 0}｜未完成 ${Number(t.failed) || 0}｜未知 ${Number(t.unknown) || 0}`,
    `- 练习：过了 ${Number(practice.met) || 0}｜没过 ${Number(practice.not_met) || 0}`,
    `- 正在练：${Number(items.practicing) || 0} 件｜待定技能草稿：${Number(drafts.pending) || 0} 条`,
    '（只是事实，不打分；想继续/暂停/放下都行。）',
  ];
  return [...lines.join('\n')].slice(0, Math.max(80, Number(maxChars) || 320)).join('');
}
