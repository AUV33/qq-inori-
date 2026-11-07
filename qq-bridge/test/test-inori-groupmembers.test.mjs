// 金标单测：src/inori-groupmembers.js（群成员档案 / 语气画像 / 场景应答 / 渲染）
//
// 纪律：
//   - 只用 node:test + node:assert/strict，不联网、不启动服务。
//   - 所有落盘都在 os.tmpdir 下的临时根（QQ_INORI_ROOT 覆盖 project-paths），不碰仓库 data/ 与 state/。
//   - 每个用例开头 fresh(t)：清空临时 data/，并在 t.after 里再清一次。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-inori-groupmembers-'));
process.env.QQ_INORI_ROOT = ROOT; // 必须在 import 被模块求值前设置（FILE 常量在模块顶层算）

const gm = await import('../src/domain/leaves/inori-groupmembers.js');

const DAY = 24 * 3600 * 1000;
const stateDir = path.join(ROOT, 'data', 'state');
const membersFile = path.join(stateDir, 'group-members.json');
const peopleFile = path.join(stateDir, 'people.json');

function resetStores() {
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
}
function fresh(t) {
  resetStores();
  t.after(() => resetStores());
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function seedMembers(db) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(membersFile, JSON.stringify(db), 'utf8');
}
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ───────────────────────────── detectMemberShift（纯函数） ─────────────────────────────

test('detectMemberShift：平时说话 / 空输入 / 样本不足都不算「不一样」', () => {
  const base = { count: 11, repliesToMe: 0, voice: { n: 10, chars: 100 } };
  assert.deepEqual(gm.detectMemberShift(base, '还行吧今天'), [], '5 字 ≈ 平时 10 字，不算异常');
  assert.deepEqual(gm.detectMemberShift(base, ''), [], '空文本不判定');
  assert.deepEqual(gm.detectMemberShift(undefined, undefined), [], '默认参数不抛');
  const rooky = { count: 9, voice: { n: 9, chars: 90 } }; // prevCount=8 < 10
  assert.deepEqual(
    gm.detectMemberShift(rooky, '我这两天其实一直在想这个事觉得还是得把话说清楚比较好'),
    [],
    '样本 <10 条时说话长也不下判断',
  );
});

test('detectMemberShift：长句/短句的阈值边界（3 倍、样本 10、平均 8 字）', () => {
  const m = (over = {}) => ({ count: 11, repliesToMe: 0, voice: { n: 10, chars: 30 }, ...over });
  // 平均 3 字，prevCount=10
  assert.deepEqual(gm.detectMemberShift(m(), '一二三四五六'), [], '6 字未超过 3 倍（6 > 9 才触发）');
  assert.deepEqual(
    gm.detectMemberShift(m(), '一二三四五六七八九十'),
    ['说话比平时长很多（10 字，平时 3 字）'],
  );
  assert.deepEqual(gm.detectMemberShift(m({ voice: { n: 10, chars: 29 } }), '一二三四五六七八九十'), [],
    '平均不足 3 字不做「长很多」判定');
  // 短句：平均 8 字，len*4 < avg 才触发
  const avg8 = m({ voice: { n: 10, chars: 80 } });
  assert.deepEqual(gm.detectMemberShift(avg8, '哦哦'), [], '2 字 *4 = 8，不严格小于平均 8');
  assert.deepEqual(gm.detectMemberShift(avg8, '哦'), ['突然只说几个字']);
  const avg7 = m({ voice: { n: 10, chars: 70 } });
  assert.deepEqual(gm.detectMemberShift(avg7, '哦'), [], '平均不足 8 字不判短句');
  const avg9 = m({ voice: { n: 10, chars: 90 } });
  assert.deepEqual(gm.detectMemberShift(avg9, '哦哦'), ['突然只说几个字']);
});

