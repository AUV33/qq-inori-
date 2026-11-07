// 金标单测：src/inori-overview.js（跨域只读总览：模型 / 文件收集 / 文本 / Markdown / 落盘）
//
// 纪律：
//   - 只用 node:test + node:assert/strict，不联网、不启动服务。
//   - 所有 fixture 都在 os.tmpdir 下；collectOverview 传显式 paths，绝不读仓库 data/ 与 state/。
//   - 每个用例用独立临时目录，t.after 清理；文件模块的默认路径靠 QQ_INORI_ROOT 指到临时根。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-inori-overview-'));
process.env.QQ_INORI_ROOT = ROOT;
const ov = await import('../src/domain/leaves/inori-overview.js');

const DAY = 24 * 3600 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

function caseDir(t, name = 'case') {
  const dir = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}
function casePaths(dir) {
  const stateDir = path.join(dir, 'data', 'state');
  return {
    stateDir,
    learningSummary: path.join(stateDir, 'learning-report-summary.json'),
    learningReport: path.join(stateDir, 'learning-report.md'),
    tasks: path.join(stateDir, 'task-ledger.jsonl'),
    works: path.join(stateDir, 'works.json'),
    worksAlt: path.join(dir, 'qq-bridge', 'state', 'works.json'),
    people: path.join(stateDir, 'people.json'),
    socialGraph: path.join(stateDir, 'social-graph.json'),
    groupMembers: path.join(stateDir, 'group-members.json'),
    imagegen: path.join(stateDir, 'imagegen.jsonl'),
    stickers: path.join(dir, 'qq-bridge', 'state', 'stickers.json'),
    mediaDir: path.join(dir, 'media', 'pics'),
  };
}
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ───────────────────────────── 默认路径 / 常量 ─────────────────────────────

