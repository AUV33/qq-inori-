// bootstrap 模块的最小金标：基础件行为正确、边界清楚。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeModeInput, VALID_MODES } from '../src/bootstrap/mode-utils.mjs';
import { readJsonSafe, atomicWriteJson } from '../src/bootstrap/fs-utils.mjs';
import {
  keyForAgentToken, rememberAgentToken, forgetAgentToken, KNOWN_AGENT_TOKENS,
} from '../src/bootstrap/agent-tokens.mjs';
import { createDiaryHelpers } from '../src/bootstrap/diary-helpers.mjs';
import { loadConfig } from '../src/bootstrap/config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bootstrap-'));

test('模式别名：历史拼写与规范名收敛到内部值', () => {
  assert.equal(normalizeModeInput('simulation'), 'reserved2');
  assert.equal(normalizeModeInput('reserved2'), 'reserved2');
  assert.equal(normalizeModeInput(' closed-agent '), 'closed-agent');
  assert.equal(normalizeModeInput('nonsense'), null);
  assert.deepEqual(VALID_MODES, ['chat', 'reserved', 'reserved2', 'closed-agent']);
});

test('readJsonSafe：BOM 容错、失败回退、required 抛错', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, '\uFEFF{"a":1}', 'utf8');
  assert.deepEqual(readJsonSafe(file, null), { a: 1 });
  assert.deepEqual(readJsonSafe(path.join(dir, 'missing.json'), { fallback: true }), { fallback: true });
  assert.throws(() => readJsonSafe(path.join(dir, 'missing.json'), null, true), /配置/);
});

test('atomicWriteJson：可回读且不留下临时文件', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  atomicWriteJson(file, { ok: 1 });
  assert.deepEqual(readJsonSafe(file, null), { ok: 1 });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('agent token 账本：按会话保留两代，forget 清掉', () => {
  rememberAgentToken('group:1', 'tok-a');
  rememberAgentToken('group:1', 'tok-b');
  assert.equal(keyForAgentToken('tok-b'), 'group:1');
  assert.equal(keyForAgentToken('tok-a'), null); // 只反查当前代
  assert.ok(KNOWN_AGENT_TOKENS.has('tok-b'));
  forgetAgentToken('group:1');
  assert.equal(keyForAgentToken('tok-b'), null);
  assert.equal(KNOWN_AGENT_TOKENS.has('tok-b'), false);
});

test('diary helpers：追加、今日已写、attempts 增减', () => {
  const dir = tmp();
  const daily = path.join(dir, 'daily.jsonl');
  const attempts = path.join(dir, 'attempts.json');
  const h = createDiaryHelpers({ dailyFile: daily, desktopDir: path.join(dir, 'desktop'), attemptsFile: attempts, log: () => {} });
  h.appendDailyDiary('2026-11-02', '今天很好');
  assert.equal(h.todayDiaryWritten('2026-11-02'), true);
  assert.equal(h.todayDiaryWritten('2026-11-03'), false);
  assert.equal(h.diaryAttempts('2026-11-02'), 0);
  assert.equal(h.bumpDiaryAttempts('2026-11-02'), 1);
  assert.equal(h.bumpDiaryAttempts('2026-11-02'), 2);
  h.dropDiaryAttempt('2026-11-02');
  assert.equal(h.diaryAttempts('2026-11-02'), 1);
});

test('loadConfig：最小配置得到完整默认值', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ownerQQ: 12345 }), 'utf8');
  const { cfg, raw } = loadConfig({ root: dir, log: () => {} });
  assert.equal(cfg.ownerQQ, 12345);
  assert.equal(cfg.dsh.model, 'deepseek-flash');
  assert.equal(cfg.consolePort, 3100);
  assert.equal(cfg.socialV2.tools.sendVoice, false);
  assert.equal(raw.ownerQQ, 12345);
});

// [REGRESSION] 2026-11-02 外提 config.mjs 时漏 import normalizeReasoningEffort：
// ReferenceError 被 try/catch 吞掉 → 每次启动都强制回退 max，低思考档位永远不生效。
test('loadConfig：合法 reasoningEffort 原样保留（不会被吞成默认值）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ownerQQ: 12345, dsh: { reasoningEffort: 'low' } }), 'utf8');
  const warnings = [];
  const { cfg } = loadConfig({ root: dir, log: (line) => warnings.push(String(line)) });
  assert.equal(cfg.dsh.reasoningEffort, 'low');
  assert.equal(warnings.some((line) => line.includes('非法')), false);
});

test('loadConfig：非法 reasoningEffort 回退默认值并告警', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ownerQQ: 12345, dsh: { reasoningEffort: 'turbo' } }), 'utf8');
  const warnings = [];
  const { cfg } = loadConfig({ root: dir, log: (line) => warnings.push(String(line)) });
  assert.equal(cfg.dsh.reasoningEffort, 'max');
  assert.equal(warnings.some((line) => line.includes('非法')), true);
});