test('detectMemberShift：第一次回你优先，压掉句长噪音，但保留「久别」', () => {
  const at = Date.UTC(2025, 0, 1);
  const longText = '我这两天其实一直在想这个事觉得还是得把话说清楚比较好';
  const m = { count: 31, repliesToMe: 1, voice: { n: 30, chars: 300 } };
  assert.deepEqual(
    gm.detectMemberShift(m, longText, { quoteTargetIsSelf: true, at }),
    ['第一次回你'],
    '第一次回你本身就是大事，不再补「说话长」',
  );
  assert.deepEqual(
    gm.detectMemberShift({ ...m, lastSeenBefore: at - 8 * DAY }, longText, { quoteTargetIsSelf: true, at }),
    ['第一次回你', '很久没出现，又来了'],
  );
  assert.deepEqual(
    gm.detectMemberShift({ ...m, lastSeenBefore: at - 7 * DAY }, '嗯', { quoteTargetIsSelf: true, at }),
    ['第一次回你'],
    '刚好 7 天不算「很久没出现」（要求严格大于）',
  );
  assert.deepEqual(gm.detectMemberShift({ ...m, repliesToMe: 1 }, '还行吧今天', { quoteTargetIsSelf: false, at }), [],
    '不是回复她时，repliesToMe=1 也不判第一次');
  assert.deepEqual(gm.detectMemberShift({ ...m, repliesToMe: 2 }, '还行吧今天', { quoteTargetIsSelf: true, at }), [],
    '第 2 次回她不算第一次');
  assert.deepEqual(
    gm.detectMemberShift({ count: 31, repliesToMe: 1, voice: { n: 30, chars: 300 }, lastSeenBefore: at - 9 * DAY },
      '嗯', { quoteTargetIsSelf: true, at }),
    ['第一次回你', '很久没出现，又来了'],
    '第一次 + 久别各算一条',
  );
});

// ───────────────────────────── noteMember ─────────────────────────────

test('noteMember：非群 key / 缺 userId / 自己发言都返回 null，且不落盘', (t) => {
  fresh(t);
  assert.equal(gm.noteMember(undefined, { userId: 'u1' }), null, 'undefined key 不是 group: 开头');
  assert.equal(gm.noteMember('user:1', { userId: 'u1' }), null, '非群会话不学成员档案');
  assert.equal(gm.noteMember('group:gm-null', { name: '无名' }), null, '缺 userId');
  assert.equal(gm.noteMember('group:gm-null', { userId: 'u1', isSelf: true }), null, '她自己的话不进学习侧');
  assert.equal(fs.existsSync(membersFile), false, '失败路径不该创建群成员库');
  assert.equal(fs.existsSync(peopleFile), false, '失败路径不该创建人物索引');
});

test('noteMember：第一次记录建立完整档案并同步进人物索引', (t) => {
  fresh(t);
  const G = 'group:gm-basic';
  const at = 1_700_000_000_000;
  const m = gm.noteMember(G, {
    userId: 'u1', name: '小明', text: '今天好累', at, hasMedia: true, quoteTargetIsSelf: true,
  });
  assert.equal(m.id, 'u1');
  assert.equal(m.name, '小明');
  assert.equal(m.count, 1);
  assert.equal(m.media, 1);
  assert.equal(m.repliesToMe, 1);
  assert.equal(m.firstSeen, at);
  assert.equal(m.lastSeen, at);
  assert.equal(m.lastSeenBefore, at);
  assert.equal(m.lastText, '今天好累');
  assert.deepEqual(m.notes, []);

  const disk = readJson(membersFile);
  assert.deepEqual(disk[G].members.u1, m, '返回对象就是落盘的那份档案');

  const people = readJson(peopleFile);
  assert.deepEqual(people.u1.aliases, { [G]: '小明' }, '昵称按群记进 aliases');
  assert.deepEqual(people.u1.groups, [G]);
  assert.equal(people.u1.count, 1);
});

