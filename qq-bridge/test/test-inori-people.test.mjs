// 金标单测：src/inori-people.js（全局人物索引：跨群归一 / 持久印象 / 应答指引 / 档案）
//
// 纪律：
//   - 只用 node:test + node:assert/strict，不联网、不启动服务。
//   - 所有落盘都在 os.tmpdir 下的临时根（QQ_INORI_ROOT 覆盖 project-paths），不碰仓库 data/ 与 state/。
//   - 每个用例开头 fresh(t)：清空临时 data/，并在 t.after 里再清一次。
//   - owner 判定来自 QQ_INORI_OWNER_QQ，必须在 import 前设置（OWNER_ID 是模块顶层常量）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-inori-people-'));
process.env.QQ_INORI_ROOT = ROOT;
process.env.QQ_INORI_OWNER_QQ = '99999';

const pp = await import('../src/domain/leaves/inori-people.js');

const DAY = 24 * 3600 * 1000;
const stateDir = path.join(ROOT, 'data', 'state');
const peopleFile = path.join(stateDir, 'people.json');
const groupMembersFile = path.join(stateDir, 'group-members.json');

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
function seedPeople(db) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(peopleFile, JSON.stringify(db), 'utf8');
}
function seedGroupMembers(db) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(groupMembersFile, JSON.stringify(db), 'utf8');
}
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ───────────────────────────── upsertFromGroup ─────────────────────────────

test('upsertFromGroup：空对象 / 缺 id 返回 null，且不创建文件', (t) => {
  fresh(t);
  assert.equal(pp.upsertFromGroup('group:1', null), null);
  assert.equal(pp.upsertFromGroup('group:1', undefined), null);
  assert.equal(pp.upsertFromGroup('group:1', {}), null);
  assert.equal(pp.upsertFromGroup('group:1', { id: '' }), null);
  assert.equal(fs.existsSync(peopleFile), false);
});

test('upsertFromGroup：首次建立档案（别名/群/计数/时间都落盘）', (t) => {
  fresh(t);
  const p = pp.upsertFromGroup('group:1', {
    id: '10001', name: '小明', count: 5, firstSeen: 1000, lastSeen: 2000,
  });
  assert.equal(p.id, '10001');
  assert.equal(p.owner, false, '不是 owner QQ');
  assert.deepEqual(p.aliases, { 'group:1': '小明' });
  assert.deepEqual(p.groups, ['group:1']);
  assert.deepEqual(p.perGroup, { 'group:1': 5 });
  assert.equal(p.count, 5);
  assert.equal(p.firstSeen, 1000);
  assert.equal(p.lastSeen, 2000);
  assert.deepEqual(p.notes, []);
  assert.deepEqual(p.impressions, []);
  assert.deepEqual(readJson(peopleFile)['10001'], p, '内存对象与落盘一致');
});

test('upsertFromGroup：跨群归一——计数相加、别名各群各一份、时间取极值', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:1', { id: '10001', name: '小明', count: 5, firstSeen: 1000, lastSeen: 2000 });
  pp.upsertFromGroup('group:2', { id: '10001', name: '明明', count: 7, firstSeen: 900, lastSeen: 3000 });
  const p = pp.upsertFromGroup('group:1', {
    id: '10001', name: '小名', count: 6, firstSeen: 1200, lastSeen: 2500,
  });
  assert.deepEqual(p.groups, ['group:1', 'group:2'], '群不重复');
  assert.deepEqual(p.perGroup, { 'group:1': 6, 'group:2': 7 }, '同群取最大发言量');
  assert.equal(p.count, 13, '跨群发言量相加');
  assert.equal(p.firstSeen, 900, 'firstSeen 取最早');
  assert.equal(p.lastSeen, 3000, 'lastSeen 取最近');
  assert.deepEqual(p.aliases, { 'group:1': '小名', 'group:2': '明明' }, '每个群记住那边的称呼');

  // 同群重复 upsert 但计数更小：不能把总发言量降下去
  const again = pp.upsertFromGroup('group:1', { id: '10001', name: '小名', count: 3, firstSeen: 1000, lastSeen: 1000 });
  assert.equal(again.count, 13);
  assert.equal(again.lastSeen, 3000);
});

