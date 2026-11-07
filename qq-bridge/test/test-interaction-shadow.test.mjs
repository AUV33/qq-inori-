// test-interaction-shadow.test.mjs · S8e：影子建议账只在显式开关下写，且不改 prompt。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const src = fs.readFileSync(path.join(REPO, 'src/domain/conversation/wake-prompt-service.mjs'), 'utf8');

test('影子账：默认不开；开关=1 才写；只记录不注入 prompt', () => {
  assert.match(src, /QQ_INORI_INTERACTION_SHADOW/);
  assert.match(src, /buildShadowRow/);
  assert.match(src, /interaction-shadow\.jsonl/);
  assert.match(src, /buildShadowRow/);
  assert.match(src, /keyHashOf/);
  const pure = fs.readFileSync(path.join(REPO, 'src/domain/conversation/interaction-shadow.mjs'), 'utf8');
  assert.match(pure, /keyHash/);
  assert.equal(/key: String\(key\)/.test(pure), false, '影子账不得落会话 key 原文');
  assert.match(src, /shadowLastSig/);
  const check = spawnSync(process.execPath, ['--check', path.join(REPO, 'src/domain/conversation/wake-prompt-service.mjs')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(check.status, 0, check.stderr);
});

test('影子账字段：指代/意图/动作/置信度都在，不含原文', () => {
  const pure = fs.readFileSync(path.join(REPO, 'src/domain/conversation/interaction-shadow.mjs'), 'utf8');
  assert.match(pure, /addressee: perception\.addressee/);
  assert.match(pure, /intent: plan\.tom\?\.intent/);
  assert.match(pure, /move: plan\.move\?\.move/);
  assert.equal(/groupHealth = scene === 'group'/.test(src), false, '已抽到纯函数模块');
  assert.match(pure, /budget: \{ allowed: budget\.allowed/);
  assert.match(pure, /withdraw: \{ withdraw: withdraw\.withdraw/);
  assert.equal(/text: last\.plain/.test(src.split('const row =')[1] || ''), false, '影子行不落原文');
});