test('noteMember：累计计数、firstSeen 不被覆盖、lastText 截 60、名字清洗 + 「我」不覆盖', (t) => {
  fresh(t);
  const G = 'group:gm-acc';
  const at1 = 1_700_000_000_000;
  const at2 = at1 + 60_000;
  gm.noteMember(G, { userId: 'u2', name: '小明', text: '在', at: at1 });
  const m = gm.noteMember(G, { userId: 'u2', name: '我', text: 'x'.repeat(70), at: at2 });
  assert.equal(m.count, 2);
  assert.equal(m.firstSeen, at1, 'firstSeen 只在第一次写');
  assert.equal(m.lastSeen, at2);
  assert.equal(m.name, '小明', 'name=我 不覆盖已有昵称');
  assert.equal(m.lastText.length, 60, 'lastText 截 60 字');
  assert.equal(m.lastText, 'x'.repeat(60));

  // 彩色/控制码昵称：清洗后再进档案（NAME-CLEAN）
  const dirty = gm.noteMember(G, { userId: 'u3', name: '\n\t\u0007阿强\u0010$ÿĀ', text: '在', at: at2 });
  assert.equal(dirty.name, '阿强');
});

test('noteMember：facts 相似去重、上限 5、空值忽略、单条截 80', (t) => {
  fresh(t);
  const G = 'group:gm-facts';
  const at = 1_700_000_000_000;
  const longFact = '他' + '很'.repeat(99); // 100 字
  gm.noteMember(G, {
    userId: 'u4', name: '事实', text: '嗯', at,
    facts: [
      '他养了一只猫',
      '他养了一只小狗', // 与上一句二元组相似度 ≈0.73 ≥0.5，应被去重
      '他住在杭州',
      '他喜欢跑步',
      '他有个妹妹',
      '他在上学', // 第 5 条不同事实，仍能入档（上限 5）
      '他在上班', // 第 6 条：已到上限被丢
      '',
      null,
    ],
  });
  let notes = gm.topMembers(G)[0].notes;
  assert.equal(notes.length, 5);
  assert.equal(notes[0], '他养了一只猫');
  assert.ok(!notes.includes('他养了一只小狗'), '相似事实不重复记');
  assert.ok(notes.includes('他在上学'), '第 5 条不同事实仍收');
  assert.ok(!notes.includes('他在上班'), '上限 5 条，第 6 条不同事实被丢');
  assert.deepEqual(notes.slice(1), ['他住在杭州', '他喜欢跑步', '他有个妹妹', '他在上学'],
    '不同事实按到达顺序保留到上限');

  const m = gm.noteMember(G, { userId: 'u5', name: '长事实', text: '嗯', at, facts: [longFact] });
  assert.equal(m.notes.length, 1);
  assert.equal(m.notes[0].length, 80, '单条事实截 80 字');
});

test('noteMember：语气特征按消息累计（句长/提问/感叹/表情/哈哈/语气词）', (t) => {
  fresh(t);
  const G = 'group:gm-voice';
  const at = 1_700_000_000_000;
  let m;
  for (let i = 0; i < 5; i += 1) {
    m = gm.noteMember(G, { userId: 'uv', name: '声', text: '为什么呀', at: at + i });
  }
  assert.deepEqual(m.voice, { n: 5, chars: 20, short: 5, q: 5, p: { 呀: 5 } });
  // 渲染：短句型 + 老提问（样本 ≥5 才出）
  assert.match(gm.renderMembers(G, 5), /语气短句型、老提问/);

  const G2 = 'group:gm-voice2';
  for (let i = 0; i < 5; i += 1) {
    m = gm.noteMember(G2, { userId: 'vw', name: '氛', text: '哈哈[表情1]', at: at + i });
  }
  assert.equal(m.voice.em, 5, '方括号表情算表情');
  assert.equal(m.voice.laugh, 5);
  assert.equal(m.voice.p['哈'], 10);
  assert.match(gm.renderMembers(G2, 5), /语气短句型、氛围组/);

  const G3 = 'group:gm-voice3';
  for (let i = 0; i < 5; i += 1) {
    m = gm.noteMember(G3, { userId: 'ew', name: '叹', text: '好呀！', at: at + i });
  }
  assert.equal(m.voice.ex, 5, '感叹号计数');
  assert.match(gm.renderMembers(G3, 5), /语气短句型、感叹多/);
});