test('upsertFromGroup：名字为「我」不写别名、名字截 24、非群 key 进 unknown 不进 groups', (t) => {
  fresh(t);
  const noName = pp.upsertFromGroup('group:1', { id: 'u2', name: '我', count: 1 });
  assert.deepEqual(noName.aliases, {}, '「我」不是他的名字');
  assert.deepEqual(noName.groups, ['group:1']);

  const longName = pp.upsertFromGroup('group:1', { id: 'u3', name: '名'.repeat(30), count: 1 });
  assert.equal(longName.aliases['group:1'].length, 24, '昵称截 24 字');

  const noGroup = pp.upsertFromGroup('', { id: 'u4', name: '无群', count: 2 });
  assert.deepEqual(noGroup.groups, [], '没有 group: 前缀不记群');
  assert.equal(noGroup.aliases.unknown, '无群', '别名兜底挂在 unknown 下');
  assert.deepEqual(noGroup.perGroup, { '': 2 });
});

test('upsertFromGroup：notes 跨群去重（包含即算重复）且上限 8', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:1', { id: 'u5', name: '笔记', count: 1, notes: ['他养了猫', '', '   '] });
  const p = pp.upsertFromGroup('group:2', {
    id: 'u5', name: '笔记', count: 1,
    notes: ['他养了猫', '他养了猫和狗', '他住在杭州', '他喜欢跑步'],
  });
  assert.deepEqual(p.notes, ['他养了猫', '他住在杭州', '他喜欢跑步'], '重复/被包含的跨群笔记跳过，空值忽略');

  const capped = pp.upsertFromGroup('group:3', {
    id: 'u5', name: '笔记', count: 1,
    notes: ['他有个妹妹', '他在上学', '他在上班', '他有宠物', '他是个程序员', '他打游戏'],
  });
  assert.equal(capped.notes.length, 8, '上限 8 条');
  assert.deepEqual(capped.notes.slice(0, 3), ['他养了猫', '他住在杭州', '他喜欢跑步']);
  assert.ok(!capped.notes.includes('他打游戏'), '第 9 条不同笔记被丢');
});

// ───────────────────────────── noteImpression / impressionsOf / unnoteImpression ─────────────────────────────

test('noteImpression：空 key/空文本返回 null 不落盘', (t) => {
  fresh(t);
  assert.equal(pp.noteImpression('', { text: '有内容' }), null);
  assert.equal(pp.noteImpression('   ', { text: '有内容' }), null);
  assert.equal(pp.noteImpression('u1', {}), null);
  assert.equal(pp.noteImpression('u1', { text: '   ' }), null);
  assert.equal(fs.existsSync(peopleFile), false);
});

test('noteImpression：追加、from 截 24、text 截 200、上限 12 条顶掉最旧', (t) => {
  fresh(t);
  const at = 1_700_000_000_000;
  pp.noteImpression('20001', { text: '第一条', from: 'group:1', at });
  for (let i = 2; i <= 14; i += 1) {
    pp.noteImpression('20001', { text: `第${i}条`, from: 'group:1', at: at + i });
  }
  const p = pp.personOf('20001');
  assert.equal(p.impressions.length, 12, '上限 12 条');
  assert.equal(p.impressions[0].text, '第3条', '最旧的两条被顶掉');
  assert.equal(p.impressions.at(-1).text, '第14条');
  assert.equal(p.impressions[0].at, at + 3);

  const long = pp.noteImpression('20002', { text: 'x'.repeat(250), from: 'y'.repeat(30) });
  assert.equal(long.impressions[0].text.length, 200, 'text 截 200');
  assert.equal(long.impressions[0].from.length, 24, 'from 截 24');
});

test('noteImpression：还没档案时用昵称兜底（能存能读，不丢）', (t) => {
  fresh(t);
  const p = pp.noteImpression('小红', { text: '还没档案', from: 'group:1', at: 111 });
  assert.equal(p.id, '小红');
  assert.deepEqual(p.aliases, {});
  assert.deepEqual(p.impressions, [{ at: 111, from: 'group:1', text: '还没档案' }]);
  assert.deepEqual(pp.impressionsOf('小红'), [{ at: 111, from: 'group:1', text: '还没档案' }]);
});

