// inori-overview.js · 跨域只读总览（学习 / 任务 / 关系 / 媒体）
//
// 为什么要有它：
//   学习侧已经有 `learning-report.md` + `learning-report-summary.json`，但任务台账、
//   人物/关系图、生成图/表情库各是一本账。没有一处能回答“她现在手头有什么、跟谁常来常往、
//   媒体攒了多少”。本模块把**已有的状态文件**读成一个只读模型，不合并存储、不二次学习、
//   不改任何源文件。
//
// 纪律：
//   1) 只读：`collectOverview()` 只读文件，`writeOverview()` 只写 overview 自己的两份产物。
//   2) 不编：没有的数据就是 0 / 空数组；源文件坏掉时跳过该源，不让总览整体失败。
//   3) 学习侧不重算：`learning` 直接引用 learning-report-summary.json 的内容，报告只给路径。
//   4) 确定性：除 `now` 外不依赖随机/网络；同样的输入得到同样的模型，便于测试和对照。
//
// 产物：
//   data/state/overview.json  机器读（控制台 / 报告 / 将来的唤醒注入）
//   data/state/overview.md    人读
//
// 上游：task-ledger.jsonl / works.json / people.json / social-graph.json /
//       group-members.json / imagegen.jsonl / state/stickers.json /
//       learning-report-summary.json
// 下游：`npm run state:overview`、控制台 GET /api/state/overview
import fs from 'node:fs';
import path from 'node:path';
import { bridgePath, projectPath, stateDataPath, STATE_DATA_DIR } from '../shared/project-paths.js';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';
// [PEOPLE-VAULT] 总览也要能读加密后的 people.json。
import { readPeopleFile } from '../shared/people-vault.mjs';
import { readJsonl as readJsonlShared } from './jsonl.mjs';

export const VERSION = 1;

export const DEFAULTS = Object.freeze({
  recentDays: 7,
  socialDays: 45,
  topPeople: 6,
  topPairs: 6,
  maxFailed: 5,
  maxRecentTasks: 5,
  maxMedia: 5,
  maxStickers: 3,
  maxTextChars: 900,
});

