// test-legislation-consumption.test.mjs · 审计 P1-6：账本必须真的有运行时读端。
// 三个写入账本没有消费者 = "上线"只是写盘死路；这里锁住 state-hub → 渲染 → 唤醒 prompt 的链路。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLegislationStore } from '../src/domain/life/legislation.mjs';
import { createStateHub } from '../src/domain/mind/state-hub.mjs';
import { renderLegislationLine } from '../src/domain/mind/mind-blocks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const T = Date.UTC(2026, 10, 5, 12);

test('state-hub 读得到立法账；控制台新写的下轮可见（现读，不缓存旧账）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-legislation-'));
  const previousTrend = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const store = createLegislationStore({ root, now: () => T });
    await store.makeCommitment({ text: '每天睡前回读一次账本', penalty: '把 decoFloor 调回 0.3' }, { writer: 'her' });
    await store.makeCommitment({ text: '不熬夜查资料' }, { writer: 'her' });
    await store.resolveCommitment((await store.state()).commitments[1].id, 'kept', {}, { writer: 'her' });
    await store.decline({ target: '每日主动提案', reason: '不想变成打卡机器' }, { writer: 'her' });
    await store.assessTrust({ value: 0.62, reason: '答应自己的事做到了' }, { writer: 'her' });

    const hub = createStateHub({ root, now: () => T, log: () => {} });
    hub.load();
    const view = hub.getLegislation();
    assert.equal(view.facts.total, 2);
    assert.equal(view.facts.kept, 1);
    assert.equal(view.commitments.length, 1, '只列生效中的法');
    assert.match(view.commitments[0].text, /回读一次账本/);
    assert.equal(view.declined.length, 1);
    assert.equal(view.selfTrust.value, 0.62);
    assert.equal(hub.status().legislation.total, 2);

    await store.makeCommitment({ text: '新立的法' }, { writer: 'her' });
    assert.equal(hub.getLegislation().facts.active, 2, '写入后下一轮读取必须可见');
  } finally {
    if (previousTrend === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previousTrend;
  }
});

test('渲染：只递事实，空账返回空串，不催执行', () => {
  assert.equal(renderLegislationLine(null), '');
  assert.equal(renderLegislationLine({ facts: { active: 0, kept: 0, broken: 0 } }), '');
  const text = renderLegislationLine({
    facts: { active: 1, kept: 2, broken: 0 },
    commitments: [{ text: '每天睡前回读一次账本' }],
    selfTrust: { value: 0.62, reason: '答应自己的事做到了' },
    declined: [{ target: '每日主动提案' }],
  });
  assert.match(text, /你自己立的法：1 条生效，已兑现 2，食言 0/);
  assert.match(text, /每天睡前回读一次账本/);
  assert.match(text, /0\.62/);
  assert.match(text, /每日主动提案/);
  assert.equal(/你应该|请执行|必须做/.test(text), false, '不得变成训诫/命令');
});

test('接线：state-hub → wake-prompt-service → wake-prompt 三处都在', () => {
  const hub = read('src/domain/mind/state-hub.mjs');
  assert.match(hub, /getLegislation/);
  assert.match(hub, /foldCommitments/);
  const service = read('src/domain/conversation/wake-prompt-service.mjs');
  assert.match(service, /renderLegislationLine/);
  assert.match(service, /getMindLegislation/);
  const prompt = read('src/domain/persona/wake-prompt.mjs');
  assert.match(prompt, /mindLegislationLine/);
  const app = read('src/app.mjs');
  assert.match(app, /getMindLegislation: \(\) =>/);
});