test('noteImpression：昵称 fallback 应合并进已有 userId（已知 bug，期望失败）', (t) => {
  fresh(t);
  // 先有群档案：10001 的群昵称是「小明」，aliases 里已有这条昵称
  pp.upsertFromGroup('group:1', { id: '10001', name: '小明', count: 5, firstSeen: 1000, lastSeen: 2000 });

  // 她按昵称记印象（console-server 在 memberNickLookup 解析不出来时才传昵称；
  // 这里直接模拟「昵称 key」进入持久层的场景）
  pp.noteImpression('小明', { text: '爱抬杠', from: 'group:1', at: 1_700_000_000_000 });

  // 源码 inori-people.js:169-185 的注释承诺：「如果它其实是某个人物的别名，合并进那个 userId」。
  // 实际 ensure() 总会给新条目 aliases={}，`!p.aliases` 恒为 false → 合并分支不可达，
  // 于是同一句印象挂在昵称 key 下，按 userId 渲染（renderPersonLines 用 m.id）永远读不到。
  const real = pp.personOf('10001');
  assert.equal(
    real.impressions.length,
    1,
    'BUG：昵称兜底印象没有合并到 userId 10001（inori-people.js:177 恒假条件）',
  );
  assert.equal(real.impressions[0].text, '爱抬杠');
});

test('impressionsOf：默认最近 3 条、可指定条数、昵称反查到 userId、未知返回空', (t) => {
  fresh(t);
  const at = 1_700_000_000_000;
  for (let i = 1; i <= 5; i += 1) pp.noteImpression('30001', { text: `印象${i}`, at: at + i });
  assert.deepEqual(pp.impressionsOf('30001').map((x) => x.text), ['印象3', '印象4', '印象5']);
  assert.deepEqual(pp.impressionsOf('30001', 1).map((x) => x.text), ['印象5']);
  assert.equal(pp.impressionsOf('30001', 10).length, 5);
  assert.deepEqual(pp.impressionsOf('不存在'), []);

  // 别名反查：按群里叫的昵称也能读到同一个人的持久印象
  pp.upsertFromGroup('group:1', { id: '30002', name: '小明', count: 3 });
  pp.noteImpression('30002', { text: '爱猫', at });
  assert.deepEqual(pp.impressionsOf('小明').map((x) => x.text), ['爱猫']);
});

test('unnoteImpression：精确/包含匹配、空匹配全删、未知/无匹配返回 0', (t) => {
  fresh(t);
  const at = 1_700_000_000_000;
  pp.noteImpression('40001', { text: '今天很开心', at });
  pp.noteImpression('40001', { text: '他很难过', at: at + 1 });
  pp.noteImpression('40001', { text: '普通的事', at: at + 2 });

  assert.equal(pp.unnoteImpression('40001', '开心'), 1, '包含匹配');
  assert.deepEqual(pp.impressionsOf('40001').map((x) => x.text), ['他很难过', '普通的事']);
  assert.equal(pp.unnoteImpression('40001', '难过'), 1);
  assert.equal(pp.unnoteImpression('40001', '不存在的词'), 0, '无匹配不删');
  assert.equal(pp.impressionsOf('40001').length, 1);
  assert.equal(pp.unnoteImpression('40001', ''), 1, '空匹配 = 全删这个人');
  assert.deepEqual(pp.impressionsOf('40001'), []);
  assert.equal(pp.unnoteImpression('不存在', 'x'), 0);
});

// ───────────────────────────── adviceFor / renderPersonLines ─────────────────────────────

test('adviceFor：bot 直接给同类提示，不推人类熟络', () => {
  const bot = pp.adviceFor({ count: 50, repliesToMe: 5 }, { isBot: true });
  assert.deepEqual(bot, ['它是另一个 bot（AI），不是人：别跟它客套，客套话可以不接']);
});

test('adviceFor：提问场景的三种应对（反问/岔开/认真答）有 3 次 + 40% 门槛', () => {
  assert.deepEqual(pp.adviceFor({ resp: { ask: 3, ask_rebut: 3 }, count: 10 }),
    ['他爱反问，跟他说话别在一个点上站住，接快一点就撤']);
  assert.deepEqual(pp.adviceFor({ resp: { ask: 3, ask_dodge: 3 }, count: 10 }),
    ['他爱岔开话题，他躲了也别追着要，自己换个话头']);
  assert.deepEqual(pp.adviceFor({ resp: { ask: 3, ask_answer: 3 }, count: 10 }),
    ['他爱把事说清楚，问题可以直接丢给他']);
  assert.deepEqual(pp.adviceFor({ resp: { ask: 2, ask_rebut: 2 }, count: 10 }), [], '不足 3 次不出指引');
  assert.deepEqual(pp.adviceFor({ resp: { ask: 5, ask_rebut: 2 }, count: 10 }),
    ['他爱反问，跟他说话别在一个点上站住，接快一点就撤'], '恰好 40% 命中');
  assert.deepEqual(pp.adviceFor({ resp: { ask: 5, ask_rebut: 1 }, count: 10 }), [], '不到 40% 不出');
});

