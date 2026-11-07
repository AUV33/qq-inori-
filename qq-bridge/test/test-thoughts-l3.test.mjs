import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickRenderableThoughts } from '../src/domain/leaves/inori-thoughts.js';
import { normalizeSlangEntry, saveSlang, pruneStaleCandidates } from '../src/domain/social/slang-learner.js';

test('念头注入：跳过纯英文行，保留中文，条数上限生效', () => {
  const rows = [
    { text: 'The instructions say every turn should end with a wake decision.' },
    { text: '路线已经铺好了。' },
    { text: 'actually qq_set_own_life_rhythm is a tool I could call' },
    { text: '四点半过了。' },
  ];
  const got = pickRenderableThoughts(rows, 3);
  assert.deepEqual(got.map((r) => r.text), ['路线已经铺好了。', '四点半过了。']);
});

test('念头注入：全英文时返回空', () => {
  assert.deepEqual(pickRenderableThoughts([{ text: 'ok so next step is to call the tool' }], 3), []);
});

test('normalizeSlangEntry：staledAt 往返不丢（L3）', () => {
  const e = normalizeSlangEntry({ content: '偷包', status: 'stale', count: 1, staledAt: '2026-10-31T00:00:00.000Z' });
  assert.equal(e.status, 'stale');
  assert.equal(e.staledAt, '2026-10-31T00:00:00.000Z');
});

test('saveSlang：返回 staled 且写入 stale 状态', () => {
  const tmp = path.join(os.tmpdir(), '_slang-l3-probe.json');
  const now = Date.now();
  const old = new Date(now - 10 * 86400000).toISOString();
  const r = saveSlang(tmp, [
    { content: 'a', status: 'candidate', count: 1, updatedAt: old },
    { content: 'b', status: 'candidate', count: 2, updatedAt: old },
  ], { staleDays: 7 });
  assert.equal(r.staled, 1);
  assert.equal(r.entries.find((e) => e.content === 'a').status, 'stale');
  assert.ok(r.entries.find((e) => e.content === 'a').staledAt);
  fs.unlinkSync(tmp);
});