test('noteMember：被提问后接话→认真答；抱怨后接话→安慰（场景窗口内归因）', (t) => {
  fresh(t);
  const G = 'group:gm-resp';
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 3; i += 1) {
    gm.noteMember(G, { userId: 'q1', name: '小明', text: '为什么天是蓝的?', at: t0 + i * 1000 });
    const m = gm.noteMember(G, { userId: 'p1', name: '小红', text: '小明，天是蓝色因为光散射', at: t0 + i * 1000 + 500 });
    assert.equal(m.resp.ask, i + 1);
    assert.equal(m.resp.ask_answer, i + 1);
  }
  for (let i = 0; i < 3; i += 1) {
    gm.noteMember(G, { userId: 'q1', name: '小明', text: '好烦啊今天又加班', at: t0 + 10_000 + i * 1000 });
    gm.noteMember(G, { userId: 'p1', name: '小红', text: '小明，加班确实挺累的早点休息', at: t0 + 10_000 + i * 1000 + 500 });
  }
  const p = gm.topMembers(G).find((x) => x.id === 'p1');
  assert.deepEqual(p.resp, { ask: 3, ask_answer: 3, cm: 3, cm_assess: 3 });
  const out = gm.renderMembers(G, 5);
  assert.match(out, /被问时（3 次）多半认真答——爱把事说清楚/);
  assert.match(out, /有人抱怨时多半安慰或讲道理（直球或解题型）/);
});

test('noteMember：反问/打哈哈/岔开三种应对也按场景分类', (t) => {
  fresh(t);
  const t0 = 1_700_000_000_000;

  // 被提问 → 反问（带问号）
  const G1 = 'group:gm-resp-rebut';
  for (let i = 0; i < 3; i += 1) {
    gm.noteMember(G1, { userId: 'q1', name: '小明', text: '为什么天是蓝的?', at: t0 + i * 1000 });
    gm.noteMember(G1, { userId: 'p1', name: '小红', text: '小明你说呢?', at: t0 + i * 1000 + 500 });
  }
  let p = gm.topMembers(G1).find((x) => x.id === 'p1');
  assert.equal(p.resp.ask_rebut, 3);
  assert.match(gm.renderMembers(G1, 5), /被问时（3 次）多半反问回去/);

  // 被抱怨 → 跟着哈哈
  const G2 = 'group:gm-resp-laugh';
  for (let i = 0; i < 3; i += 1) {
    gm.noteMember(G2, { userId: 'q1', name: '小明', text: '好烦啊今天又加班', at: t0 + i * 1000 });
    gm.noteMember(G2, { userId: 'p1', name: '小红', text: '哈哈小明说得对', at: t0 + i * 1000 + 500 });
  }
  p = gm.topMembers(G2).find((x) => x.id === 'p1');
  assert.equal(p.resp.cm_laugh, 3);
  assert.match(gm.renderMembers(G2, 5), /有人抱怨时多半跟着哈哈（合拍型）/);

  // 被提问 → 岔开（太短，判不准具体在回应什么）
  const G3 = 'group:gm-resp-dodge';
  for (let i = 0; i < 3; i += 1) {
    gm.noteMember(G3, { userId: 'q1', name: '小明', text: '为什么天是蓝的?', at: t0 + i * 1000 });
    gm.noteMember(G3, { userId: 'p1', name: '小红', text: '小明早', at: t0 + i * 1000 + 500 });
  }
  p = gm.topMembers(G3).find((x) => x.id === 'p1');
  assert.equal(p.resp.ask_dodge, 3);
  assert.match(gm.renderMembers(G3, 5), /被问时（3 次）常岔开话题/);
});

