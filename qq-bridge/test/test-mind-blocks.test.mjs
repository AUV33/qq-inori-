import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSelfStateLine, renderNarrativeLine, renderBeliefLine } from '../src/domain/mind/mind-blocks.mjs';

test('renderSelfStateLine：无状态/空对象 → 空串', () => {
  assert.equal(renderSelfStateLine(null), '');
  assert.equal(renderSelfStateLine({}), '');
  assert.equal(renderSelfStateLine('x'), '');
});

test('renderSelfStateLine：疲惫/社交饥饿/紧张会成句，且带“不是命令”的边界', () => {
  const line = renderSelfStateLine({ energy: 0.1, sleepDebt: 0.8, socialHunger: 0.9, curiosity: 0.7, stress: 0.7, mood: 0.1 });
  assert.match(line, /【此刻的自己】/);
  assert.match(line, /很累/);
  assert.match(line, /缺觉/);
  assert.match(line, /想找人说话/);
  assert.match(line, /好奇/);
  assert.match(line, /紧/);
  assert.match(line, /心情偏低/);
  assert.match(line, /不是命令/);
});

test('renderSelfStateLine：平静时不硬凑', () => {
  const line = renderSelfStateLine({ energy: 0.6, sleepDebt: 0.1, socialHunger: 0.4, curiosity: 0.3, stress: 0.1, mood: 0.45 });
  assert.equal(line, '');
});

test('renderNarrativeLine：空→空串；超长截断到 240 内', () => {
  assert.equal(renderNarrativeLine(''), '');
  assert.equal(renderNarrativeLine(null), '');
  const long = '长'.repeat(400);
  const line = renderNarrativeLine(long);
  assert.match(line, /【你不在的时候】/);
  assert.ok(line.length <= 260);
  assert.match(line, /…/);
});

test('renderBeliefLine：空/无有效字段 → 空串', () => {
  assert.equal(renderBeliefLine(null), '');
  assert.equal(renderBeliefLine({}), '');
  assert.equal(renderBeliefLine({ familiarity: null, trust: null }), '');
});

test('renderBeliefLine：熟悉/信任/常聊/未解之事成句，且只取前几项', () => {
  const line = renderBeliefLine({
    familiarity: 0.8, trust: 0.75,
    topics: { 猫: 0.9, 工作: 0.5, 游戏: 0.4, 忽略: 0.01 },
    openLoops: [{ status: 'open', topic: '面试' }, { status: 'open', topic: '显卡驱动' }, { status: 'open', topic: '第三件' }, { status: 'closed', topic: '旧事' }],
  });
  assert.match(line, /【你记着他】/);
  assert.match(line, /认识很久了/);
  assert.match(line, /你信他/);
  assert.match(line, /常聊：猫、工作、游戏/);
  assert.match(line, /你还记着 3 件没说完的事/);
  assert.match(line, /面试/);
  assert.equal(line.includes('旧事'), false);
});

test('renderBeliefLine：低信任/初识用另一种说法', () => {
  const line = renderBeliefLine({ familiarity: 0.1, trust: 0.2 });
  assert.match(line, /刚认识不久/);
  assert.match(line, /你还不太信他/);
});
