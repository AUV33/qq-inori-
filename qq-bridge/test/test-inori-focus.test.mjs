// inori-focus 金标：四槽位重点——解析容错、「无」视为空、渲染顺序、36h 过期、原子落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FOCUS_SLOTS, FOCUS_SLOT_CN, FOCUS_MAX_AGE_MS, parseFocusBlock, renderFocusBlock, loadFocus, saveFocusBlock,
} from '../src/domain/leaves/inori-focus.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-focus-')), 'focus.json');

test('四槽位常量：顺序固定，中英对照齐全', () => {
  assert.deepEqual(FOCUS_SLOTS, ['requirements', 'promises', 'unfinished', 'noticed']);
  for (const s of FOCUS_SLOTS) assert.ok(FOCUS_SLOT_CN[s]);
});

test('parseFocusBlock：完整块解析四槽位，raw 保留块内文本', () => {
  const out = parseFocusBlock('先写经验…\n【FOCUS】\n他的要求:别催我睡觉\n她承诺的:把画补完\n没做完的:问那家店的事\n她留意到的:他最近总在凌晨发消息\n【/FOCUS】\n以上');
  assert.equal(out.requirements, '别催我睡觉');
  assert.equal(out.promises, '把画补完');
  assert.equal(out.unfinished, '问那家店的事');
  assert.equal(out.noticed, '他最近总在凌晨发消息');
  assert.ok(out.raw.includes('他的要求'));
});

test('parseFocusBlock：没有块 / 全「无」/ 全空 → null', () => {
  assert.equal(parseFocusBlock('没有块'), null);
  assert.equal(parseFocusBlock(''), null);
  assert.equal(parseFocusBlock(null), null);
  assert.equal(parseFocusBlock('【FOCUS】\n他的要求:无\n她承诺的:无\n没做完的:无\n她留意到的:无\n【/FOCUS】'), null);
  assert.equal(parseFocusBlock('【FOCUS】\n\n【/FOCUS】'), null);
});

test('parseFocusBlock：允许只写部分槽位；英文键与中文键都认', () => {
  const partial = parseFocusBlock('【FOCUS】\nunfinished:卡在最后一步\n【/FOCUS】');
  assert.equal(partial.unfinished, '卡在最后一步');
  assert.equal(partial.requirements, undefined);
});

test('parseFocusBlock：没有收尾标记时解析到文本末尾；单行无分隔符被忽略', () => {
  const open = parseFocusBlock('【FOCUS】\n他的要求:早点睡\n这行没有分隔符');
  assert.equal(open.requirements, '早点睡');
});

test('parseFocusBlock：值截断 80 字；用中文冒号也能解析', () => {
  const long = parseFocusBlock(`【FOCUS】\n他的要求：${'啊'.repeat(100)}\n【/FOCUS】`);
  assert.equal(long.requirements.length, 80);
});

test('renderFocusBlock：按固定顺序渲染，空重点返回空串', () => {
  assert.equal(renderFocusBlock(null), '');
  assert.equal(renderFocusBlock({}), '');
  const text = renderFocusBlock({ noticed: '留意到的事', requirements: '他的要求', promises: '承诺的事' });
  assert.ok(text.startsWith('【今天要对焦的重点】'));
  assert.ok(text.includes('回复先看重点段'), '提示她先接重点');
  const order = ['他的要求', '她承诺的', '她没写', '她留意到的'].map((k) => text.indexOf(k));
  assert.ok(text.indexOf('他的要求') < text.indexOf('她承诺的'));
  assert.ok(text.indexOf('她承诺的') < text.indexOf('她留意到的'));
});

test('saveFocusBlock / loadFocus：往返一致；空块不落盘', () => {
  const file = tmpFile();
  assert.equal(saveFocusBlock({}, file), 0);
  assert.equal(fs.existsSync(file), false, '空块不该写文件');

  assert.equal(saveFocusBlock({ requirements: '别催睡觉' }, file), 1);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(j.at);
  assert.deepEqual(j.slots, { requirements: '别催睡觉' });
  assert.equal(loadFocus(file).requirements, '别催睡觉');
});

test('loadFocus：文件缺失/坏 JSON/没有 at → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-focus2-'));
  assert.equal(loadFocus(path.join(dir, 'nope.json')), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '不是 JSON', 'utf8');
  assert.equal(loadFocus(bad), null);
  const noAt = path.join(dir, 'noat.json');
  fs.writeFileSync(noAt, JSON.stringify({ slots: { requirements: 'x' } }), 'utf8');
  assert.equal(loadFocus(noAt), null);
});

test('loadFocus：超过 36 小时视为过期（文件不删，只当没有）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-focus3-'));
  const file = path.join(dir, 'old.json');
  const old = new Date(Date.now() - FOCUS_MAX_AGE_MS - 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ at: old, slots: { requirements: '旧的' } }), 'utf8');
  assert.equal(loadFocus(file), null);
  assert.equal(fs.existsSync(file), true, '过期不删文件');

  const fresh = path.join(dir, 'fresh.json');
  fs.writeFileSync(fresh, JSON.stringify({ at: new Date().toISOString(), slots: { requirements: '新的' } }), 'utf8');
  assert.equal(loadFocus(fresh).requirements, '新的');
});
