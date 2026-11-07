// learning-report.mjs · 她的学习账本（给主人看，不给她打分）
//
// 输出：data/state/learning-report.md + stdout
// 用途：周度自审 / 观察“原地打转”是否真的下降。
import fs from 'node:fs';
import { stateDataPath } from '../src/domain/shared/project-paths.js';
import { load as loadGoals } from '../src/domain/leaves/inori-goals.js';
import { load as loadSkills, analytics as skillAnalytics } from '../src/domain/leaves/inori-skills.js';
import { load as loadLessons } from '../src/domain/leaves/inori-lessons.js';
import { load as loadPractice } from '../src/domain/leaves/inori-practice.js';
import { load as loadItems } from '../src/domain/leaves/inori-learning-items.js';
import { load as loadDrafts } from '../src/domain/leaves/inori-skill-drafts.js';
import { recent as recentTraces } from '../src/domain/leaves/inori-traces.js';
import { detectSkillCandidates } from '../src/domain/leaves/inori-skill-candidates.js';

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

const tasks = readJsonl(stateDataPath('task-ledger.jsonl'));
const goals = loadGoals();
const skills = loadSkills().items || [];
const lessons = loadLessons();
const practice = loadPractice();
const items = loadItems();
const drafts = loadDrafts();
const usage = readJsonl(stateDataPath('lesson-usage.jsonl'));
const outcomes = readJsonl(stateDataPath('outcomes.jsonl'));
const skillStats = skillAnalytics({ version: 1, items: skills });
const skillCandidates = detectSkillCandidates(recentTraces(200), { existingSkills: skills });

const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const taskOutcome = count(tasks, (x) => `${x.status || '?'}/${x.outcome || 'unknown'}`);
const goalStatus = count(goals, (x) => x.status);
const skillMastery = skills.filter((x) => Number(x.success) > 0).map((x) => ({ name: x.name, mastery: Number(x.mastery ?? 0), success: x.success, fail: x.fail }));
const practiceSum = practice.reduce((m, x) => { m[x.result] = (m[x.result] || 0) + 1; return m; }, {});
const repeat = (() => {
  const map = new Map();
  for (const t of tasks) {
    const fp = t.fingerprint || String(t.task || '').slice(0, 120);
    if (!fp) continue;
    map.set(fp, (map.get(fp) || 0) + 1);
  }
  return [...map.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
})();

const lines = [
  `# 学习账本 · ${new Date().toLocaleDateString('sv-SE')}`,
  '',
  '> 只报事实，不做评价；不给她看分数，不设配额。',
  '',
  '## 任务',
  `- 总 ${tasks.length} 条`,
  ...Object.entries(taskOutcome).map(([k, v]) => `- ${k}: ${v}`),
  `- 同指纹重复派活 Top: ${repeat.length ? repeat.map(([k, n]) => `${k.slice(0, 24)}×${n}`).join('；') : '无'}`,
  '',
  '## 目标',
  ...Object.entries(goalStatus).map(([k, v]) => `- ${k}: ${v}`),
  '',
  '## 技能',
  `- 共 ${skills.length} 条；活跃 ${skillStats.active} / 归档 ${skillStats.archived} / 降级 ${skillStats.degraded}`,
  `- 版本 ${skillStats.versions} 个（多版本技能 ${skillStats.multiVersion} 条）；当前版验证 ${skillStats.verifiedCurrent} 条${skillStats.verificationRate == null ? '' : `（${Math.round(skillStats.verificationRate * 100)}%）`}`,
  `- 注入 ${skillStats.injected} / 尝试 ${skillStats.attempts} / 成功 ${skillStats.success} / 失败 ${skillStats.fail}；累计 成功 ${skillStats.lifetime.success} / 失败 ${skillStats.lifetime.fail}`,
  `- 技能候选 ${skillCandidates.length} 条（只提示，不自动入库）`,
  ...skillMastery.sort((a, b) => b.mastery - a.mastery).slice(0, 8).map((x) => `- ${x.name}: mastery ${x.mastery}（成功 ${x.success}/失败 ${x.fail}）`),
  '',
  '## 经验',
  `- 共 ${lessons.length} 条；最近 7 天被注入 ${usage.filter((x) => Date.parse(x.at || '') > Date.now() - 7 * 86400000).length} 次`,
  '',
  '## 意图 / 结果',
  `- 结果账本 ${outcomes.length} 条：${Object.entries(count(outcomes, (x) => x.result || 'unknown')).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}`,
  '',
  '## 学习项 / 练习',
  `- 学习项 ${items.length} 条；正在练 ${items.filter((x) => x.status === 'practicing').length} 条`,
  ...items.filter((x) => x.status === 'practicing' || x.status === 'paused').slice(0, 8).map((x) => `- [${x.status}] ${x.title}${x.nextDrill ? `｜下一步：${x.nextDrill}` : ''}`),
  `- 练习记录 ${practice.length} 条：${Object.entries(practiceSum).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}`,
  `- 待定技能草稿 ${drafts.filter((x) => x.status === 'draft').length} 条`,
  '',
  '## 待续（失败/卡住，带下一步）',
  ...tasks.filter((x) => ['failed', 'expired'].includes(x.status) && x.outcome !== 'success' && (x.nextAction || x.lastError)).slice(-8).map((x) => `- ${String(x.task || '').slice(0, 50)}｜${x.lastError || x.note || ''}${x.nextAction ? `｜下一步：${x.nextAction}` : ''}`),
  '',
];

const text = lines.join('\n');
const out = stateDataPath('learning-report.md');
fs.mkdirSync(stateDataPath('.'), { recursive: true });
fs.writeFileSync(out, text + '\n', 'utf8');
// [WEEKLY-REVIEW] 给唤醒用的紧凑摘要；没有它就不注入周报。
const summary = {
  at: new Date().toISOString(),
  tasks: {
    total: tasks.length,
    success: tasks.filter((x) => x.outcome === 'success').length,
    failed: tasks.filter((x) => ['failed', 'expired'].includes(x.status) || ['failed', 'blocked'].includes(x.outcome)).length,
    unknown: tasks.filter((x) => !x.outcome || x.outcome === 'unknown').length,
  },
  items: { total: items.length, practicing: items.filter((x) => x.status === 'practicing').length },
  practice: practiceSum,
  drafts: { pending: drafts.filter((x) => x.status === 'draft').length },
  skills: {
    total: skillStats.total,
    active: skillStats.active,
    archived: skillStats.archived,
    multiVersion: skillStats.multiVersion,
    versions: skillStats.versions,
    verifiedCurrent: skillStats.verifiedCurrent,
    injected: skillStats.injected,
    attempts: skillStats.attempts,
    success: skillStats.success,
    fail: skillStats.fail,
    candidates: skillCandidates.length,
  },
};
fs.writeFileSync(stateDataPath('learning-report-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(text);
console.error(`\n[learning-report] written: ${out}`);