test('adviceFor：抱怨场景讲道理/哈哈、常接话、语气、新人、每人最多两行', () => {
  assert.deepEqual(pp.adviceFor({ resp: { cm: 3, cm_assess: 3 }, count: 10 }),
    ['有人遇事先找他讲道理，跟他说麻烦可以直球']);
  assert.deepEqual(pp.adviceFor({ resp: { cm: 3, cm_laugh: 3 }, count: 10 }),
    ['他习惯用哈哈接负面情绪，气氛绷的时候别跟着加码']);
  assert.deepEqual(pp.adviceFor({ resp: { cm: 2, cm_assess: 2 }, count: 10 }), []);
  assert.deepEqual(pp.adviceFor({ repliesToMe: 2, count: 10 }), ['他常接你的话，可以熟一点']);
  assert.deepEqual(pp.adviceFor({ repliesToMe: 1, count: 10 }), []);
  assert.deepEqual(pp.adviceFor({ voice: { n: 5, q: 3 }, count: 10 }), ['他爱问，直接答就行']);
  assert.deepEqual(pp.adviceFor({ voice: { n: 5, q: 1, laugh: 2 }, count: 10 }),
    ['他偏氛围型，可以接个表情跟一下']);
  assert.deepEqual(pp.adviceFor({ voice: { n: 4, q: 4 }, count: 10 }), [], '语气样本不足 5 条不出');
  assert.deepEqual(pp.adviceFor({ count: 2 }), ['跟他还没熟，别太自来熟']);
  assert.deepEqual(pp.adviceFor({ count: 3 }), []);

  const many = pp.adviceFor({
    resp: { ask: 5, ask_answer: 5, cm: 5, cm_assess: 5 },
    repliesToMe: 2, count: 2, voice: { n: 5, q: 5 },
  });
  assert.deepEqual(many, [
    '他爱把事说清楚，问题可以直接丢给他',
    '有人遇事先找他讲道理，跟他说麻烦可以直球',
  ], '提示面每人最多两行，按统计优先级截断');
});

test('renderPersonLines：没有人物档案时只出 QQ 行（不造资料）', (t) => {
  fresh(t);
  assert.deepEqual(pp.renderPersonLines('group:1', { id: 'x', count: 5 }), ['  · QQ：x']);
  const lines = pp.renderPersonLines('group:1', { id: 'x', count: 1 });
  assert.deepEqual(lines, ['  · QQ：x', '  · 指引：跟他还没熟，别太自来熟']);
});

test('renderPersonLines：bot 身份与「别客套」提示', (t) => {
  fresh(t);
  const lines = pp.renderPersonLines('group:1', { id: 'bot1', count: 10 }, { isBot: true });
  assert.deepEqual(lines, [
    '  · QQ：bot1（另一个 bot，不是人）',
    '  · 指引：它是另一个 bot（AI），不是人：别跟它客套，客套话可以不接',
  ]);
});

test('renderPersonLines：owner 标记来自 QQ_INORI_OWNER_QQ，两个群以上才出「老板」行', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:1', { id: '99999', name: '主人', count: 5 });
  assert.equal(pp.personOf('99999').owner, true);
  const one = pp.renderPersonLines('group:1', { id: '99999', count: 5 });
  assert.equal(one[0], '  · QQ：99999（这是主人）');
  assert.ok(!one.some((l) => l.includes('他是老板')), '只在一个群时不重复揣测');

  pp.upsertFromGroup('group:2', { id: '99999', name: '主人', count: 5 });
  const two = pp.renderPersonLines('group:1', { id: '99999', count: 5 });
  assert.ok(two.some((l) => l.includes('他是老板——对他的看法走专门通道，这里不重复揣测')));
  assert.equal(pp.personOf('10001'), null);
});