test('defaultOverviewPaths / VERSION / DEFAULTS：路径全部来自 project-paths，受 QQ_INORI_ROOT 覆盖', () => {
  const p = ov.defaultOverviewPaths();
  assert.equal(p.stateDir, path.join(ROOT, 'data', 'state'));
  assert.equal(p.learningSummary, path.join(ROOT, 'data', 'state', 'learning-report-summary.json'));
  assert.equal(p.learningReport, path.join(ROOT, 'data', 'state', 'learning-report.md'));
  assert.equal(p.tasks, path.join(ROOT, 'data', 'state', 'task-ledger.jsonl'));
  assert.equal(p.people, path.join(ROOT, 'data', 'state', 'people.json'));
  assert.equal(p.socialGraph, path.join(ROOT, 'data', 'state', 'social-graph.json'));
  assert.equal(p.groupMembers, path.join(ROOT, 'data', 'state', 'group-members.json'));
  assert.equal(p.imagegen, path.join(ROOT, 'data', 'state', 'imagegen.jsonl'));
  assert.equal(p.worksAlt, path.join(ROOT, 'qq-bridge', 'state', 'works.json'));
  assert.equal(p.stickers, path.join(ROOT, 'qq-bridge', 'state', 'stickers.json'));
  assert.equal(p.mediaDir, path.join(ROOT, 'media', 'pics'));
  for (const [key, value] of Object.entries(p)) assert.equal(typeof value, 'string', `${key} 是路径字符串`);

  assert.equal(ov.VERSION, 1);
  assert.equal(Object.isFrozen(ov.DEFAULTS), true, '默认参数冻结，防运行期被改');
  assert.deepEqual(ov.DEFAULTS, {
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
});

// ───────────────────────────── buildOverview：纯函数 ─────────────────────────────

test('buildOverview：空输入给出完整零模型（没有的域如实写 0，不编）', () => {
  const model = ov.buildOverview({}, { now: NOW });
  assert.equal(model.version, 1);
  assert.equal(model.generatedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(model.domains, ['learning', 'tasks', 'relations', 'media']);
  assert.deepEqual(model.windows, { recentDays: 7, socialDays: 45 });
  assert.deepEqual(model.learning, { available: false, at: null, report: null, summary: null });
  assert.deepEqual(model.tasks, {
    total: 0,
    pending: { queued: 0, running: 0 },
    status: {},
    outcome: {},
    recent7d: { total: 0, success: 0, failed: 0 },
    failed: [],
    pendingItems: [],
    recent: [],
    works: { total: 0, running: 0, queued: 0, done: 0, failed: 0 },
  });
  assert.deepEqual(model.relations.people, {
    total: 0, owner: 0, active7d: 0, withImpressions: 0, withNotes: 0, top: [],
  });
  assert.deepEqual(model.relations.groups, { total: 0, members: 0 });
  assert.deepEqual(model.relations.social, { groups: 0, activePairs: 0, top: [] });
  assert.deepEqual(model.media.generated, { total: 0, ok: 0, failed: 0, recent7d: 0, lastAt: null });
  assert.deepEqual(model.media.library, { files: 0, bytes: 0, latest: [] });
  assert.deepEqual(model.media.stickers, { total: 0, annotated: 0, used: 0, top: [] });
  assert.deepEqual(model.media.recent, []);
  assert.doesNotThrow(() => JSON.stringify(model), '模型必须可序列化');
  assert.doesNotThrow(() => ov.buildOverview());
});

test('buildOverview：任务台账——状态/结果计数、待续、最近、分身工作台', () => {
  const tasks = [
    { task: '成功任务', status: 'done', outcome: 'success', finishedAt: NOW - 1 * HOUR },
    { task: '失败任务', status: 'failed', outcome: 'failed', finishedAt: NOW - 2 * HOUR, lastError: '超时' },
    { task: '过期任务', status: 'expired', outcome: 'unknown', finishedAt: NOW - 3 * HOUR, nextAction: '重试' },
    { task: '被卡任务', status: 'done', outcome: 'blocked', at: NOW - 4 * HOUR, note: '依赖缺失' },
    { task: '排队任务', status: 'queued', at: NOW - 5 * HOUR },
    { task: '运行任务', status: 'running', at: NOW - 6 * HOUR },
    { task: '派发任务', status: 'dispatched', at: NOW - 7 * HOUR },
    { task: '旧成功', status: 'done', outcome: 'success', finishedAt: NOW - 10 * DAY },
    { task: '旧失败', status: 'failed', outcome: 'failed', finishedAt: NOW - 9 * DAY },
    { task: '无状态', at: NOW - 8 * HOUR },
    'junk',
    null,
  ];
  const works = { works: [{ status: 'running' }, { status: 'queued' }, { status: 'done' }, { status: 'failed' }, { status: 'unknown' }, 'junk'] };
  const t = ov.buildOverview({ tasks, works }, { now: NOW });

  assert.equal(t.tasks.total, 10, '非对象行被过滤');
  assert.deepEqual(t.tasks.status, {
    done: 3, failed: 2, expired: 1, queued: 1, running: 1, dispatched: 1, unknown: 1,
  });
  assert.deepEqual(t.tasks.outcome, { success: 2, failed: 2, unknown: 5, blocked: 1 });
  assert.deepEqual(t.tasks.pending, { queued: 1, running: 2 });
  assert.deepEqual(t.tasks.recent7d, { total: 8, success: 1, failed: 3 });

  assert.deepEqual(t.tasks.failed.map((row) => row.task), ['失败任务', '过期任务', '被卡任务', '旧失败'],
    '待续按时间倒序、排除成功的');
  assert.equal(t.tasks.failed[0].lastError, '超时');
  assert.equal(t.tasks.failed[0].nextAction, null);
  assert.equal(t.tasks.failed[1].nextAction, '重试');
  assert.equal(t.tasks.failed[1].lastError, null);
  assert.equal(t.tasks.failed[2].lastError, '依赖缺失', 'lastError 缺失时用 note 兜底');
  assert.equal(t.tasks.failed[0].at, new Date(NOW - 2 * HOUR).toISOString());

  assert.deepEqual(t.tasks.pendingItems.map((row) => row.task), ['排队任务', '运行任务', '派发任务']);
  assert.equal(t.tasks.pendingItems[0].at, new Date(NOW - 5 * HOUR).toISOString());

  assert.deepEqual(t.tasks.recent.map((row) => row.task), ['成功任务', '失败任务', '过期任务', '被卡任务', '排队任务']);
  assert.deepEqual(t.tasks.recent[0], {
    task: '成功任务', status: 'done', outcome: 'success', at: new Date(NOW - 1 * HOUR).toISOString(),
  });

  assert.deepEqual(t.tasks.works, { total: 5, running: 1, queued: 1, done: 1, failed: 1 });
});

test('buildOverview：works 的三种形状（works/items/数组）都能读', () => {
  const now = NOW;
  assert.equal(ov.buildOverview({ works: [{ status: 'done' }] }, { now }).tasks.works.total, 1);
  assert.equal(ov.buildOverview({ works: { items: [{ status: 'done' }, { status: 'queued' }] } }, { now }).tasks.works.total, 2);
  assert.equal(ov.buildOverview({ works: { works: [{ status: 'failed' }] } }, { now }).tasks.works.failed, 1);
  assert.equal(ov.buildOverview({ works: null }, { now }).tasks.works.total, 0);
});

test('buildOverview：失败项数量可配、文本清洗/截断、空 nextAction 转 null', () => {
  const tasks = [
    { task: '第一\n任务\u0007', status: 'failed', outcome: 'failed', finishedAt: NOW - 1 * HOUR, lastError: '错误\n行' },
    { task: '第二', status: 'failed', outcome: 'failed', finishedAt: NOW - 2 * HOUR, nextAction: '   ' },
    { task: '第三', status: 'expired', finishedAt: NOW - 3 * HOUR },
    { task: '第四', status: 'failed', outcome: 'blocked', finishedAt: NOW - 4 * HOUR },
  ];
  const t = ov.buildOverview({ tasks }, { now: NOW, maxFailed: 2 });
  assert.equal(t.tasks.failed.length, 2, '最多保留 maxFailed 条');
  assert.equal(t.tasks.failed[0].task, '第一 任务', '换行/控制字符压成空格');
  assert.equal(t.tasks.failed[0].lastError, '错误 行');
  assert.equal(t.tasks.failed[1].nextAction, null, '空白 nextAction 不当内容');
  assert.equal(t.tasks.failed[0].lastError.length <= 100, true);
});

test('buildOverview：人物汇总——总数/主人/活跃/印象/笔记/top 排序与截断', () => {
  const people = {
    10001: {
      id: '10001', aliases: { g1: '小明', g2: '明明' }, owner: true, groups: ['g1', 'g2'],
      lastSeen: NOW - 1 * DAY, impressions: [{}, {}, {}], notes: ['a'],
    },
    10002: { id: '10002', aliases: { g1: '10002' }, lastSeen: NOW - 2 * DAY, impressions: [{ text: 'x' }] },
    10003: { id: '10003', aliases: { g1: '阿三' }, lastSeen: NOW - 10 * DAY },
    10004: { lastSeen: 0, notes: ['a', 'b'] },
    10005: { aliases: 'not object', groups: 'x', impressions: null, notes: 'x', lastSeen: NOW - 3 * DAY },
    bad: 'not-an-object',
  };
  const rel = ov.buildOverview({ people }, { now: NOW }).relations.people;
  assert.equal(rel.total, 5, '非对象人物被跳过');
  assert.equal(rel.owner, 1);
  assert.equal(rel.active7d, 3, 'now-1d/2d/3d 活跃，10d 与 0 不算');
  assert.equal(rel.withImpressions, 2);
  assert.equal(rel.withNotes, 2);

  assert.deepEqual(rel.top.map((row) => row.id), ['10001', '10002', '10005', '10003', '10004']);
  assert.deepEqual(rel.top[0], {
    id: '10001',
    name: '小明',
    owner: true,
    groups: 2,
    lastSeen: new Date(NOW - 1 * DAY).toISOString(),
    impressions: 3,
    notes: 1,
  });
  assert.equal(rel.top[1].name, '10002', '别名是纯数字时用它兜底名字');
  assert.equal(rel.top[4].name, '10004', 'id 缺失时用 key 当 id/名字');
  assert.equal(rel.top[4].lastSeen, null, '时间 0 渲染成 null，不编日期');
  assert.equal(rel.top[2].groups, 0, 'groups 非数组按 0');
  assert.equal(rel.top[2].impressions, 0);

  const capped = ov.buildOverview({ people }, { now: NOW, topPeople: 2 }).relations.people;
  assert.deepEqual(capped.top.map((row) => row.id), ['10001', '10002']);

  // 同一时间按印象数降序
  const tie = ov.buildOverview({
    people: {
      a: { id: 'a', lastSeen: NOW - 1000 },
      b: { id: 'b', lastSeen: NOW - 1000, impressions: [{}, {}] },
    },
  }, { now: NOW }).relations.people;
  assert.deepEqual(tie.top.map((row) => row.id), ['b', 'a']);
});

test('buildOverview：群与社交关系——活跃窗口、最小次数、排序与截断', () => {
  const groupMembers = {
    groups: {
      'group:1': { members: { a: 1, b: 2, c: 3 } },
      'group:2': { members: { d: 1 } },
      'user:x': { members: { e: 1 } },
      'group:bad': { members: 'nope' },
    },
  };
  const socialGraph = {
    groups: {
      g1: {
        pairs: {
          p1: { a: '甲', b: '乙', ab: 3, ba: 2, reply: 4, adjacent: 2, mention: 1, lastAt: NOW - 1 * DAY },
          p2: { a: '丙', b: '丁', ab: 1, ba: 1, lastAt: NOW - 2 * DAY },
          p3: { a: '戊', b: '己', ab: 5, ba: 5, lastAt: NOW - 50 * DAY },
          p4: { a: 'x', b: 'y', ab: 0, ba: 0, lastAt: NOW - 3 * DAY },
          p5: { a: '新', b: '旧', ab: 1, ba: 2, lastAt: NOW - 46 * DAY },
          junk: 5,
        },
      },
      g2: {
        pairs: {
          q1: { a: '子', b: '丑', ab: 2, ba: 1, reply: 1, adjacent: 1, mention: 0, lastAt: NOW - 4 * DAY },
          q2: { a: '寅', b: '卯', ab: 1, ba: 1, lastAt: NOW - 100 * DAY },
        },
      },
    },
  };
  const rel = ov.buildOverview({ groupMembers, socialGraph }, { now: NOW }).relations;
  assert.deepEqual(rel.groups, { total: 3, members: 4 }, '只数 group: 前缀；非法 members 记 0');
  assert.equal(rel.social.groups, 2);
  assert.equal(rel.social.activePairs, 4, '45 天内活跃的对数（含总次数 <3 的）');
  assert.deepEqual(rel.social.top.map((row) => [row.a, row.b, row.total]), [['甲', '乙', 5], ['子', '丑', 3]],
    '只把总次数 ≥3 的放进 top，并按次数降序');
  assert.deepEqual(rel.social.top[0], {
    group: 'g1',
    a: '甲',
    b: '乙',
    total: 5,
    reply: 4,
    adjacent: 2,
    mention: 1,
    lastAt: new Date(NOW - 1 * DAY).toISOString(),
  });
  assert.equal(rel.social.top[1].reply, 1);
  assert.equal(rel.social.top[1].mention, 0);

  const capped = ov.buildOverview({ socialGraph }, { now: NOW, topPairs: 1 }).relations.social;
  assert.equal(capped.top.length, 1);

  // groupMembers 直接是群对象（没有 groups 包一层）也能读
  const direct = ov.buildOverview({ groupMembers: { 'group:z': { members: { q: 1 } } } }, { now: NOW }).relations.groups;
  assert.deepEqual(direct, { total: 1, members: 1 });
});

test('buildOverview：媒体——生图/图库/表情的统计、排序与截断', () => {
  const imagegen = [
    { ts: NOW - 1 * DAY, ok: true, path: 'media/a.png', prompt: '一只猫' },
    { ts: NOW - 2 * DAY, ok: true, path: 'media/b.png', prompt: '一只狗' },
    { ts: NOW - 3 * DAY, ok: false, path: 'media/c.png', prompt: '失败了' },
    { ts: NOW - 10 * DAY, ok: true, path: 'media/d.png', prompt: '旧的' },
    { ts: 'not-a-date', ok: true, path: 'media/e.png', prompt: '时间坏' },
    { ok: true },
    'junk',
  ];
  const mediaFiles = [
    { path: 'media/pics/a.png', bytes: 100, mtimeMs: 1000 },
    { path: 'media/pics/b.png', bytes: '300', mtimeMs: 3000 },
    { path: 'media/pics/c.png', bytes: 50, mtimeMs: 2000 },
    'junk',
  ];
  const stickers = [
    { id: 's1', localNote: '笑', useCount: 5, lastUsedAt: NOW - 1 * DAY, tags: ['a'] },
    { resId: 's2', desc: '哭', useCount: 2, lastUsedAt: NOW - 2 * DAY },
    { id: 's3', useCount: 0 },
    { id: 's4', tags: [], useCount: 0 },
    'junk',
  ];
  const media = ov.buildOverview({ imagegen, mediaFiles, stickers }, { now: NOW }).media;
  assert.deepEqual(media.generated, {
    total: 6,
    ok: 5,
    failed: 1,
    recent7d: 3,
    lastAt: new Date(NOW - 1 * DAY).toISOString(),
  });
  assert.deepEqual(media.recent.map((row) => row.path), ['media/a.png', 'media/b.png', 'media/d.png', 'media/e.png', '']);
  assert.equal(media.recent[3].at, null, '坏时间渲染 null');
  assert.deepEqual(media.recent[0], {
    path: 'media/a.png', prompt: '一只猫', at: new Date(NOW - 1 * DAY).toISOString(),
  });

  assert.deepEqual(media.library, {
    files: 3,
    bytes: 450,
    latest: [
      { path: 'media/pics/b.png', bytes: 300, at: new Date(3000).toISOString() },
      { path: 'media/pics/c.png', bytes: 50, at: new Date(2000).toISOString() },
      { path: 'media/pics/a.png', bytes: 100, at: new Date(1000).toISOString() },
    ],
  });

  assert.deepEqual(media.stickers, {
    total: 4,
    annotated: 2,
    used: 2,
    top: [
      { label: '笑', useCount: 5, lastUsedAt: new Date(NOW - 1 * DAY).toISOString() },
      { label: '哭', useCount: 2, lastUsedAt: new Date(NOW - 2 * DAY).toISOString() },
    ],
  });

  const capped = ov.buildOverview({ imagegen, mediaFiles, stickers }, { now: NOW, maxMedia: 1, maxStickers: 1 }).media;
  assert.equal(capped.recent.length, 1);
  assert.equal(capped.library.latest.length, 1);
  assert.equal(capped.stickers.top.length, 1);
});

test('buildOverview：学习侧只引用 summary；报告只在文件存在时给路径', () => {
  const summary = { at: '2023-11-14T00:00:00.000Z', tasks: { total: 5, success: 4 }, items: { total: 10, practicing: 3 }, practice: { a: 2 } };
  const on = ov.buildOverview({ learningSummary: summary, learningReportExists: true }, { now: NOW }).learning;
  assert.equal(on.available, true);
  assert.equal(on.report, 'data/state/learning-report.md');
  assert.deepEqual(on.summary, summary);

  const off = ov.buildOverview({}, { now: NOW }).learning;
  assert.deepEqual(off, { available: false, at: null, report: null, summary: null });
  const noReport = ov.buildOverview({ learningSummary: summary }, { now: NOW }).learning;
  assert.equal(noReport.report, null, '没有 learning-report.md 就不写路径');
});

// ───────────────────────────── collectOverview：真实文件只读 ─────────────────────────────

/** 写一套完整 fixture；返回 paths（供断言与调用）。 */
function seedWorld(dir, now) {
  const paths = casePaths(dir);
  writeJson(paths.learningSummary, {
    at: new Date(now - 2 * HOUR).toISOString(),
    tasks: { total: 3, success: 2 },
    items: { total: 6, practicing: 1 },
  });
  writeText(paths.learningReport, '# 学习报告\n');
  writeText(paths.tasks, [
    JSON.stringify({ task: '完成的任务', status: 'done', outcome: 'success', finishedAt: now - 1 * HOUR }),
    '这不是 JSON',
    JSON.stringify({ task: '失败的任务', status: 'failed', outcome: 'failed', finishedAt: now - 2 * HOUR, lastError: '炸了' }),
  ].join('\n') + '\n');
  writeJson(paths.worksAlt, { works: [{ status: 'running' }, { status: 'done' }] }); // 主路径缺失 → 走兜底
  writeJson(paths.people, {
    10001: { id: '10001', aliases: { 'group:1': '小明' }, groups: ['group:1'], lastSeen: now - HOUR, impressions: [{}], notes: ['a'] },
  });
  writeJson(paths.socialGraph, {
    groups: { 'group:1': { pairs: { p1: { a: '小明', b: '小红', ab: 2, ba: 2, lastAt: now - HOUR } } } },
  });
  writeJson(paths.groupMembers, { 'group:1': { members: { 10001: { id: '10001' }, 10002: { id: '10002' } } } });
  writeText(paths.imagegen, [
    JSON.stringify({ ts: now - HOUR, ok: true, path: 'media/pics/x.png', prompt: '测试图' }),
    '{坏行',
  ].join('\n') + '\n');
  writeJson(paths.stickers, { items: [{ id: 's1', localNote: '笑', useCount: 1, lastUsedAt: now - HOUR }] });

  // 媒体目录：根 + 3 层内都算，第 4 层不扫
  writeText(path.join(paths.mediaDir, 'root.png'), 'x');
  writeText(path.join(paths.mediaDir, 'd1', 'a.JPG'), 'x');
  writeText(path.join(paths.mediaDir, 'd1', 'd2', 'b.webp'), 'x');
  writeText(path.join(paths.mediaDir, 'd1', 'd2', 'd3', 'c.gif'), 'x');
  writeText(path.join(paths.mediaDir, 'd1', 'd2', 'd3', 'd4', 'deep.png'), 'x');
  writeText(path.join(paths.mediaDir, 'note.txt'), '不是图片');
  return paths;
}

test('collectOverview：读真实文件合成模型、媒体递归扫描、坏文件/坏行跳过、不写 overview', (t) => {
  const dir = caseDir(t, 'collect');
  const paths = seedWorld(dir, NOW);
  const before = fs.readdirSync(paths.stateDir).sort();
  const model = ov.collectOverview({ now: NOW, paths, rootDir: dir });

  assert.equal(model.learning.available, true);
  assert.equal(model.learning.report, 'data/state/learning-report.md');
  assert.equal(model.tasks.total, 2, '坏行被跳过');
  assert.deepEqual(model.tasks.recent7d, { total: 2, success: 1, failed: 1 });
  assert.equal(model.tasks.failed[0].task, '失败的任务');
  assert.deepEqual(model.tasks.works, { total: 2, running: 1, queued: 0, done: 1, failed: 0 }, 'works 主路径缺失走 worksAlt');
  assert.equal(model.relations.people.total, 1);
  assert.equal(model.relations.people.withImpressions, 1);
  assert.deepEqual(model.relations.groups, { total: 1, members: 2 });
  assert.equal(model.relations.social.activePairs, 1);
  assert.deepEqual(model.relations.social.top[0].lastAt, new Date(NOW - HOUR).toISOString());
  assert.equal(model.media.generated.total, 1);
  assert.equal(model.media.generated.lastAt, new Date(NOW - HOUR).toISOString());
  assert.equal(model.media.stickers.total, 1);
  assert.equal(model.media.stickers.top[0].label, '笑');

  assert.equal(model.media.library.files, 4, '根 + 3 层；第 4 层不扫、非图片不算');
  assert.deepEqual(model.media.library.latest.map((row) => row.path).sort(), [
    'media/pics/d1/a.JPG',
    'media/pics/d1/d2/b.webp',
    'media/pics/d1/d2/d3/c.gif',
    'media/pics/root.png',
  ]);
  assert.ok(!model.media.library.latest.some((row) => row.path.includes('deep.png')));
  assert.ok(model.media.library.bytes > 0);

  assert.ok(!fs.existsSync(path.join(paths.stateDir, 'overview.json')), 'collect 只读，不产 overview');
  assert.deepEqual(fs.readdirSync(paths.stateDir).sort(), before, '源目录未被改写');
});

test('collectOverview：源文件损坏/缺失时降级为 0，不让总览整体失败', (t) => {
  const dir = caseDir(t, 'collect-degraded');
  const paths = casePaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writeText(paths.people, '{不是 JSON');
  writeText(paths.socialGraph, 'null');
  writeText(paths.groupMembers, '[]');
  writeText(paths.tasks, '{坏行}\n');
  writeText(paths.imagegen, '');
  writeJson(paths.works, { works: 'not-array' });
  const model = ov.collectOverview({ now: NOW, paths, rootDir: dir });
  assert.equal(model.tasks.total, 0);
  assert.equal(model.relations.people.total, 0);
  assert.equal(model.relations.groups.total, 0);
  assert.equal(model.relations.social.groups, 0);
  assert.equal(model.media.generated.total, 0);
  assert.deepEqual(model.media.library, { files: 0, bytes: 0, latest: [] });
  assert.equal(model.media.stickers.total, 0);
  assert.equal(model.learning.available, false);
});

test('collectOverview：works 数组、缺失的 mediaDir 与默认 opts 都不抛', (t) => {
  const dir = caseDir(t, 'collect-works');
  const paths = casePaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writeJson(paths.works, [{ status: 'queued' }, { status: 'queued' }, { status: 'done' }]);
  const model = ov.collectOverview({ now: NOW, paths, rootDir: dir });
  assert.deepEqual(model.tasks.works, { total: 3, running: 0, queued: 2, done: 1, failed: 0 });
  assert.equal(model.media.library.files, 0, 'mediaDir 不存在 → 空数组');
  assert.doesNotThrow(() => ov.collectOverview({ paths, rootDir: dir }));
});

// ───────────────────────────── renderOverviewText ─────────────────────────────

function fullSources() {
  return {
    learningSummary: {
      at: new Date(NOW - 2 * HOUR).toISOString(),
      tasks: { total: 5, success: 4 },
      items: { total: 10, practicing: 3 },
      practice: { a: 2, b: 3 },
    },
    learningReportExists: true,
    tasks: [
      { task: '成功任务', status: 'done', outcome: 'success', finishedAt: NOW - 1 * HOUR },
      { task: '失败任务', status: 'failed', outcome: 'failed', finishedAt: NOW - 2 * HOUR, lastError: '超时' },
      { task: '过期任务', status: 'expired', outcome: 'unknown', finishedAt: NOW - 3 * HOUR, nextAction: '重试' },
      { task: '排队任务', status: 'queued', at: NOW - 4 * HOUR },
      { task: '运行任务', status: 'running', at: NOW - 5 * HOUR },
    ],
    works: [{ status: 'done' }],
    people: {
      10001: { id: '10001', aliases: { g1: '小明' }, owner: true, groups: ['g1', 'g2'], lastSeen: NOW - 1 * DAY, impressions: [{}], notes: ['a'] },
      10002: { id: '10002', aliases: { g1: '小红' }, lastSeen: NOW - 2 * DAY, impressions: [{}, {}] },
      10003: { id: '10003', aliases: { g1: '阿三' }, lastSeen: NOW - 10 * DAY },
    },
    groupMembers: { 'group:1': { members: { a: 1, b: 2 } } },
    socialGraph: { groups: { g1: { pairs: { p1: { a: '小明', b: '小红', ab: 3, ba: 2, lastAt: NOW - 1 * DAY } } } } },
    imagegen: [
      { ts: NOW - 1 * DAY, ok: true, path: 'media/a.png', prompt: '一只猫' },
      { ts: NOW - 2 * DAY, ok: false, path: 'media/b.png', prompt: '失败了' },
      { ts: NOW - 3 * DAY, ok: true, path: 'media/c.png', prompt: '一只狗' },
    ],
    mediaFiles: [{ path: 'media/pics/a.png', bytes: 450, mtimeMs: NOW - 1000 }],
    stickers: [
      { id: 's1', localNote: '笑', useCount: 5, lastUsedAt: NOW - DAY },
      { id: 's2', desc: '哭', useCount: 0 },
    ],
  };
}

test('renderOverviewText：完整模型每行都带数字；学习侧引用 summary；待续带下一步/上次', () => {
  const model = ov.buildOverview(fullSources(), { now: NOW });
  const text = ov.renderOverviewText(model);
  const lines = text.split('\n');
  assert.equal(lines[0], '【跨域总览 · 2023-11-14】');
  assert.equal(lines[1], '任务：共 5；在跑 1 / 排队 1；近 7 天成功 1 / 失败 2');
  assert.equal(lines[2], '待续：失败任务（超时）', 'failed[0] 没有 nextAction 时用 lastError');
  assert.equal(lines[3], '关系：认识 3 人（7 天活跃 2，有印象 2）；群 1 个 / 成员 2');
  assert.equal(lines[4], '常来往：小明 和 小红（5 次）');
  assert.equal(lines[5], '媒体：生图 3 张（失败 1，近 7 天 3）；图库 1 个文件 / 0.0 MB；表情 2 个（标注 2 / 用过 1）');
  assert.equal(lines[6], '学习：任务 5（成功 4）；学习项 10（在练 3）；练习 5 次');
  assert.equal(lines.length, 7);
});

test('renderOverviewText：无学习 summary / 待续只写「没有写下一步」/ 非对象返回空', () => {
  const noLearn = ov.renderOverviewText(ov.buildOverview({}, { now: NOW }));
  assert.ok(noLearn.includes('学习：暂无 learning-report-summary（先跑 npm run learning:report）'));
  assert.ok(noLearn.includes('任务：共 0；在跑 0 / 排队 0；近 7 天成功 0 / 失败 0'));

  const stuck = ov.buildOverview({
    tasks: [{ task: '卡住', status: 'failed', outcome: 'failed', finishedAt: NOW - 1000 }],
  }, { now: NOW });
  assert.ok(ov.renderOverviewText(stuck).includes('待续：卡住（没有写下一步）'));

  assert.equal(ov.renderOverviewText(null), '');
  assert.equal(ov.renderOverviewText('x'), '');
  assert.equal(ov.renderOverviewText([]), '');
});

test('renderOverviewText：maxChars 生效且下限 120（按码点截断加省略号）', () => {
  const model = ov.buildOverview(fullSources(), { now: NOW });
  const full = ov.renderOverviewText(model);
  assert.ok([...full].length > 120);

  const cut = ov.renderOverviewText(model, { maxChars: 120 });
  assert.equal([...cut].length, 120);
  assert.ok(cut.endsWith('…'));
  assert.equal(cut, [...full].slice(0, 119).join('') + '…');

  const clamped = ov.renderOverviewText(model, { maxChars: 10 });
  assert.equal([...clamped].length, 120, 'maxChars 下限 120');

  assert.equal(ov.renderOverviewText(model, { maxChars: 2000 }), full, '不超限就原样');
});

// ───────────────────────────── renderOverviewMarkdown ─────────────────────────────

test('renderOverviewMarkdown：标题/分节/条件段落（待续、常来往、最近生成）', () => {
  const model = ov.buildOverview(fullSources(), { now: NOW });
  const md = ov.renderOverviewMarkdown(model);
  assert.ok(md.startsWith('# 跨域总览 · 2023-11-14\n'));
  assert.ok(md.endsWith('\n'));
  for (const heading of ['## 任务', '## 关系', '## 媒体', '## 学习（引用）', '## 待续', '## 常来往', '## 最近生成']) {
    assert.ok(md.includes(heading), `包含分节 ${heading}`);
  }
  assert.ok(md.includes('- 共 5 条；在跑 1、排队 1'));
  assert.ok(md.includes('- 近 7 天：成功 1 / 失败 2 / 共 5'));
  assert.ok(md.includes('- 分身工作台：共 1；在跑 0、排队 0、完成 1、失败 0'));
  assert.ok(md.includes('- 人物：3 人；7 天活跃 2；有印象 2'));
  assert.ok(md.includes('- 群：1 个 / 成员 2'));
  assert.ok(md.includes('最近见过：小明（2 个群，2023-11-13）'));
  assert.equal((md.match(/最近见过：/g) || []).length, 3, '人物最近只列 top 3');
  assert.ok(md.includes('- 生图：3 张（成功 2 / 失败 1；近 7 天 3）'));
  assert.ok(md.includes('- 图库：1 个文件 / 0.0 MB'));
  assert.ok(md.includes('- 表情：2 个；标注 2 / 用过 1'));
  assert.ok(md.includes('- 常用表情：笑（5 次）'));
  assert.ok(md.includes('- 任务 5；学习项 10（在练 3）；待定草稿 0'));
  assert.ok(md.includes('- 失败任务｜上次：超时'));
  assert.ok(md.includes('- 过期任务｜下一步：重试'));
  assert.ok(md.includes('- 小明 和 小红（5 次，g1）'));
  assert.ok(md.includes('- media/a.png｜一只猫'));
});

test('renderOverviewMarkdown：空模型也成文、无学习 summary 时如实写、非对象返回空', () => {
  const minimal = ov.renderOverviewMarkdown({ generatedAt: '2023-11-14T22:13:20.000Z' });
  assert.ok(minimal.startsWith('# 跨域总览 · 2023-11-14'));
  assert.ok(minimal.includes('- 暂无 learning-report-summary.json'));
  assert.ok(!minimal.includes('## 待续'), '没有失败项不出现空分节');
  assert.ok(!minimal.includes('## 常来往'));
  assert.ok(!minimal.includes('## 最近生成'));
  assert.equal(ov.renderOverviewMarkdown(null), '');
  assert.equal(ov.renderOverviewMarkdown('x'), '');
  assert.equal(ov.renderOverviewMarkdown([]), '');
});

// ───────────────────────────── writeOverview / readOverview ─────────────────────────────

test('writeOverview：写 overview.json + overview.md（原子、无 tmp 残留），可往返读回', (t) => {
  const stateDir = path.join(caseDir(t, 'write'), 'nested', 'state');
  const model = ov.buildOverview(fullSources(), { now: NOW });
  const { jsonFile, mdFile } = ov.writeOverview(model, { stateDir });
  assert.equal(jsonFile, path.join(stateDir, 'overview.json'));
  assert.equal(mdFile, path.join(stateDir, 'overview.md'));
  assert.ok(fs.existsSync(jsonFile));
  assert.ok(fs.existsSync(mdFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonFile, 'utf8')), model, 'JSON 与模型一致');
  assert.equal(fs.readFileSync(mdFile, 'utf8'), ov.renderOverviewMarkdown(model), 'MD 与渲染函数一致');
  assert.deepEqual(fs.readdirSync(stateDir).filter((f) => f.includes('.tmp')), [], '没有残留临时文件');
  assert.deepEqual(ov.readOverview(jsonFile), model);

  // 覆盖写：旧内容被替换
  const next = ov.buildOverview({}, { now: NOW + DAY });
  ov.writeOverview(next, { stateDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonFile, 'utf8')), next);
  assert.ok(!fs.readFileSync(mdFile, 'utf8').includes('失败任务'));

  // stateDir 是文件 → mkdir 失败必须抛（调用方要知道写不进去）
  const blocked = path.join(caseDir(t, 'write-blocked'), 'file');
  fs.writeFileSync(blocked, 'x');
  assert.throws(() => ov.writeOverview(model, { stateDir: blocked }));
});

test('writeOverview / readOverview：默认路径使用 env 根（临时根），不碰仓库', (t) => {
  t.after(() => fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }));
  const model = ov.buildOverview({}, { now: NOW });
  const { jsonFile, mdFile } = ov.writeOverview(model);
  assert.equal(jsonFile, path.join(ROOT, 'data', 'state', 'overview.json'));
  assert.equal(mdFile, path.join(ROOT, 'data', 'state', 'overview.md'));
  assert.deepEqual(ov.readOverview(), model, 'readOverview 默认读 env 根下的 overview.json');
});

test('readOverview：缺失/损坏/非对象都返回 null，合法对象原样返回', (t) => {
  const dir = caseDir(t, 'read');
  assert.equal(ov.readOverview(path.join(dir, 'missing.json')), null);
  const bad = path.join(dir, 'bad.json');
  writeText(bad, '{oops');
  assert.equal(ov.readOverview(bad), null);
  const arr = path.join(dir, 'array.json');
  writeJson(arr, [1, 2]);
  assert.equal(ov.readOverview(arr), null, '数组不是总览模型');
  const nullJson = path.join(dir, 'null.json');
  writeText(nullJson, 'null');
  assert.equal(ov.readOverview(nullJson), null);
  const good = path.join(dir, 'good.json');
  writeJson(good, { version: 1, generatedAt: '2023-11-14T22:13:20.000Z' });
  assert.deepEqual(ov.readOverview(good), { version: 1, generatedAt: '2023-11-14T22:13:20.000Z' });
  const objectJson = path.join(dir, 'object.json');
  writeText(objectJson, '{}');
  assert.deepEqual(ov.readOverview(objectJson), {}, '空对象也是合法模型');
});
