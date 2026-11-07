// 可观测性修复的回归锁：error.observed 有生产者、sleep 事件、sent 口径、路径单一来源。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ignoredCatch, setErrorObserver, catchStats } from '../src/domain/shared/best-effort.js';
import { obsPaths } from '../scripts/lib/observability-paths.mjs';
import { discoverMemoryScopes } from '../scripts/lib/memory-scopes.mjs';
import { buildAlivenessReport } from '../scripts/aliveness-report.mjs';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('error.observed：单点上报、节流去重、观察者绝不抛', () => {
  const seen = [];
  setErrorObserver((e) => { seen.push(e); });
  try {
    ignoredCatch(new Error('boom'), 'test-observability:1');
    ignoredCatch(new Error('boom'), 'test-observability:1'); // 同来源 60s 内节流
    ignoredCatch(new Error('other'), 'test-observability:2');
    assert.equal(seen.length, 2, '按来源节流，不重复记账');
    assert.equal(seen[0].type, 'error.observed');
    assert.equal(seen[0].payload.source, 'test-observability:1');
    assert.equal(seen[1].payload.source, 'test-observability:2');
    assert.ok(catchStats()['test-observability:1'] >= 2, '计数仍然累加');

    setErrorObserver(() => { throw new Error('observer must not escape'); });
    assert.doesNotThrow(() => ignoredCatch(new Error('x'), 'test-observability:3'));
  } finally { setErrorObserver(null); }
  assert.doesNotThrow(() => ignoredCatch(new Error('no observer'), 'test-observability:4'));
});

test('obsPaths：单一来源，注入 root 时全部落在临时根下', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-obs-'));
  const P = obsPaths(tmp);
  assert.equal(P.lifeLog, path.join(tmp, 'data', 'logs', 'life-log'));
  assert.equal(P.actionLog, path.join(tmp, 'data', 'state', 'action-log.jsonl'));
  assert.equal(P.securityAudit, path.join(tmp, 'data', 'reports', 'security-audit.json'));
  assert.ok(P.alivenessDir.startsWith(tmp));
});

test('memory-scopes：动态发现记忆文件，源码里不再写死真实群号', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-scopes-'));
  const mem = path.join(tmp, 'data', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'memory.jsonl'), '');
  fs.writeFileSync(path.join(mem, 'memory-group_A.jsonl'), '');
  fs.writeFileSync(path.join(mem, 'memory-group_B.jsonl'), '');
  fs.writeFileSync(path.join(mem, 'notes.txt'), '');
  const scopes = discoverMemoryScopes(mem);
  assert.equal(scopes.length, 3);
  assert.deepEqual(scopes.map((s) => s.name), ['private', 'memory-group_A', 'memory-group_B']);
  assert.equal(scopes[1].cache, 'embeddings-group_A.json');
  assert.equal(discoverMemoryScopes(path.join(tmp, 'missing')).length, 1, '目录不存在时安全降级');

  // 源码里不允许再出现真实群号（privacy-scan 会拦）
  const root = path.resolve(process.cwd());
  for (const f of ['scripts/eval-memory-golden.mjs', 'scripts/memory-score-shadow.mjs', 'scripts/lib/memory-scopes.mjs']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/\d{9,11}/.test(text), `${f} 不应含真实群号`);
  }
});

test('Aliveness 社会耦合：sent 稀疏时用 sentTurns 计分，且标注生命线覆盖天数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-alive-'));
  const P = obsPaths(root);
  writeJsonl(path.join(P.lifeLog, '2026-11-04.jsonl'), [
    { v: 1, type: 'message.received', at: NOW - 3600e3, key: 'group:1' },
    { v: 1, type: 'message.sent', at: NOW - 3500e3, key: 'group:1' },
  ]);
  // 113 个 sent 回合，但生命线只有 1 条 message.sent
  writeJsonl(P.actionLog, Array.from({ length: 113 }, (_, i) => ({
    ts: iso(NOW - (113 - i) * 60000), t: 'turn', key: 'group:1', trigger: 'private', outcome: 'sent',
  })));
  writeJsonl(P.floorDecisions, [{ at: iso(NOW - 1000), key: 'group:1', directed: true, wake: true }]);
  writeJsonl(P.lessons, [{ id: 'l1', text: 'x' }]);
  writeJsonl(P.evolution, [{ at: iso(NOW - 1000), kind: 'self_model_snapshot' }]);
  fs.mkdirSync(path.join(P.state, 'mind'), { recursive: true });
  fs.writeFileSync(P.selfState, JSON.stringify({ energy: 0.5, sleepDebt: 0.1, socialHunger: 0.3, curiosity: 0.4, competence: 0.5, stress: 0.1, valence: 0.1, arousal: 0.3, mood: 0.1 }));
  fs.writeFileSync(P.beliefs, JSON.stringify({ v: 1, people: {}, groups: {} }));
  fs.writeFileSync(P.offlineNarrative, JSON.stringify({ text: '离开了 2 小时' }));
  writeJsonl(path.join(P.memory, 'memory.jsonl'), [{ kind: 'fact', text: 'a', src: 'her' }]);
  fs.mkdirSync(P.reports, { recursive: true });
  fs.writeFileSync(P.securityAudit, JSON.stringify({ v: 1, at: iso(NOW), ok: true, high: 0, medium: 0, low: 0 }));

  const r = buildAlivenessReport({ root, now: NOW, days: 7 });
  const social = r.dimensions.find((d) => d.key === 'social');
  const integrity = r.dimensions.find((d) => d.key === 'integrity');
  assert.equal(social.evidence.sent, 1);
  assert.equal(social.evidence.sentTurns, 113);
  assert.equal(social.evidence.sentSource, 'action-log.turn[outcome=sent]');
  assert.equal(social.evidence.lifeLogDays, 1, '明确标注生命线只覆盖 1 天');
  assert.ok(social.score > 0.5, '不因生命线接线晚而把社会分压到 0');
  assert.notEqual(integrity.status, 'no-data', '审计快照存在就不再恒为 no-data');
});
