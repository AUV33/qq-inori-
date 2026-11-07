// [ADDRESSED-JUDGE] 唤醒时先分清这轮是不是在说她（2026-10-30）
//
// 事故：群 123456789 里另一个 AI「小特的小鱼」报自己的余额/花销，她整体接成跟自己有关。
// 这条只在群聊注入（私聊不需要），是一个显式判断步骤，不是关键词规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addressedJudgmentLine } from '../src/domain/conversation/addressed-judgment.mjs';

test('群聊：注入判断段，点名/路过两种情况都写清', () => {
  const line = addressedJudgmentLine('group:123456789');
  assert.ok(line.includes('【先分清这轮是不是在说你】'), line);
  assert.ok(line.includes('有人@你、叫你名字、接你的话'), line);
  assert.ok(line.includes('自己的账、余额、花销、别的 AI'), line);
  assert.ok(line.includes('别把他们的数字和处境接成你自己的'), line);
});

test('私聊与空 key：不注入（省 token，私聊没有这类误判）', () => {
  assert.equal(addressedJudgmentLine('private:10001'), '');
  assert.equal(addressedJudgmentLine(''), '');
  assert.equal(addressedJudgmentLine(null), '');
  assert.equal(addressedJudgmentLine(undefined), '');
});

test('源码：唤醒流程真的把它拼进 prompt（群聊分支）', () => {
  const src = fs.readFileSync(new URL('../src/domain/conversation/wake-sender.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('const judge = addressedJudgmentLine(key);'), 'wake-sender 没调用');
  assert.ok(src.includes("promptText = judge + '\\n\\n' + promptText"), '没有拼进 prompt');
  const app = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("import { addressedJudgmentLine } from './domain/conversation/addressed-judgment.mjs'"), 'app.mjs 没 import');
  assert.ok(app.includes('addressedJudgmentLine,'), 'app.mjs 没注入 deps');
});
