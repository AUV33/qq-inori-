// test-ownlife-assoc.test.mjs · S7d-c：独处提示末尾可带一条联想；没内容不加、出错不挡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ownlife-assoc-'));
process.env.PROMPT_DIR = path.join(ROOT, 'prompts');
process.env.LEARNING_TREND = path.join(ROOT, 'learning-trend.jsonl');

const { createOwnLife, DEFAULT_TEXT_DAY } = await import('../src/domain/social/own-life.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeLife(over = {}) {
  const delivered = [];
  const life = createOwnLife({
    key: 'private:1',
    deliver: async (text) => { delivered.push(text); },
    statePath: path.join(ROOT, `state-${Math.random().toString(36).slice(2)}.json`),
    log: () => {},
    ...over,
  });
  return { life, delivered };
}

test('extraLines 追加在提示末尾；空串保持原文；抛错不挡投递', async () => {
  const h = makeLife({ extraLines: () => '【顺带想起（关联激活，不是检索结果）】\n- 那本书还没看完' });
  const r = await h.life.fireNow();
  assert.equal(r.ok, true);
  assert.ok(h.delivered[0].startsWith(DEFAULT_TEXT_DAY));
  assert.match(h.delivered[0], /那本书还没看完/);
  assert.match(h.delivered[0], /顺带想起/);

  const plain = makeLife({});
  await plain.life.fireNow();
  assert.equal(plain.delivered[0], DEFAULT_TEXT_DAY, '没有联想就不加空行');

  const boom = makeLife({ extraLines: () => { throw new Error('图坏了'); } });
  const rb = await boom.life.fireNow();
  assert.equal(rb.ok, true);
  assert.equal(boom.delivered[0], DEFAULT_TEXT_DAY, '联想出错不能挡独处');
});

test('接线：ownlife-service 透传 extraLines，app 从记忆图生成', () => {
  const svc = fs.readFileSync(path.join(HERE, '..', 'src/domain/social/ownlife-service.mjs'), 'utf8');
  assert.match(svc, /getIdleAssociationLine/);
  assert.match(svc, /extraLines:/);
  const app = fs.readFileSync(path.join(HERE, '..', 'src/app.mjs'), 'utf8');
  assert.match(app, /buildOwnlifeAssociationLine/);
  assert.match(app, /idleAssociations/);
  assert.match(app, /getIdleAssociationLine: buildOwnlifeAssociationLine/);
});