test('noteMember：场景窗口外 / 消息没点名 / 场景不是提问抱怨 → 不归因', (t) => {
  fresh(t);
  const t0 = 1_700_000_000_000;
  const G = 'group:gm-resp-window';
  gm.noteMember(G, { userId: 'q1', name: '小明', text: '为什么天是蓝的?', at: t0 });
  const late = gm.noteMember(G, { userId: 'p1', name: '小红', text: '小明，天是蓝色因为光散射', at: t0 + 16 * 60 * 1000 });
  assert.equal(late.resp, undefined, '16 分钟前的问题已出窗口（窗口 15 分钟）');

  const G2 = 'group:gm-resp-noname';
  gm.noteMember(G2, { userId: 'q1', name: '小明', text: '为什么天是蓝的?', at: t0 });
  const noName = gm.noteMember(G2, { userId: 'p1', name: '小红', text: '天是蓝色因为光散射啊', at: t0 + 1000 });
  assert.equal(noName.resp, undefined, '没点名就不猜「他在回应谁」');

  const G3 = 'group:gm-resp-topic';
  gm.noteMember(G3, { userId: 'q1', name: '小明', text: '今天天气不错我们出去走走吧', at: t0 }); // topic 不入场景
  const topic = gm.noteMember(G3, { userId: 'p1', name: '小红', text: '小明今天天气确实不错我们走吧', at: t0 + 1000 });
  assert.equal(topic.resp, undefined, '普通话题不算提问/抱怨场景');
});

test('noteMember：第一次回她落 shift 事实，渲染时带「想改就改」', (t) => {
  fresh(t);
  const G = 'group:gm-shift';
  const at = Date.now() - 60_000;
  const m = gm.noteMember(G, { userId: 'us', name: '回', text: '第一次跟你说话', quoteTargetIsSelf: true, at });
  assert.deepEqual(m.shift, { kinds: ['第一次回你'], text: '第一次跟你说话', at });
  const out = gm.renderMembers(G, 5);
  assert.match(out, /有点不一样：第一次回你（原话：第一次跟你说话）/);
  assert.match(out, /想改对他的印象就改/);
});

test('renderMembers：超过 3 天的旧 shift 不再提示', (t) => {
  fresh(t);
  const G = 'group:gm-shift-old';
  gm.noteMember(G, { userId: 'uold', name: '旧', text: '嗯', at: Date.now() - 60_000 });
  const db = readJson(membersFile);
  db[G].members.uold.shift = { kinds: ['第一次回你'], text: '嗯', at: Date.now() - 4 * DAY };
  seedMembers(db);
  const out = gm.renderMembers(G, 5);
  assert.ok(out.includes('旧（QQ uold'), '本人仍会渲染');
  assert.ok(!out.includes('有点不一样'), '过期 shift 不再让她改印象');
});

test('topMembers：按发言量排序、默认前 5、未知群/空群返回空数组', (t) => {
  fresh(t);
  const G = 'group:gm-top';
  const at = 1_700_000_000_000;
  for (let i = 1; i <= 7; i += 1) {
    for (let c = 0; c < i; c += 1) {
      gm.noteMember(G, { userId: `t${i}`, name: `人${i}`, text: '在', at: at + c });
    }
  }
  assert.deepEqual(gm.topMembers(G).map((m) => m.id), ['t7', 't6', 't5', 't4', 't3']);
  assert.deepEqual(gm.topMembers(G, 2).map((m) => m.id), ['t7', 't6']);
  assert.deepEqual(gm.topMembers(G, 0), []);
  assert.deepEqual(gm.topMembers('group:gm-top-none'), []);
  seedMembers({ 'group:gm-top-empty': { members: {} } });
  assert.deepEqual(gm.topMembers('group:gm-top-empty'), []);
});