test('renderPersonLines：跨群别名（排除当前群/unknown）、印象同文去重与旧条数折叠', (t) => {
  fresh(t);
  const at = 1_700_000_000_000;
  pp.upsertFromGroup('group:A', { id: 'u7', name: '阿明', count: 5 });
  pp.upsertFromGroup('group:B', { id: 'u7', name: '明明', count: 7 });
  pp.noteImpression('u7', { text: '爱抬杠', from: 'group:A', at });
  pp.noteImpression('u7', { text: '爱猫', from: 'group:A', at: at + 1 });
  pp.noteImpression('u7', { text: '爱抬杠。', from: 'group:A', at: at + 2 }); // 归一化后与第 1 条同文
  pp.noteImpression('u7', { text: '话多', from: 'group:A', at: at + 3 });

  const lines = pp.renderPersonLines('group:A', { id: 'u7', count: 5 });
  assert.equal(lines[0], '  · QQ：u7');
  assert.ok(lines.includes('  · 他在另一个群也出现过（那边叫「明明」）——是同一个人，印象跟着人走'));
  assert.ok(!lines.some((l) => l.includes('「阿明」')), '当前群的昵称不算「另一个群」');
  assert.ok(lines.includes('  · 你印象里：爱抬杠。（记于 group:A）'), '同文只留最新');
  assert.ok(lines.includes('  · 你印象里：话多（记于 group:A）'));
  assert.ok(lines.includes('  · 关于他你还记过 2 条旧印象——想改就写新的，新的顶旧的，旧的留着当过去'));

  // unknown 兜底别名不算「另一个群」
  pp.upsertFromGroup('', { id: 'u8', name: '未知群', count: 1 });
  const unknownLines = pp.renderPersonLines('group:A', { id: 'u8', count: 1 });
  assert.ok(!unknownLines.some((l) => l.includes('另一个群也出现过')));
});

test('renderPersonLines：档案行取最近 3 条；3 天内的 shift 才提示', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:A', { id: 'u9', name: '阿九', count: 5 });
  pp.noteProfile('u9', { text: '他好像 22、爱抬杠', from: 'group:A' });
  const m = { id: 'u9', count: 5, shift: { kinds: ['第一次回你'], text: '嗯', at: Date.now() - 1000 } };
  const lines = pp.renderPersonLines('group:A', m);
  assert.ok(lines.includes('  · 档案：他好像 22、爱抬杠'));
  assert.ok(lines.includes('  · 有点不一样：第一次回你（原话：嗯）——想改对他的印象就改，不想改就当没看见'));

  // 过期 shift 不提示
  const stale = { ...m, shift: { kinds: ['第一次回你'], text: '嗯', at: Date.now() - 4 * DAY } };
  assert.ok(!pp.renderPersonLines('group:A', stale).some((l) => l.includes('有点不一样')));
});

// ───────────────────────────── noteProfile / unnoteProfile / renderProfileLine ─────────────────────────────

test('noteProfile：空输入返回 null；纯数字 key 不反查别名', (t) => {
  fresh(t);
  assert.equal(pp.noteProfile('', { text: 'x' }), null);
  assert.equal(pp.noteProfile('u1', {}), null);
  assert.equal(pp.noteProfile('u1', { text: '  ' }), null);
  assert.equal(fs.existsSync(peopleFile), false);

  const p = pp.noteProfile('12345', { text: '他爱猫' });
  assert.equal(p.id, '12345', '纯数字按 userId 直接建');
  assert.deepEqual(p.profile.lines, ['他爱猫']);
  assert.equal(typeof p.profile.updatedAt, 'number');
});

test('noteProfile：昵称解析到已有 userId、包含去重、上限 8 条、from 截 24', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:1', { id: '10001', name: '小明', count: 3 });
  pp.noteProfile('小明', { text: '他好像 22', from: 'group:1' });
  assert.equal(pp.personOf('10001').profile.lines.length, 1, '按别名落到真实 userId');
  assert.equal(pp.personOf('小明').id, '10001', 'personOf 也能按别名反查');

  // 包含去重：新句包含旧句 → 跳过
  pp.noteProfile('10001', { text: '他好像 22 岁、爱抬杠' });
  assert.deepEqual(pp.personOf('10001').profile.lines, ['他好像 22']);

  // from 截 24
  pp.noteProfile('10001', { text: '第1件事', from: 'g'.repeat(30) });
  assert.equal(pp.personOf('10001').profile.from.length, 24, 'from 截 24');

  // 上限 8：继续追加不同档案
  for (let i = 2; i <= 10; i += 1) pp.noteProfile('10001', { text: `第${i}件事` });
  const lines = pp.personOf('10001').profile.lines;
  assert.equal(lines.length, 8, '档案上限 8 行');
  assert.equal(lines.at(-1), '第10件事');
  assert.ok(!lines.includes('第1件事'), '最旧的几行被顶掉');
});

