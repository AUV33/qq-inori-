// [SKILL-ATTEMPT] 2026-10-30：注入过但没结算的技能，attempts 必须动一下。
//
// 现象：`明日方舟 adb 部署干员` 被注入 2709 次、attempts 永远是 0 —— 看起来像"从没试过"。
// 根因：app.mjs 里 `if (outcome === null) continue; // 不确定：只记 attempts`，注释说记，代码什么都没记。
// 现在：回合完成且真动过工具时，用 applyOutcome(ok=null) 记一次尝试（只加 attempts，不冒充成败）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, save, applyOutcome } from '../src/domain/leaves/inori-skills.js';

test('applyOutcome(ok=null)：只加 attempts，success/fail 不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-attempt-'));
  const file = path.join(dir, 'skills.json');
  save({ version: 1, items: [{ id: 's1', name: 'x', injected: 3, attempts: 0, success: 0, fail: 0, steps: [] }] }, file);
  const st = load(file);
  applyOutcome(st, 's1', { ok: null, source: 'turn' });
  save(st, file);
  const s = load(file).items[0];
  assert.equal(s.attempts, 1, 'attempts 应该 +1');
  assert.equal(s.success, 0, '不算成功');
  assert.equal(s.fail, 0, '不算失败');
  assert.equal(s.lastSource, 'turn');
});

test('源码：app.mjs 在 outcome=null 且回合完成、动过工具时记 attempts', () => {
  const src = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/domain/memory/tool-learning-service.mjs', import.meta.url), 'utf8');
  assert.ok(
    src.includes('if (completed && (Number(s.ok) || 0) + (Number(s.fail) || 0) > 0)'),
    '缺少「回合完成且真动过工具」这个条件',
  );
  assert.ok(!src.includes('if (outcome === null) continue;'), '旧的直接 continue 应该已经改掉');
  assert.ok(src.includes("applyOutcome(store, id, { ok: null, source: 'turn' })"), '缺少 ok:null 记账');
});