test('写入修剪：每群成员最多 200，按 lastSeen 淘汰最旧的', (t) => {
  fresh(t);
  const G = 'group:gm-trim';
  const members = {};
  for (let i = 1; i <= 205; i += 1) {
    members[`m${i}`] = { id: `m${i}`, name: `人${i}`, count: i, lastSeen: i };
  }
  seedMembers({ [G]: { members } });
  gm.noteMember(G, { userId: 'new', name: '新', text: '在', at: Date.now() });
  const disk = readJson(membersFile)[G].members;
  assert.equal(Object.keys(disk).length, 200);
  assert.equal(disk.new.count, 1, '新成员保留');
  for (let i = 1; i <= 6; i += 1) assert.equal(disk[`m${i}`], undefined, `最旧的 m${i} 被修剪`);
  assert.ok(disk.m7, '第 7 旧的保留（206 - 200 = 6 条被删）');
  assert.ok(disk.m205);
});

test('memberNickLookup：全等优先 → 包含匹配按发言量 → 过短/未知返回 null', (t) => {
  fresh(t);
  const G = 'group:gm-nick';
  seedMembers({
    [G]: {
      members: {
        101: { id: '101', name: '小明', count: 5 },
        102: { id: '102', name: '小明同学', count: 50 },
        103: { id: '103', name: '小红', count: 1 },
      },
    },
  });
  assert.equal(gm.memberNickLookup(G, '小明').id, '101', '全等优先，即使发言量不是最高');
  assert.equal(gm.memberNickLookup(G, ' 小明 ').id, '101', '输入会 trim');
  assert.equal(gm.memberNickLookup(G, '小明同学').id, '102');
  assert.equal(gm.memberNickLookup(G, '小明同').id, '102', '包含匹配按发言量取第一');
  assert.equal(gm.memberNickLookup(G, '小红红').id, '103', '输入包含档案名也算命中');
  assert.equal(gm.memberNickLookup(G, '小'), null, '昵称 <2 字不查');
  assert.equal(gm.memberNickLookup(G, ''), null);
  assert.equal(gm.memberNickLookup('group:gm-nick-none', '小明'), null);
  seedMembers({ 'group:gm-nick-nomembers': {} });
  assert.equal(gm.memberNickLookup('group:gm-nick-nomembers', '小明'), null);
});

test('memberTags：四条规则独立命中、组合保持固定顺序', () => {
  assert.deepEqual(gm.memberTags({}), ['新人']);
  assert.deepEqual(gm.memberTags({ count: 2 }), ['新人']);
  assert.deepEqual(gm.memberTags({ count: 20 }), ['话多']);
  assert.deepEqual(gm.memberTags({ count: 21, repliesToMe: 2, media: 3 }), ['常接你的话', '爱发图', '话多']);
  assert.deepEqual(gm.memberTags({ count: 2, media: 3 }), ['爱发图', '新人']);
  assert.deepEqual(gm.memberTags({ count: 19, repliesToMe: 1, media: 2 }), []);
});

