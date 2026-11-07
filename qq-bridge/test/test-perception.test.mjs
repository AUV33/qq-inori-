// test-perception.test.mjs · 宪章 §5.16：先感知（对谁说/在做什么），再反应。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { perceiveInbound, speechActOf, renderPerceptionLine } from '../src/domain/conversation/perception.mjs';

const SELF = '999';
const OWNER = '10001';
const base = { selfId: SELF, ownerId: OWNER, kind: 'group', text: '今天好累' };

test('指代：私聊/点名/引用/叫别人/泛说 分得清', () => {
  assert.equal(perceiveInbound({ ...base, kind: 'private', senderId: OWNER, text: '在吗' }).addressee, 'her');
  assert.equal(perceiveInbound({ ...base, senderId: '10002', mentionedIds: [SELF] }).addressee, 'her');
  assert.equal(perceiveInbound({ ...base, senderId: '10002', quoteTargetIsSelf: true }).addressee, 'her');
  assert.equal(perceiveInbound({ ...base, senderId: '10002', mentionedIds: ['10003'] }).addressee, 'other');
  assert.equal(perceiveInbound({ ...base, senderId: '10002', mentionedIds: ['all'] }).addressee, 'broadcast');
  const plain = perceiveInbound({ ...base, senderId: '10002' });
  assert.equal(plain.addressee, 'broadcast');
  assert.ok(plain.candidates.length >= 2, '泛说至少保留两种读法');
});

test('多读法：群里的问题在"问她"和"问大家"之间保留不确定性', () => {
  const p = perceiveInbound({ ...base, senderId: '10002', text: '这个怎么弄？' });
  assert.equal(p.speechAct, 'question');
  assert.ok(p.candidates.some((c) => c.reading.includes('问她')));
  assert.ok(p.candidates.some((c) => c.reading.includes('泛说') || c.reading.includes('群里')));
  assert.ok(p.ambiguity > 0, '歧义要显式，不假装确定');
});

test('动作识别：提问/请求/玩笑/抱怨/退开/炫耀/表情/沉默', () => {
  assert.equal(speechActOf('这个怎么弄？'), 'question');
  assert.equal(speechActOf('能不能帮我看看'), 'request');
  assert.equal(speechActOf('哈哈哈哈笑死'), 'tease');
  assert.equal(speechActOf('今天好烦啊'), 'complaint');
  assert.equal(speechActOf('算了不说了'), 'withdraw');
  assert.equal(speechActOf('我考了第一'), 'brag');
  assert.equal(speechActOf('😂😂'), 'emoji');
  assert.equal(speechActOf(''), 'silence');
  assert.equal(speechActOf('今天吃了面'), 'statement');
});

test('渲染：一行可读，带不确定度；无感知返回空串', () => {
  const p = perceiveInbound({ ...base, senderId: OWNER, kind: 'private', text: '在吗' });
  const line = renderPerceptionLine(p);
  assert.match(line, /感知：/);
  assert.match(line, /提问/);
  assert.match(line, /不确定/);
  assert.equal(renderPerceptionLine(null), '');
});

test('接线：social-append 对入站消息挂 perception（不改回复行为）', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'src/domain/social/social-append.mjs'), 'utf8');
  assert.match(src, /perceiveInbound/);
  assert.match(src, /perception: \{ addressee:/);
});
