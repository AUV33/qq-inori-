// test-incident-replay.test.mjs · 事故可回放（E1 / R8「事故可回放」）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { replayIncident, gatherLogs } from '../scripts/incident-replay.mjs';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const ll = path.join(root, 'data/logs/life-log');
  fs.mkdirSync(ll, { recursive: true });
  fs.writeFileSync(path.join(ll, '2026-11-03.jsonl'), [
    { v: 1, type: 'message.received', at: NOW - 40 * MIN, key: 'group:1' },
    { v: 1, type: 'message.sent', at: NOW - 39 * MIN, key: 'group:1' },
    { v: 1, type: 'error.observed', at: NOW - 10 * MIN, payload: { msg: 'boom' } },
    { v: 1, type: 'life.tick', at: NOW + 5 * MIN },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const st = path.join(root, 'data/state');
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'action-log.jsonl'), [
    { ts: iso(NOW - 39 * MIN), t: 'turn', key: 'group:1', trigger: 'proactiveCheck', outcome: 'sent' },
    { ts: iso(NOW + 2 * MIN), t: 'turn', key: 'group:1', trigger: 'private', outcome: 'closed' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(st, 'floor-decisions.jsonl'), [
    { at: iso(NOW - 38 * MIN), key: 'group:1', directed: true, wake: true },
    { at: iso(NOW + 1 * MIN), key: 'group:1', directed: false, wake: false },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(st, 'lessons.jsonl'), [{ id: 'l1', text: 'x' }].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(st, 'evolution.jsonl'), [{ at: iso(NOW - 20 * MIN), kind: 'self_model_snapshot' }].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return root;
}

test('gatherLogs：多来源合并 + 按时间升序', () => {
  const root = fixture();
  const all = gatherLogs(root);
  assert.ok(all.length >= 7);
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i].at >= all[i - 1].at, '应升序');
  const sources = new Set(all.map((e) => e.source));
  for (const s of ['life-log', 'action-log', 'floor', 'lessons', 'evolution']) assert.ok(sources.has(s), `缺来源 ${s}`);
});

test('replayIncident：窗口裁剪 + 来源/类型计数 + 异常单列', () => {
  const root = fixture();
  const r = replayIncident({ root, around: NOW, windowMs: 30 * MIN });
  // 窗口 ±30m 应包含 [-40m..+5m] 之外排除的 -40m? -40m < -30m 边界 → 排除；+5m 在内。
  // 包含：error(-10m), life.tick(+5m), turn(NOW+2m), floor(NOW+1m), lesson? lessons 无 at → at=0 排除, evolution(-20m)
  assert.ok(r.events.length >= 4, '窗口内事件数: ' + r.events.length);
  for (const e of r.events) {
    assert.ok(e.at >= NOW - 30 * MIN && e.at <= NOW + 30 * MIN, '应在窗口内');
  }
  assert.ok(r.errors.length >= 1, '应检出 error.observed');
  assert.equal(r.errors[0].kind, 'error.observed');
  // 边界外事件（-40m 的 received）不应出现
  assert.ok(!r.events.some((e) => e.kind === 'message.received'), '窗口外 received 应被排除');
});

test('窗口可配；around 支持 ISO 字符串', () => {
  const root = fixture();
  const r = replayIncident({ root, around: iso(NOW), windowMs: 45 * MIN });
  // -40m 应在 45m 窗口内
  assert.ok(r.events.some((e) => e.kind === 'message.received'), '45m 窗口应包含 -40m 事件');
});

test('确定性：空目录不崩、count=0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-empty-'));
  const r = replayIncident({ root, around: NOW, windowMs: 30 * MIN });
  assert.equal(r.count, 0);
  assert.deepEqual(r.counts, {});
});