test('renderMembers：空库返回空串；正常渲染带身份/统计/标签/笔记/软措辞脚注', (t) => {
  fresh(t);
  assert.equal(gm.renderMembers('group:gm-render-none', 5), '');
  const G = 'group:gm-render';
  const at = 1_700_000_000_000;
  for (let i = 0; i < 20; i += 1) {
    gm.noteMember(G, {
      userId: 'ur', name: '阿强', text: '在', at: at + i,
      ...(i === 0 ? { facts: ['他养了猫', '他住在杭州'] } : {}),
    });
  }
  const out = gm.renderMembers(G, 5);
  assert.ok(out.startsWith('【这个群里的人】'));
  assert.ok(out.includes('阿强（QQ ur｜发言 20 次，话多；知道他事：他养了猫；他住在杭州'), '头行带昵称/QQ/次数/标签/最近两条笔记');
  assert.ok(out.includes('；语气短句型）'), '语气画像拼在头行末尾');
  assert.ok(out.includes('· QQ：ur'));
  assert.ok(!out.includes('跟他还没熟'), '20 次发言不该推「还没熟」');
  assert.ok(out.endsWith('）'), '脚注闭合');
  assert.ok(out.includes('「档案」是你自己学到的'));
  assert.ok(out.includes('「指引」是统计推的（多半/估计）'));
  assert.ok(!out.includes('，主人'));
  assert.ok(!out.includes('另一个 bot'));

  assert.ok(gm.renderMembers(G, 5, 'ur').includes('阿强（QQ ur，主人｜'), 'ownerId 命中标主人');
  const bot = gm.renderMembers(G, 5, '', { botIds: ['ur'] });
  assert.ok(bot.includes('，另一个 bot｜'), 'botIds 命中在头行标出');
  assert.ok(bot.includes('· QQ：ur（另一个 bot，不是人）'));
  assert.ok(bot.includes('它是另一个 bot（AI），不是人：别跟它客套'));
});

test('renderMembers：focusIds 按「最近在说话」顺序，只认本群、按 n 截断', (t) => {
  fresh(t);
  const G = 'group:gm-focus';
  seedMembers({
    [G]: {
      members: {
        a1: { id: 'a1', name: '甲', count: 30 },
        a2: { id: 'a2', name: '乙', count: 20 },
        a3: { id: 'a3', name: '丙', count: 10 },
        a4: { id: 'a4', name: '丁', count: 5 },
      },
    },
  });
  const plain = gm.renderMembers(G, 2);
  assert.ok(plain.indexOf('QQ a1') < plain.indexOf('QQ a2'));
  assert.ok(!plain.includes('QQ a3'), '无 focus 时按发言量取前 n');

  const focused = gm.renderMembers(G, 2, '', { focusIds: ['a4', 'a1', 'nope', 'a2'] });
  assert.ok(focused.indexOf('QQ a4') < focused.indexOf('QQ a1'), 'focus 顺序优先于发言量');
  assert.ok(!focused.includes('QQ a2'), 'n 截断后只留前两个 focus');
  assert.ok(!focused.includes('QQ nope'), '不存在的 focus 跳过');

  assert.equal(gm.renderMembers(G, 2, '', { focusIds: ['nope'] }), '', 'focus 全查不到 → 不渲染');
});

test('renderMembers：跨群别名 + 持久印象（同文去重、旧条数折叠）一起进提示', async (t) => {
  fresh(t);
  const A = 'group:gm-pA';
  const B = 'group:gm-pB';
  const at = 1_700_000_000_000;
  gm.noteMember(A, { userId: 'u7', name: '阿明', text: '在', at });
  gm.noteMember(B, { userId: 'u7', name: '明明', text: '在', at: at + 1 });
  const people = await import('../src/domain/leaves/inori-people.js');
  people.noteImpression('u7', { text: '爱抬杠', from: A, at });
  people.noteImpression('u7', { text: '爱抬杠。', from: A, at: at + 1 }); // 归一化后同一句
  const out = gm.renderMembers(A, 5);
  assert.ok(out.includes('他在另一个群也出现过（那边叫「明明」）'));
  assert.ok(out.includes('你印象里：爱抬杠。（记于 group:gm-pA）'), '同文只留最新一条');
  assert.ok(out.includes('关于他你还记过 1 条旧印象'));
});