test('unnoteProfile：无档案返回 0、精确/包含删除、空匹配全删、别名可删', (t) => {
  fresh(t);
  assert.equal(pp.unnoteProfile('不存在', 'x'), 0);
  pp.upsertFromGroup('group:1', { id: 'u10', name: '档案', count: 3 });
  assert.equal(pp.unnoteProfile('u10', 'x'), 0, '有档案没 profile 时也不抛');
  pp.noteProfile('u10', { text: '他爱猫' });
  pp.noteProfile('u10', { text: '他爱狗' });
  pp.noteProfile('u10', { text: '他住杭州' });
  assert.equal(pp.unnoteProfile('u10', '爱猫'), 1, '包含匹配');
  assert.deepEqual(pp.personOf('u10').profile.lines, ['他爱狗', '他住杭州']);
  assert.equal(pp.unnoteProfile('u10', '不存在'), 0);
  assert.equal(pp.unnoteProfile('u10', ''), 2, '空匹配 = 全删这个人的档案');
  assert.deepEqual(pp.personOf('u10').profile.lines, []);

  // 按昵称删
  pp.upsertFromGroup('group:1', { id: '10001', name: '小明', count: 3 });
  pp.noteProfile('10001', { text: '他爱猫' });
  assert.equal(pp.unnoteProfile('小明', '爱猫'), 1);
});

test('renderProfileLine：无档案空串；有档案取最近 3 条', (t) => {
  fresh(t);
  assert.equal(pp.renderProfileLine({ id: 'nobody' }), '');
  pp.upsertFromGroup('group:1', { id: 'u11', name: '档案', count: 3 });
  assert.equal(pp.renderProfileLine({ id: 'u11' }), '', '有档案但没写 profile');
  pp.noteProfile('u11', { text: '第一条' });
  pp.noteProfile('u11', { text: '第二条' });
  pp.noteProfile('u11', { text: '第三条' });
  pp.noteProfile('u11', { text: '第四条' });
  assert.equal(pp.renderProfileLine({ id: 'u11' }), '  · 档案：第二条；第三条；第四条');
});

// ───────────────────────────── rebuild ─────────────────────────────

test('rebuild：从 group-members.json 全量重建，合并跨群并保留旧印象', (t) => {
  fresh(t);
  seedGroupMembers({
    'group:1': {
      members: {
        10001: { id: '10001', name: '小明', count: 5, firstSeen: 1000, lastSeen: 2000, notes: ['他养了猫'] },
        bad: { name: '没有 id' },
      },
    },
    'group:2': {
      members: {
        10001: { id: '10001', name: '明明', count: 7, firstSeen: 900, lastSeen: 3000 },
      },
    },
    'group:bad': { members: null },
  });
  seedPeople({
    10001: { id: '10001', impressions: [{ at: 1, from: 'group:1', text: '旧印象' }] },
    小红: { id: '小红', impressions: [{ at: 2, from: 'group:1', text: '昵称兜底印象' }] },
    99999: { id: '99999', impressions: [{ at: 3, from: 'group:1', text: '主人印象' }] },
  });

  assert.equal(pp.rebuild(), 3, '10001 + 昵称兜底小红 + 99999');
  const db = readJson(peopleFile);
  assert.deepEqual(db['10001'].groups, ['group:1', 'group:2']);
  assert.deepEqual(db['10001'].perGroup, { 'group:1': 5, 'group:2': 7 });
  assert.equal(db['10001'].count, 12);
  assert.equal(db['10001'].firstSeen, 900);
  assert.equal(db['10001'].lastSeen, 3000);
  assert.deepEqual(db['10001'].notes, ['他养了猫']);
  assert.deepEqual(db['10001'].impressions, [{ at: 1, from: 'group:1', text: '旧印象' }], '重建不丢她记过的印象');
  assert.deepEqual(db['小红'].impressions, [{ at: 2, from: 'group:1', text: '昵称兜底印象' }], '昵称兜底 key 保留');
  assert.equal(db['99999'].owner, true, 'owner 在重建时重新标记');
  assert.equal(db.bad, undefined, '没有 id 的脏成员被跳过');

  assert.equal(pp.rebuild(), 3, '重建可重复执行（幂等）');
});

