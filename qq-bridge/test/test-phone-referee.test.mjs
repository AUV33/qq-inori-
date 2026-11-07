// test-phone-referee.test.mjs · S9e：截图/读屏文字/读状态适配器；没有能力时 unknown，不猜。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPhoneReferee, runAtomicStep } from '../src/domain/leaves/action-observe.mjs';

test('读屏文字裁判：包含期望=met；没有文字=unknown；分类器可覆盖', async () => {
  const judges = createPhoneReferee({
    captureScreen: async () => ({ hash: 'h1', text: '结算 胜利 理智36' }),
    readState: async (area) => (area === '理智' ? 36 : undefined),
  });
  const met = await runAtomicStep({
    action: async () => {}, observe: async () => ({ hash: 'h1' }),
    criteria: ['画面: 胜利', '状态: 理智=36'], judges,
  });
  assert.equal(met.result, 'met');

  const noText = createPhoneReferee({ captureScreen: async () => ({ hash: 'h2' }) });
  const unknown = await runAtomicStep({
    action: async () => {}, observe: async () => ({ hash: 'h2' }),
    criteria: ['画面: 胜利'], judges: noText,
  });
  assert.equal(unknown.result, 'unknown', '没有读屏文字/视觉模型不能判通过');

  const classifier = createPhoneReferee({
    captureScreen: async () => ({ hash: 'h3' }),
    classify: async () => ({ met: null, evidence: '视觉模型不确定' }),
  });
  const unsure = await runAtomicStep({
    action: async () => {}, observe: async () => ({ hash: 'h3' }),
    criteria: ['画面: 胜利'], judges: classifier,
  });
  assert.equal(unsure.result, 'unknown');
});

test('没有 captureScreen 时画面裁判仍返回 unknown；状态读取缺失也 unknown', async () => {
  const judges = createPhoneReferee({});
  const r = await runAtomicStep({
    action: async () => {}, observe: async () => ({}),
    criteria: ['画面: x', '状态: 理智=36'], judges,
  });
  assert.equal(r.result, 'unknown');
  assert.equal(r.counts.unknown, 2);
});