test('renderMembers：people.json 损坏时降级为「只有身份行」，不抛', (t) => {
  fresh(t);
  const G = 'group:gm-corrupt-people';
  gm.noteMember(G, { userId: 'uc', name: '坏', text: '在', at: 1_700_000_000_000 });
  fs.writeFileSync(peopleFile, '{这不是 JSON', 'utf8');
  const out = gm.renderMembers(G, 5);
  assert.ok(out.includes('坏（QQ uc｜发言 1 次'), '群成员库仍可读');
  assert.ok(out.includes('· QQ：uc'));
  assert.ok(!out.includes('他在另一个群'));
  assert.ok(!out.includes('· 你印象里'));
});

test('群成员库损坏时读路径降级为空库，下一次写入重建为合法 JSON', (t) => {
  fresh(t);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(membersFile, '{这不是 JSON', 'utf8');
  assert.deepEqual(gm.topMembers('group:gm-corrupt-store', 5), [], '坏文件当空库，不抛');
  assert.equal(gm.memberNickLookup('group:gm-corrupt-store', '小明'), null);
  const m = gm.noteMember('group:gm-corrupt-store', {
    userId: 'u1', name: '小明', text: '在', at: 1_700_000_000_000,
  });
  assert.equal(m.count, 1);
  const disk = readJson(membersFile);
  assert.equal(disk['group:gm-corrupt-store'].members.u1.count, 1, '坏文件被重建为合法 JSON');
});

test('持久化往返：写盘后被另一个进程按 env 根目录重新读回', (t) => {
  fresh(t);
  const G = 'group:gm-round';
  const at = 1_700_000_000_000;
  gm.noteMember(G, { userId: 'u-round', name: '往返', text: '你好', at, hasMedia: true });

  const modUrl = pathToFileURL(path.join(BRIDGE, 'src', 'domain', 'leaves', 'inori-groupmembers.js')).href;
  const code = `const gm = await import(${JSON.stringify(modUrl)});\nprocess.stdout.write(JSON.stringify(gm.topMembers(${JSON.stringify(G)}, 5)));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: BRIDGE,
    env: { ...process.env, QQ_INORI_ROOT: ROOT },
    encoding: 'utf8',
  });
  const top = JSON.parse(out);
  assert.equal(top.length, 1);
  assert.equal(top[0].id, 'u-round');
  assert.equal(top[0].name, '往返');
  assert.equal(top[0].count, 1);
  assert.equal(top[0].media, 1);
  assert.equal(top[0].lastText, '你好');
  const disk = readJson(membersFile);
  assert.deepEqual(disk[G].members['u-round'], top[0], 'JSON 结构与返回值一致');
});

test('加密群成员库：落盘是信封，读端仍能按昵称查成员', (t) => {
  fresh(t);
  const key = Buffer.alloc(32, 7).toString('hex');
  process.env.QQ_INORI_PEOPLE_ENCRYPT = '1';
  process.env.QQ_INORI_PEOPLE_KEY = key;
  try {
    const m = gm.noteMember('group:gm-enc', { userId: 'u-enc', name: '加密', text: '你好', at: 1_700_000_000_000 });
    assert.equal(m.id, 'u-enc');
    const raw = fs.readFileSync(membersFile, 'utf8');
    assert.equal(raw.includes('u-enc'), false, '不得出现 QQ 号明文');
    assert.equal(raw.includes('加密'), false, '不得出现昵称明文');
    assert.equal(JSON.parse(raw).v, 2, '应为 v2 信封');
    assert.equal(gm.memberNickLookup('group:gm-enc', '加密')?.id, 'u-enc');

    const before = fs.readFileSync(membersFile, 'utf8');
    delete process.env.QQ_INORI_PEOPLE_KEY; // 密钥丢失
    gm.noteMember('group:gm-enc', { userId: 'u-enc', name: '加密', text: '再写一次', at: 1_700_000_001_000 });
    assert.equal(fs.readFileSync(membersFile, 'utf8'), before, '无密钥不得用空库覆盖密文');
  } finally {
    delete process.env.QQ_INORI_PEOPLE_ENCRYPT;
    delete process.env.QQ_INORI_PEOPLE_KEY;
  }
});