test('rebuild：文件缺失返回 0；group-members 损坏时只回填旧印象', (t) => {
  fresh(t);
  assert.equal(pp.rebuild(), 0, '两个文件都不存在');
  seedGroupMembers('{不是合法 JSON');
  assert.equal(pp.rebuild(), 0, 'group-members 损坏 → 当空库');

  seedPeople({ u1: { id: 'u1', impressions: [{ at: 1, from: 'g', text: '还在' }] } });
  assert.equal(pp.rebuild(), 1, '只有旧印象条目也保留');
  assert.deepEqual(pp.personOf('u1').impressions, [{ at: 1, from: 'g', text: '还在' }]);
});

test('人物库损坏时读路径降级为空库，写入前先重建合法 JSON', (t) => {
  fresh(t);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(peopleFile, '这不是 JSON', 'utf8');
  assert.equal(pp.personOf('10001'), null, '坏文件当空库，不抛');
  assert.deepEqual(pp.impressionsOf('10001'), []);
  assert.equal(pp.rebuild(), 0, '坏库 + 没有 group-members → 0 条');
  const p = pp.upsertFromGroup('group:1', { id: '10001', name: '小明', count: 2 });
  assert.equal(p.count, 2);
  assert.equal(readJson(peopleFile)['10001'].count, 2, '坏文件已被重建为合法 JSON');
});

// ───────────────────────────── personOf / aliasesOf ─────────────────────────────

test('personOf：按 userId 精确查、按别名反查、未知返回 null', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:1', { id: '50001', name: '阿查', count: 2 });
  assert.equal(pp.personOf('50001').id, '50001');
  assert.equal(pp.personOf('阿查').id, '50001', '别名反查');
  assert.equal(pp.personOf('查无此人'), null);
  assert.equal(pp.personOf(''), null);
});

test('aliasesOf：去重、排除纯数字、未知非数字 key 兜底为名字、未知数字返回空', (t) => {
  fresh(t);
  pp.upsertFromGroup('group:1', { id: '60001', name: '小明', count: 3 });
  pp.upsertFromGroup('group:2', { id: '60001', name: '10086', count: 3 });
  pp.upsertFromGroup('group:3', { id: '60001', name: '小明', count: 3 });
  assert.deepEqual(pp.aliasesOf('60001'), ['小明'], '纯数字昵称不算名字，值去重');

  pp.upsertFromGroup('group:1', { id: '60002', name: '阿二', count: 3 });
  assert.deepEqual(pp.aliasesOf('阿二'), ['阿二']);
  assert.deepEqual(pp.aliasesOf('新朋友'), ['新朋友'], '没有档案的非数字 key 直接当名字');
  assert.deepEqual(pp.aliasesOf('70001'), [], '未知数字 key 没有名字');
});

// ───────────────────────────── 跨进程持久化 ─────────────────────────────

test('持久化往返：另一个进程写入的印象，本进程重建模块后能读到', (t) => {
  fresh(t);
  const modUrl = pathToFileURL(path.join(BRIDGE, 'src', 'domain', 'leaves', 'inori-people.js')).href;
  const code = `
    const pp = await import(${JSON.stringify(modUrl)});
    const p = pp.noteImpression('80001', { text: '子进程写的', from: 'group:1', at: 123 });
    process.stdout.write(JSON.stringify({ id: p.id, impressions: p.impressions }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: BRIDGE,
    env: { ...process.env, QQ_INORI_ROOT: ROOT },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out).impressions, [{ at: 123, from: 'group:1', text: '子进程写的' }]);
  assert.deepEqual(pp.impressionsOf('80001'), [{ at: 123, from: 'group:1', text: '子进程写的' }]);
  assert.deepEqual(readJson(peopleFile)['80001'].impressions, [{ at: 123, from: 'group:1', text: '子进程写的' }]);
});