const DAY = 24 * 3600 * 1000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function defaultOverviewPaths() {
  return {
    stateDir: STATE_DATA_DIR,
    learningSummary: stateDataPath('learning-report-summary.json'),
    learningReport: stateDataPath('learning-report.md'),
    tasks: stateDataPath('task-ledger.jsonl'),
    works: stateDataPath('works.json'),
    worksAlt: bridgePath('state', 'works.json'),
    people: stateDataPath('people.json'),
    socialGraph: stateDataPath('social-graph.json'),
    groupMembers: stateDataPath('group-members.json'),
    imagegen: stateDataPath('imagegen.jsonl'),
    stickers: bridgePath('state', 'stickers.json'),
    mediaDir: projectPath('media', 'pics'),
  };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const number = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const text = (v) => String(v ?? '')
  // 总览可能被控制台/报告/将来的 prompt 共用：去掉控制字符和零宽字符，防止一段
  // 昵称或任务描述把渲染结果伪造出新段落。换行/制表统一压成空格。
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const clip = (v, n) => [...text(v)].slice(0, Math.max(1, Number(n) || 1)).join('');
const iso = (v) => {
  const ts = typeof v === 'number' ? v : Date.parse(String(v ?? ''));
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
};
const tsOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const ts = Date.parse(String(v ?? ''));
  return Number.isFinite(ts) ? ts : 0;
};
const within = (v, now, days) => {
  const ts = tsOf(v);
  return ts > 0 && ts >= now - Math.max(1, Number(days) || 1) * DAY;
};
const countBy = (rows, fn) => {
  const out = {};
  for (const row of rows) {
    const key = String(fn(row) || 'unknown');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
};
const sortedByTime = (rows, fields = ['finishedAt', 'at', 'updatedAt']) => [...rows].sort((a, b) => {
  const ta = Math.max(...fields.map((f) => tsOf(a?.[f])), 0);
  const tb = Math.max(...fields.map((f) => tsOf(b?.[f])), 0);
  return tb - ta;
});

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readJsonl(file) { return readJsonlShared(file); }

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** 递归扫媒体目录（只认常见图片后缀；深度上限 3，避免误扫进大目录） */
function scanMedia(dir, rootDir, depth = 0, out = []) {
  if (depth > 3 || out.length >= 5000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (out.length >= 5000) break;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanMedia(abs, rootDir, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const st = fs.statSync(abs);
      out.push({
        path: path.relative(rootDir, abs).split(path.sep).join('/'),
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'inori-overview.js:143'); }
  }
  return out;
}

function peopleSummary(people, now, opts) {
  const rows = Object.entries(isObject(people) ? people : {})
    .filter(([, person]) => isObject(person))
    .map(([id, person]) => {
      const aliases = isObject(person.aliases) ? Object.values(person.aliases).map(text).filter(Boolean) : [];
      return {
        id: String(person.id ?? id),
        name: aliases[0] || String(person.id ?? id),
        owner: person.owner === true,
        groups: asArray(person.groups).length,
        lastSeen: tsOf(person.lastSeen),
        impressions: asArray(person.impressions).length,
        notes: asArray(person.notes).length,
      };
    });
  const active = rows.filter((row) => within(row.lastSeen, now, opts.recentDays));
  const top = [...rows]
    .sort((a, b) => b.lastSeen - a.lastSeen || b.impressions - a.impressions)
    .slice(0, opts.topPeople)
    .map((row) => ({ ...row, lastSeen: iso(row.lastSeen) }));
  return {
    total: rows.length,
    owner: rows.filter((row) => row.owner).length,
    active7d: active.length,
    withImpressions: rows.filter((row) => row.impressions > 0).length,
    withNotes: rows.filter((row) => row.notes > 0).length,
    top,
  };
}

function groupSummary(groupMembers) {
  const groups = isObject(groupMembers?.groups) ? groupMembers.groups : (isObject(groupMembers) ? groupMembers : {});
  const keys = Object.keys(groups).filter((key) => key.startsWith('group:'));
  let members = 0;
  for (const key of keys) {
    const block = groups[key];
    members += isObject(block?.members) ? Object.keys(block.members).length : 0;
  }
  return { total: keys.length, members };
}

function socialSummary(graph, now, opts) {
  const groups = isObject(graph?.groups) ? graph.groups : {};
  const cutoff = now - opts.socialDays * DAY;
  const pairs = [];
  let activePairs = 0;
  for (const [group, block] of Object.entries(groups)) {
    if (!isObject(block?.pairs)) continue;
    for (const row of Object.values(block.pairs)) {
      if (!isObject(row)) continue;
      const lastAt = tsOf(row.lastAt);
      if (lastAt < cutoff) continue;
      activePairs += 1;
      const total = number(row.ab) + number(row.ba);
      if (total < 3) continue;
      pairs.push({
        group,
        a: text(row.a),
        b: text(row.b),
        total,
        reply: number(row.reply),
        adjacent: number(row.adjacent),
        mention: number(row.mention),
        lastAt,
      });
    }
  }
  pairs.sort((a, b) => b.total - a.total || b.lastAt - a.lastAt);
  return {
    groups: Object.keys(groups).length,
    activePairs,
    top: pairs.slice(0, opts.topPairs).map((row) => ({ ...row, lastAt: iso(row.lastAt) })),
  };
}

function taskSummary(tasks, works, now, opts) {
  const rows = asArray(tasks).filter(isObject);
  const status = countBy(rows, (row) => row.status || 'unknown');
  const outcome = countBy(rows, (row) => row.outcome || 'unknown');
  const pendingRows = rows.filter((row) => ['queued', 'running', 'dispatched'].includes(String(row.status)));
  const recentRows = rows.filter((row) => within(row.finishedAt || row.at, now, opts.recentDays));
  const failedRows = sortedByTime(rows.filter((row) => {
    if (String(row.outcome) === 'success') return false;
    return ['failed', 'expired'].includes(String(row.status))
      || ['failed', 'blocked'].includes(String(row.outcome));
  }));
  const failed = failedRows.slice(0, opts.maxFailed).map((row) => ({
    task: clip(row.task, 80),
    status: String(row.status || 'unknown'),
    outcome: String(row.outcome || 'unknown'),
    at: iso(row.finishedAt || row.at),
    lastError: clip(row.lastError || row.note, 100) || null,
    nextAction: clip(row.nextAction, 100) || null,
  }));

  const workRows = asArray(works?.works ?? works?.items ?? works).filter(isObject);
  const workStatus = countBy(workRows, (row) => row.status || 'unknown');
  return {
    total: rows.length,
    pending: {
      queued: status.queued || 0,
      running: (status.running || 0) + (status.dispatched || 0),
    },
    status,
    outcome,
    recent7d: {
      total: recentRows.length,
      success: recentRows.filter((row) => row.outcome === 'success').length,
      failed: recentRows.filter((row) => ['failed', 'blocked'].includes(String(row.outcome))
        || ['failed', 'expired'].includes(String(row.status))).length,
    },
    failed,
    pendingItems: sortedByTime(pendingRows).slice(0, opts.maxRecentTasks).map((row) => ({
      task: clip(row.task, 80),
      status: String(row.status || 'unknown'),
      at: iso(row.at),
    })),
    recent: sortedByTime(rows).slice(0, opts.maxRecentTasks).map((row) => ({
      task: clip(row.task, 80),
      status: String(row.status || 'unknown'),
      outcome: String(row.outcome || 'unknown'),
      at: iso(row.finishedAt || row.at),
    })),
    works: {
      total: workRows.length,
      running: workStatus.running || 0,
      queued: workStatus.queued || 0,
      done: workStatus.done || 0,
      failed: workStatus.failed || 0,
    },
  };
}

function mediaSummary(imagegen, files, stickers, now, opts) {
  const rows = asArray(imagegen).filter(isObject);
  const okRows = rows.filter((row) => row.ok === true);
  const failedRows = rows.filter((row) => row.ok === false);
  const recentRows = rows.filter((row) => within(row.ts, now, opts.recentDays));
  const latest = [...okRows].sort((a, b) => tsOf(b.ts) - tsOf(a.ts)).slice(0, opts.maxMedia).map((row) => ({
    path: text(row.path),
    prompt: clip(row.prompt, 100),
    at: iso(row.ts),
  }));
  const library = asArray(files).filter(isObject);
  const latestFiles = [...library].sort((a, b) => number(b.mtimeMs) - number(a.mtimeMs))
    .slice(0, opts.maxMedia)
    .map((row) => ({ path: row.path, bytes: number(row.bytes), at: iso(row.mtimeMs) }));
  const stickerRows = asArray(stickers).filter(isObject).map((row) => ({
    id: text(row.id || row.resId),
    label: clip(row.localNote || row.desc || row.id || row.resId, 36),
    annotated: !!(text(row.localNote) || text(row.desc) || asArray(row.tags).length),
    useCount: number(row.useCount),
    lastUsedAt: tsOf(row.lastUsedAt),
  }));
  const used = stickerRows.filter((row) => row.useCount > 0);
  return {
    generated: {
      total: rows.length,
      ok: okRows.length,
      failed: failedRows.length,
      recent7d: recentRows.length,
      lastAt: iso(rows.reduce((max, row) => Math.max(max, tsOf(row.ts)), 0)),
    },
    library: {
      files: library.length,
      bytes: library.reduce((sum, row) => sum + number(row.bytes), 0),
      latest: latestFiles,
    },
    stickers: {
      total: stickerRows.length,
      annotated: stickerRows.filter((row) => row.annotated).length,
      used: used.length,
      top: [...used].sort((a, b) => b.useCount - a.useCount).slice(0, opts.maxStickers)
        .map(({ label, useCount, lastUsedAt }) => ({ label, useCount, lastUsedAt: iso(lastUsedAt) })),
    },
    recent: latest,
  };
}

/**
 * 纯函数：把已经读出来的源数据合成统一模型。
 * @param {object} sources 见 collectOverview 的组装；测试可直接传对象。
 * @param {object} opts now/recentDays/...（DEFAULTS 覆盖）
 */
export function buildOverview(sources = {}, opts = {}) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const now = number(o.now, Date.now());
  const learningSummary = isObject(sources.learningSummary) ? sources.learningSummary : null;
  return {
    version: VERSION,
    generatedAt: iso(now),
    domains: ['learning', 'tasks', 'relations', 'media'],
    windows: { recentDays: o.recentDays, socialDays: o.socialDays },
    learning: {
      available: !!learningSummary,
      at: learningSummary?.at ?? null,
      report: sources.learningReportExists ? 'data/state/learning-report.md' : null,
      summary: learningSummary,
    },
    tasks: taskSummary(sources.tasks, sources.works, now, o),
    relations: {
      people: peopleSummary(sources.people, now, o),
      groups: groupSummary(sources.groupMembers),
      social: socialSummary(sources.socialGraph, now, o),
    },
    media: mediaSummary(sources.imagegen, sources.mediaFiles, sources.stickers, now, o),
  };
}

/** 从真实文件读一遍（只读；不写 overview 文件）。 */
export function collectOverview({
  now = Date.now(),
  paths = defaultOverviewPaths(),
  rootDir = path.resolve(path.dirname(paths.mediaDir), '..'),
  ...opts
} = {}) {
  const learningSummary = readJson(paths.learningSummary);
  const works = readJson(paths.works) ?? readJson(paths.worksAlt);
  const stickerRaw = readJson(paths.stickers);
  return buildOverview({
    learningSummary,
    learningReportExists: exists(paths.learningReport),
    tasks: readJsonl(paths.tasks),
    works: Array.isArray(works) ? works : (works?.works ?? works?.items),
    people: (() => { try { return readPeopleFile(paths.people); } catch { return null; } })(),
    socialGraph: readJson(paths.socialGraph),
    groupMembers: (() => { try { return readPeopleFile(paths.groupMembers); } catch { return null; } })(),
    imagegen: readJsonl(paths.imagegen),
    mediaFiles: scanMedia(paths.mediaDir, rootDir),
    stickers: Array.isArray(stickerRaw) ? stickerRaw : stickerRaw?.items,
  }, { ...DEFAULTS, now, ...opts });
}

/** 给 prompt / 报告用的紧凑文本；没有数据的域也如实写 0，不造暗示。 */
export function renderOverviewText(model, { maxChars = DEFAULTS.maxTextChars } = {}) {
  if (!isObject(model)) return '';
  const t = model.tasks || {};
  const rel = model.relations || {};
  const media = model.media || {};
  const learning = model.learning || {};
  const day = String(model.generatedAt || '').slice(0, 10);
  const lines = [`【跨域总览${day ? ` · ${day}` : ''}】`];

  const pending = t.pending || {};
  const recent = t.recent7d || {};
  lines.push(`任务：共 ${number(t.total)}；在跑 ${number(pending.running)} / 排队 ${number(pending.queued)}；近 7 天成功 ${number(recent.success)} / 失败 ${number(recent.failed)}`);
  const failed = asArray(t.failed)[0];
  if (failed) {
    const why = failed.nextAction || failed.lastError || '没有写下一步';
    lines.push(`待续：${clip(failed.task, 48)}（${clip(why, 60)}）`);
  }

  const people = rel.people || {};
  const social = rel.social || {};
  lines.push(`关系：认识 ${number(people.total)} 人（7 天活跃 ${number(people.active7d)}，有印象 ${number(people.withImpressions)}）；群 ${number(rel.groups?.total)} 个 / 成员 ${number(rel.groups?.members)}`);
  const pair = asArray(social.top)[0];
  if (pair) lines.push(`常来往：${clip(pair.a, 16)} 和 ${clip(pair.b, 16)}（${number(pair.total)} 次）`);

  const generated = media.generated || {};
  const library = media.library || {};
  const stickers = media.stickers || {};
  lines.push(`媒体：生图 ${number(generated.total)} 张（失败 ${number(generated.failed)}，近 7 天 ${number(generated.recent7d)}）；图库 ${number(library.files)} 个文件 / ${(number(library.bytes) / 1024 / 1024).toFixed(1)} MB；表情 ${number(stickers.total)} 个（标注 ${number(stickers.annotated)} / 用过 ${number(stickers.used)}）`);

  const summary = learning.summary;
  if (summary) {
    const lt = summary.tasks || {};
    const li = summary.items || {};
    const lp = summary.practice || {};
    const practiceTotal = Object.values(lp).reduce((sum, n) => sum + number(n), 0);
    lines.push(`学习：任务 ${number(lt.total)}（成功 ${number(lt.success)}）；学习项 ${number(li.total)}（在练 ${number(li.practicing)}）；练习 ${practiceTotal} 次`);
  } else {
    lines.push('学习：暂无 learning-report-summary（先跑 npm run learning:report）');
  }

  const out = lines.join('\n');
  const limit = Math.max(120, number(maxChars, DEFAULTS.maxTextChars));
  return [...out].length > limit ? [...out].slice(0, limit - 1).join('') + '…' : out;
}

/** 人读版（Markdown）；和 JSON 是同一份模型的两种呈现，不另算。 */
export function renderOverviewMarkdown(model) {
  if (!isObject(model)) return '';
  const t = model.tasks || {};
  const rel = model.relations || {};
  const media = model.media || {};
  const learning = model.learning || {};
  const lines = [
    `# 跨域总览 · ${String(model.generatedAt || '').slice(0, 10)}`,
    '',
    '> 只读汇总：任务 / 关系 / 媒体 / 学习。学习侧明细仍看 `learning-report.md`。',
    '',
    '## 任务',
    `- 共 ${number(t.total)} 条；在跑 ${number(t.pending?.running)}、排队 ${number(t.pending?.queued)}`,
    `- 近 7 天：成功 ${number(t.recent7d?.success)} / 失败 ${number(t.recent7d?.failed)} / 共 ${number(t.recent7d?.total)}`,
    `- 分身工作台：共 ${number(t.works?.total)}；在跑 ${number(t.works?.running)}、排队 ${number(t.works?.queued)}、完成 ${number(t.works?.done)}、失败 ${number(t.works?.failed)}`,
    '',
    '## 关系',
    `- 人物：${number(rel.people?.total)} 人；7 天活跃 ${number(rel.people?.active7d)}；有印象 ${number(rel.people?.withImpressions)}`,
    `- 群：${number(rel.groups?.total)} 个 / 成员 ${number(rel.groups?.members)}`,
    ...(asArray(rel.people?.top).slice(0, 3).map((row) => `- 最近见过：${row.name}（${number(row.groups)} 个群${row.lastSeen ? `，${String(row.lastSeen).slice(0, 10)}` : ''}）`)),
    '',
    '## 媒体',
    `- 生图：${number(media.generated?.total)} 张（成功 ${number(media.generated?.ok)} / 失败 ${number(media.generated?.failed)}；近 7 天 ${number(media.generated?.recent7d)}）`,
    `- 图库：${number(media.library?.files)} 个文件 / ${(number(media.library?.bytes) / 1024 / 1024).toFixed(1)} MB`,
    `- 表情：${number(media.stickers?.total)} 个；标注 ${number(media.stickers?.annotated)} / 用过 ${number(media.stickers?.used)}`,
    ...(asArray(media.stickers?.top).map((row) => `- 常用表情：${row.label}（${number(row.useCount)} 次）`)),
    '',
    '## 学习（引用）',
    learning.summary
      ? `- 任务 ${number(learning.summary.tasks?.total)}；学习项 ${number(learning.summary.items?.total)}（在练 ${number(learning.summary.items?.practicing)}）；待定草稿 ${number(learning.summary.drafts?.pending)}`
      : '- 暂无 learning-report-summary.json',
  ];

  if (asArray(t.failed).length) {
    lines.push('', '## 待续');
    for (const row of t.failed) {
      lines.push(`- ${row.task}${row.nextAction ? `｜下一步：${row.nextAction}` : ''}${row.lastError ? `｜上次：${row.lastError}` : ''}`);
    }
  }
  if (asArray(rel.social?.top).length) {
    lines.push('', '## 常来往');
    for (const row of rel.social.top) lines.push(`- ${row.a} 和 ${row.b}（${row.total} 次，${row.group}）`);
  }
  if (asArray(media.recent).length) {
    lines.push('', '## 最近生成');
    for (const row of media.recent) lines.push(`- ${row.path}｜${row.prompt}`);
  }
  return lines.join('\n') + '\n';
}

/** 写 overview.json + overview.md（tmp+rename，避免半截 JSON）。 */
export function writeOverview(model, { stateDir = STATE_DATA_DIR } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const jsonFile = path.join(stateDir, 'overview.json');
  const mdFile = path.join(stateDir, 'overview.md');
  const write = (file, body) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    renameWithRetry(tmp, file);
  };
  write(jsonFile, JSON.stringify(model, null, 2) + '\n');
  write(mdFile, renderOverviewMarkdown(model));
  return { jsonFile, mdFile };
}

/** 读已经落盘的 overview.json；没有/坏掉返回 null（调用方自行决定重建）。 */
export function readOverview(file = stateDataPath('overview.json')) {
  const model = readJson(file);
  return isObject(model) ? model : null;
}
