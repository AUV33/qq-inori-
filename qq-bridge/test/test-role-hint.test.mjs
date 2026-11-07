// role-hint 金标：人格卡读取的安全校验、按模式筛小节、二代示例改写、空格/断点软提醒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoleHint } from '../src/domain/persona/role-hint.mjs';
import { conditionedRoleText } from '../src/domain/leaves/inori-works.js';

function makeCtx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-'));
  const roles = path.join(dir, 'roles');
  fs.mkdirSync(roles);
  const stateFile = path.join(dir, 'current-role.json');
  fs.writeFileSync(stateFile, JSON.stringify({ role: 'shuirai' }));
  const svc = createRoleHint({
    readRoleState: () => ({ role: 'shuirai' }),
    sanitizeRoleName: (n) => String(n ?? '').replace(/[\\/:*?"<>|]/g, '').trim(),
    ROLES_DIR: roles,
    ROLE_STATE_FILE: stateFile,
    getRoleInjectMaxChars: () => 1000,
    truncateText: (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s),
    conditionedRoleText: (text) => conditionedRoleText(text, ''),
    ...overrides,
  });
  return { svc, dir, roles, stateFile };
}

const writeCard = (roles, name, body) => fs.writeFileSync(path.join(roles, `${name}.md`), body, 'utf8');

test('roleRawContent：没有配置人格 / 文件不存在都返回空串', () => {
  assert.equal(makeCtx({ readRoleState: () => ({}) }).svc.roleRawContent(), '');
  assert.equal(makeCtx().svc.roleRawContent(), '', '文件不存在');
});

test('roleRawContent：拒绝路径穿越与越界读取（state 文件是用户可编辑的）', () => {
  const traversal = makeCtx({ readRoleState: () => ({ role: '../../../Users/Public/x' }) });
  assert.equal(traversal.svc.roleRawContent(), '', '路径穿越必须挡住');
  const absolute = makeCtx({ readRoleState: () => ({ role: 'C:\\Windows\\win.ini' }) });
  assert.equal(absolute.svc.roleRawContent(), '', '绝对路径要被 sanitize 掉');
});

test('roleRawContent：按内容缓存，角色卡改写后会重新读（mtime/size 变化击穿）', () => {
  const h = makeCtx();
  writeCard(h.roles, 'shuirai', '【人格】第一版');
  assert.ok(h.svc.roleRawContent().includes('第一版'));
  writeCard(h.roles, 'shuirai', '【人格】第二版，内容更长一点');
  assert.ok(h.svc.roleRawContent().includes('第二版'), '同 tick 改写也要生效');
});

test('roleHintForMode：先按模式筛小节，再按上限截断', () => {
  const h = makeCtx();
  writeCard(h.roles, 'shuirai', [
    '## 通用',
    '一代二代都读',
    '## 一代专属 〔一代〕',
    '用空格分条',
    '## 二代专属 〔二代〕',
    '用数组分条',
  ].join('\n'));
  const v1 = h.svc.roleHintForMode('v1');
  const v2 = h.svc.roleHintForMode('v2');
  assert.ok(v1.includes('一代专属'));
  assert.ok(!v1.includes('二代专属'));
  assert.ok(v2.includes('二代专属'));
  assert.ok(!v2.includes('一代专属'));

  const tiny = makeCtx({ getRoleInjectMaxChars: () => 10 });
  writeCard(tiny.roles, 'shuirai', '啊'.repeat(100));
  assert.ok(tiny.svc.roleHintForMode('v1').length <= 11, '超长要截断');
});

test('convertExampleSpacesToComma：中文两侧空格变逗号，URL/符号周围不动', () => {
  const h = makeCtx();
  assert.equal(h.svc.convertExampleSpacesToComma('你好 世界'), '你好，世界');
  assert.equal(h.svc.convertExampleSpacesToComma('看 https://a.com/b 这个'), '看 https://a.com/b，这个', 'URL 前不动、URL 后的中文停顿仍改写');
  assert.equal(h.svc.convertExampleSpacesToComma('DeepSeek V3 不错'), 'DeepSeek V3，不错', '一侧是中文就按停顿改写（与设计一致）');
  assert.equal(h.svc.convertExampleSpacesToComma('a, b 和 c'), 'a, b，和，c', '中文词两侧的空格都算停顿');
});

test('currentRoleHintV2：过滤一代 [SILENT] 指令，并把示例里的空格改写成逗号', () => {
  const h = makeCtx();
  writeCard(h.roles, 'shuirai', [
    '## 通用',
    '[SILENT] 这条一代指令必须被滤掉',
    '## 回复示例 （空格代表前后分两条消息回答）',
    '你好 我是小满',
    '## 其它',
    '正常内容',
  ].join('\n'));
  const v2 = h.svc.currentRoleHintV2();
  assert.ok(!v2.includes('[SILENT]'), '一代指令不能漏进二代');
  assert.ok(v2.includes('（示例中已用逗号表示停顿；想分多条请用数组）'));
  assert.ok(v2.includes('你好，我是小满'));
  assert.ok(v2.includes('正常内容'));
});

test('findCjkSpaceWarning：只有中文两侧都是中文才算，且按条标注', () => {
  const h = makeCtx();
  assert.equal(h.svc.findCjkSpaceWarning(['你好 世界']), '第 1 条消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。');
  assert.equal(h.svc.findCjkSpaceWarning(['DeepSeek V3 很好']), null, '英文单词间空格不误报');
  const multi = h.svc.findCjkSpaceWarning(['正常', '这里 有空格', '也 有']);
  assert.ok(multi.includes('第 2、3 条'));
  assert.equal(h.svc.findCjkSpaceWarning([]), null);
});

test('findSplitBoundaryWarning：非终止标点结尾 / 半句话结尾才提醒', () => {
  const h = makeCtx();
  assert.equal(h.svc.findSplitBoundaryWarning(['我去了，', '然后就回来了']), '第 1、2 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。');
  assert.equal(h.svc.findSplitBoundaryWarning(['我先把', '饭做好']), '第 1、2 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。');
  assert.equal(h.svc.findSplitBoundaryWarning(['好的', '那我走了']), null, '常见短句完整结尾不算半句');
  assert.equal(h.svc.findSplitBoundaryWarning(['第一句。', '第二句。']), null);
  assert.equal(h.svc.findSplitBoundaryWarning(['只有一条']), null);
  assert.equal(h.svc.findSplitBoundaryWarning(null), null);
});

test('roleHintForMode(v2)：唤醒路径与 qq_get_prompt 看到同一份过滤文本', () => {
  const h = makeCtx();
  writeCard(h.roles, 'shuirai', [
    '## 通用',
    '[SILENT] 这条一代指令必须被滤掉',
    '## 回复示例 （空格代表前后分两条消息回答）',
    '你好 我是小满',
    '## 其它',
    '正常内容',
  ].join('\n'));
  const wake = h.svc.roleHintForMode('v2', '');
  const tool = h.svc.currentRoleHintV2();
  assert.equal(wake, tool, '两条注入路径必须一致');
  assert.ok(!wake.includes('[SILENT]'), '一代行不能从唤醒路径漏进去');
  assert.ok(wake.includes('你好，我是小满'), '示例空格要改成逗号');
});
