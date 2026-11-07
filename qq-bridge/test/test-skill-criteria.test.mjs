// test-skill-criteria.test.mjs · 宪章 §5.8：判据从 3 种扩到 6 种，没裁判不假装通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExtendedCriteria, judgeExtendedCriteria } from '../src/domain/leaves/skill-criteria.mjs';
import { parseVerifySpec, checkVerify } from '../src/domain/leaves/inori-skill-verify.js';

test('解析：画面/变化/状态（中英）+ 不是扩展判据返回 null', () => {
  assert.deepEqual(
    (({ type, target, expected }) => ({ type, target, expected }))(parseExtendedCriteria('画面: 结算界面')),
    { type: 'screen', target: '结算界面', expected: '结算界面' },
  );
  assert.equal(parseExtendedCriteria('screen: victory').type, 'screen');
  assert.equal(parseExtendedCriteria('变化: 有变化').type, 'diff');
  assert.equal(parseExtendedCriteria('diff: unchanged').expected, 'unchanged');
  const state = parseExtendedCriteria('状态: 理智=36');
  assert.equal(state.type, 'state');
  assert.equal(state.target, '理智');
  assert.equal(state.expected, '36');
  assert.equal(parseExtendedCriteria('文件: C:/x'), null);
  assert.equal(parseExtendedCriteria('随便写点'), null);
});

test('画面判据：视觉裁判说 met 才通过；没接裁判返回 null', async () => {
  const judges = {
    captureScreen: async () => ({ hash: 'h1', path: 'shot.png' }),
    visionJudge: async ({ expect }) => ({ met: expect === '结算界面', evidence: '看到了结算' }),
  };
  const ok = await judgeExtendedCriteria(parseExtendedCriteria('画面: 结算界面'), judges);
  assert.equal(ok.ok, true);
  assert.match(ok.evidence, /结算/);

  const no = await judgeExtendedCriteria(parseExtendedCriteria('画面: 主菜单'), judges);
  assert.equal(no.ok, false);
  const missing = await judgeExtendedCriteria(parseExtendedCriteria('画面: 结算界面'), {});
  assert.equal(missing.ok, null, '没有视觉裁判不能假装通过');
  assert.match(missing.evidence, /未接视觉裁判/);
});

test('变化判据：前后 hash 不同=有变化；也能用注入的 compareScreens', async () => {
  let n = 0;
  const capture = async () => ({ hash: n++ === 0 ? 'a' : 'b' });
  const changed = await judgeExtendedCriteria(parseExtendedCriteria('变化: 有变化'), { captureScreen: capture });
  assert.equal(changed.ok, true);

  const same = await judgeExtendedCriteria(parseExtendedCriteria('变化: 无变化'), { captureScreen: async () => ({ hash: 'x' }) });
  assert.equal(same.ok, true);

  const custom = await judgeExtendedCriteria(parseExtendedCriteria('变化: 有变化'), {
    compareScreens: async ({ expect }) => ({ met: expect === true, evidence: 'diff 0.42' }),
  });
  assert.equal(custom.ok, true);
  assert.match(custom.evidence, /0.42/);

  const missing = await judgeExtendedCriteria(parseExtendedCriteria('变化: 有变化'), {});
  assert.equal(missing.ok, null);
});

test('状态判据：数值/字符串比较；缺期望值或缺 readState 返回 null', async () => {
  const read = async (area) => (area === '理智' ? 36 : '结算');
  const ok = await judgeExtendedCriteria(parseExtendedCriteria('状态: 理智=36'), { readState: read });
  assert.equal(ok.ok, true);
  const bad = await judgeExtendedCriteria(parseExtendedCriteria('状态: 理智=35'), { readState: read });
  assert.equal(bad.ok, false);
  const str = await judgeExtendedCriteria(parseExtendedCriteria('状态: 界面=结算'), { readState: read });
  assert.equal(str.ok, true);

  assert.equal((await judgeExtendedCriteria(parseExtendedCriteria('状态: 理智'), { readState: read })).ok, null, '缺期望值');
  assert.equal((await judgeExtendedCriteria(parseExtendedCriteria('状态: 理智=36'), {})).ok, null, '缺裁判');
});

test('接线：skill_verify 解析 6 类；文件判据仍可用；新判据不执行 shell', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-criteria-'));
  const file = path.join(dir, 'done.txt');
  fs.writeFileSync(file, 'ok', 'utf8');
  assert.equal(parseVerifySpec(`文件: ${file}`).type, 'file');
  assert.equal(parseVerifySpec('画面: 结算').type, 'screen');
  assert.equal(parseVerifySpec('变化: 有变化').type, 'diff');
  assert.equal(parseVerifySpec('状态: 理智=36').type, 'state');

  // [AUDIT-FIX] file 判据现在只允许注入的 roots，临时目录要显式放行。
  const fileCheck = await checkVerify(`文件: ${file}`, { allowedRoots: [dir] });
  assert.equal(fileCheck.ok, true);

  const screenCheck = await checkVerify('画面: 结算', {
    captureScreen: async () => ({ hash: 'h' }),
    visionJudge: async () => ({ met: true, evidence: 'ok' }),
  });
  assert.equal(screenCheck.ok, true);

  const noJudge = await checkVerify('画面: 结算');
  assert.equal(noJudge.ok, null);
});
