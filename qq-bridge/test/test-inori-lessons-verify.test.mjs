// [VOYAGER] 经验带「怎么验」——回归锁。
//
// 参考 Voyager 的「执行反馈 + 自我验证」：学一条经验时顺手写下判据，
// 以后能回头验；不是让文案更好看，是给学习闭环一个可检查的落点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, load } from '../src/domain/leaves/inori-lessons.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('lesson 写入 verify，读回还在', () => {
  const list = [];
  const r = add(list, '他说累的时候别急着给建议', { kind: 'about-him', verify: '下次他说累，我只回一句不劝' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.verify, '下次他说累，我只回一句不劝');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-')), 'lessons.jsonl');
  fs.writeFileSync(file, JSON.stringify(r.entry) + '\n', 'utf8');
  const back = load(file);
  assert.equal(back[0].verify, '下次他说累，我只回一句不劝');
});

test('没写 verify 就是空串（不编造判据）', () => {
  const list = [];
  const r = add(list, '先卡 S 再取 H');
  assert.equal(r.entry.verify, '');
});

test('重复记同一条：不新增，也不报错', () => {
  const list = [];
  add(list, '群里冷场的时候别硬找话题', { kind: 'about-me' });
  const again = add(list, '群里冷场的时候别硬找话题', { kind: 'about-me', verify: '冷场时数 10 秒，没话说就不发' });
  assert.equal(again.ok, false);
  assert.equal(list.length, 1);
});
