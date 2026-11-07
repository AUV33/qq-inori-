// role-card 金标：人格卡按〔一代〕/〔二代〕标记筛小节——标记从标题里去掉，另一模式的专属小节不注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRoleSections, selectRoleText, roleSectionReport, roleCharStats, GEN1_ROLE_LINE_RE,
} from '../src/domain/persona/role-card.js';

const CARD = [
  '# 你是谁',
  '你是小满。',
  '',
  '## 分条方式 〔一代〕',
  '用空格分条，沉默输出 [SILENT]。',
  '',
  '## 表情包体系 〔二代〕',
  '表情要用 qq_send_sticker。',
  '',
  '## 口癖',
  '说话尾音带「啦」。',
].join('\n');

test('parseRoleSections：标记识别（〔一代〕/〔二代〕/英文别名）并从标题里去掉', () => {
  const sections = parseRoleSections(CARD);
  assert.equal(sections[0].heading, '你是谁');
  assert.equal(sections[0].mode, 'all');
  const v1 = sections.find((s) => s.heading === '分条方式');
  assert.equal(v1.mode, 'v1', '〔一代〕要识别出来，标题里不留标记');
  const v2 = sections.find((s) => s.heading === '表情包体系');
  assert.equal(v2.mode, 'v2');
  assert.equal(sections.find((s) => s.heading === '口癖').mode, 'all');
});

test('parseRoleSections：英文/中文别名都认（[v2] / （reserved） / 2 代）', () => {
  const card = ['## A [v2]', 'x', '## B （reserved）', 'y', '## C 〔2 代〕', 'z'].join('\n');
  const modes = parseRoleSections(card).filter((s) => s.heading).map((s) => [s.heading, s.mode]);
  assert.deepEqual(modes, [['A', 'v2'], ['B', 'v1'], ['C', 'v2']]);
});

test('selectRoleText：v1 只注入 all + v1，v2 只注入 all + v2', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  assert.ok(v1.includes('用空格分条'));
  assert.ok(!v1.includes('qq_send_sticker'));
  assert.ok(v2.includes('qq_send_sticker'));
  assert.ok(!v2.includes('[SILENT]'));
  assert.ok(v1.includes('你是小满'), '公共小节两边都注入');
  assert.ok(v1.includes('尾音带「啦」'));
});

test('selectRoleText：没有标题的正文算公共部分；空文本返回空串', () => {
  const text = selectRoleText('没有标题的一段正文', 'v2');
  assert.equal(text, '没有标题的一段正文');
  assert.equal(selectRoleText('', 'v1'), '');
  assert.equal(selectRoleText(null, 'v2'), '');
});

test('selectRoleText：连续空行被压成一段（不留三连空行）', () => {
  const out = selectRoleText(CARD, 'v2');
  assert.ok(!/\n{3,}/.test(out));
});

test('roleSectionReport：逐节报告是否注入 + 字符数（控制台预览用）', () => {
  const report = roleSectionReport(CARD, 'v2');
  const byHeading = new Map(report.map((r) => [r.heading, r]));
  assert.equal(byHeading.get('你是谁').injected, true);
  assert.equal(byHeading.get('分条方式').injected, false);
  assert.equal(byHeading.get('表情包体系').injected, true);
  assert.ok(byHeading.get('分条方式').chars > 0);
  assert.equal(roleSectionReport('', 'v1')[0].heading, '(开头部分)');
});

test('roleCharStats：分开统计公共/一代专属/二代专属字符数', () => {
  const s = roleCharStats(CARD);
  assert.ok(s.common > 0);
  assert.ok(s.v1Only > 0);
  assert.ok(s.v2Only > 0);
  assert.equal(s.v1, selectRoleText(CARD, 'v1').length);
  assert.equal(s.v2, selectRoleText(CARD, 'v2').length);
  assert.ok(s.v1 < s.total);
  assert.ok(s.v1 + s.v2Only <= s.total, 'v1 注入量应小于总量');
});

test('GEN1_ROLE_LINE_RE：认一代遗留指令（[SILENT]/空格分条/自动转发）', () => {
  for (const line of [
    '[SILENT]',
    '用空格分条',
    '空格分句：一条消息一行',
    '回复会自动转发',
    '输出 [silent] 表示不说话',
  ]) assert.equal(GEN1_ROLE_LINE_RE.test(line), true, line);
  for (const line of ['你好呀', '用逗号表示停顿', 'qq_send_message 数组分条']) {
    assert.equal(GEN1_ROLE_LINE_RE.test(line), false, line);
  }
});
