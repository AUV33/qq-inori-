import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAlivenessReport, renderReport, writeAlivenessReport, computeCaughtRate, loadAlivenessHistory, renderTrend, checkAlivenessRegression } from '../scripts/aliveness-report.mjs';

const NOW = Date.UTC(2026, 10, 3, 14, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliveness-'));
  writeJsonl(path.join(root, 'data/logs/life-log/2026-11-03.jsonl'), [
    { v: 1, type: 'process.started', at: NOW - 2 * 3600e3, payload: { pid: 1 } },
    { v: 1, type: 'message.received', at: NOW - 3600e3, key: 'group:1', payload: {} },
    { v: 1, type: 'message.sent', at: NOW - 3500e3, key: 'group:1', payload: {} },
    { v: 1, type: 'life.tick', at: NOW - 1800e3, payload: { energy: 0.5 } },
    { v: 1, type: 'sleep.started', at: NOW - 1200e3, payload: {} },
    { v: 1, type: 'intention.shadow', at: NOW - 900e3, payload: { selected: 'rest' } },
    { v: 1, type: 'reflection.completed', at: NOW - 600e3, payload: {} },
  ]);
  writeJsonl(path.join(root, 'data/state/action-log.jsonl'), [
    { ts: iso(NOW - 3600e3), t: 'turn', key: 'group:1', trigger: 'proactiveCheck', outcome: 'sent' },
    { ts: iso(NOW - 3000e3), t: 'turn', key: 'group:1', trigger: 'private', outcome: 'sent' },
    { ts: iso(NOW - 2400e3), t: 'turn', key: 'group:1', trigger: 'selfWake', outcome: 'closed' },
  ]);
  writeJsonl(path.join(root, 'data/state/floor-decisions.jsonl'), [
    { at: iso(NOW - 3000e3), key: 'group:1', directed: true, wake: true },
    { at: iso(NOW - 2000e3), key: 'group:1', directed: false, wake: false },
  ]);
  writeJsonl(path.join(root, 'data/memory/memory.jsonl'), [
    { kind: 'fact', src: 'her', text: 'a' },
    { kind: 'fact', text: 'b' },
  ]);
  writeJsonl(path.join(root, 'data/memory/_archive/memory.jsonl'), [{ kind: 'fact', text: 'c' }]);
  writeJsonl(path.join(root, 'data/state/lessons.jsonl'), [{ id: 'l1', text: 'x' }, { id: 'l2', text: 'y' }]);
  writeJsonl(path.join(root, 'data/state/evolution.jsonl'), [{ at: iso(NOW - 1000), kind: 'self_model_snapshot' }]);
  fs.mkdirSync(path.join(root, 'data/state/mind'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/state/mind/self-state.json'), JSON.stringify({
    energy: 0.5, sleepDebt: 0.1, socialHunger: 0.3, curiosity: 0.4, competence: 0.5, stress: 0.1, valence: 0.1, arousal: 0.3, mood: 0.1,
  }));
  fs.writeFileSync(path.join(root, 'data/state/mind/beliefs.json'), JSON.stringify({ v: 1, people: { u1: {} }, groups: {} }));
  fs.writeFileSync(path.join(root, 'data/state/mind/offline-narrative.json'), JSON.stringify({ text: '离开了 2 小时' }));
  return root;
}

test('有数据：7 个维度齐全、分数有界、覆盖度合理', () => {
  const root = fixture();
  const r = buildAlivenessReport({ root, now: NOW, days: 7 });
  assert.equal(r.dimensions.length, 7);
  assert.ok(r.index >= 0 && r.index <= 100, 'index=' + r.index);
  assert.ok(r.coverage > 0 && r.coverage <= 1);
  for (const d of r.dimensions) {
    assert.ok(Number.isFinite(d.score) && d.score >= 0 && d.score <= 1, d.key + ' score');
  }
  const auto = r.dimensions.find((d) => d.key === 'autonomy');
  assert.equal(auto.evidence.proactive, 2, '本 fixture 的主动触发为 2');
  const social = r.dimensions.find((d) => d.key === 'social');
  assert.equal(social.evidence.received, 1);
  assert.equal(social.evidence.sent, 1);
  assert.equal(social.evidence.missedDirected, 0, 'fixture 的 directed 唤醒有对应 sent 回合');
  const integrity = r.dimensions.find((d) => d.key === 'integrity');
  assert.equal(integrity.status, 'no-data', '没有审计文件不能给满分');
});

test('空目录：不崩、低分、覆盖度低', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliveness-empty-'));
  const r = buildAlivenessReport({ root, now: NOW, days: 7 });
  assert.ok(r.index >= 0 && r.index <= 100);
  assert.ok(r.coverage < 0.5, 'coverage=' + r.coverage);
  assert.equal(r.dimensions.find((d) => d.key === 'memory').status, 'no-data');
});

test('确定性：同输入同输出；renderReport 含表头', () => {
  const root = fixture();
  const a = buildAlivenessReport({ root, now: NOW, days: 7 });
  const b = buildAlivenessReport({ root, now: NOW, days: 7 });
  assert.deepEqual(a, b);
  assert.match(renderReport(a), /Aliveness Index/);
  assert.match(renderReport(a), /\| 维度 \| 权重 \| 分数 \| 状态 \| 证据 \|/);
});

test('ISO 字符串时间也能被窗口过滤（floor/evolution）', () => {
  const root = fixture();
  const r = buildAlivenessReport({ root, now: NOW, days: 7 });
  const social = r.dimensions.find((d) => d.key === 'social');
  assert.ok(social.evidence.directedFloor >= 1, 'ISO at 应被解析');
  const growth = r.dimensions.find((d) => d.key === 'growth');
  assert.ok(growth.evidence.evolution >= 1, 'ISO at 的 evolution 应被计入');
});

test('writeAlivenessReport：落盘 json + md，内容可读', () => {
  const root = fixture();
  const r = buildAlivenessReport({ root, now: NOW, days: 7 });
  const out = writeAlivenessReport(r, { root, now: NOW });
  assert.ok(out.json.endsWith('.json'));
  assert.ok(out.md.endsWith('.md'));
  const saved = JSON.parse(fs.readFileSync(out.json, 'utf8'));
  assert.equal(saved.index, r.index);
  assert.match(fs.readFileSync(out.md, 'utf8'), /Aliveness Index/);
});

test('R7 接线：reflection.completed 抬升成长分，reflection.failed 不混入', () => {
  const root = fixture();
  const base = buildAlivenessReport({ root, now: NOW, days: 7 });
  const g0 = base.dimensions.find((d) => d.key === 'growth');
  assert.equal(g0.evidence.reflections, 1, 'fixture 自带 1 条 completed');

  const file = path.join(root, 'data/logs/life-log/2026-11-03.jsonl');
  const extra = [
    ...Array.from({ length: 3 }, (_, i) => ({ v: 1, type: 'reflection.completed', at: NOW - 500e3 - i * 1000, payload: { added: 1, ok: true } })),
    ...Array.from({ length: 5 }, (_, i) => ({ v: 1, type: 'reflection.failed', at: NOW - 400e3 - i * 1000, payload: { added: 0, ok: false, reason: 'none' } })),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file, extra, 'utf8');

  const after = buildAlivenessReport({ root, now: NOW, days: 7 });
  const g1 = after.dimensions.find((d) => d.key === 'growth');
  assert.equal(g1.evidence.reflections, 4, '新增 3 条 completed 计入，5 条 failed 不混入');
  assert.ok(g1.score > g0.score, '达标反思应抬升成长分，失败不应虚增');
});

test('computeCaughtRate：30 分钟内有人回算被接住；超时/不同会话不算', () => {
  const t0 = 1000000;
  const events = [
    { type: 'message.sent', key: 'group:1', at: t0, id: 's1' },
    { type: 'message.received', key: 'group:1', at: t0 + 1000 },
    { type: 'message.sent', key: 'private:2', at: t0 + 2000, id: 's2' },
    { type: 'message.received', key: 'private:2', at: t0 + 2000 + 31 * 60 * 1000 },
    { type: 'message.sent', key: 'group:1', at: t0 + 5000, id: 's3' },
    { type: 'message.received', key: 'group:9', at: t0 + 6000 },
  ];
  const r = computeCaughtRate(events, { windowMs: 30 * 60 * 1000 });
  assert.equal(r.sends, 3);
  assert.equal(r.caught, 1);
  assert.equal(r.rate, Number((1 / 3).toFixed(3)));
});

test('loadAlivenessHistory/renderTrend：按日期排序、算日变化、坏文件跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aliveness-hist-'));
  const dir = path.join(root, 'data/reports/aliveness');
  fs.mkdirSync(dir, { recursive: true });
  const mk = (day, index, coverage = 0.9) => ({ day, index, coverage, dimensions: [{ key: 'continuity', name: '连续性', score: index / 100 }] });
  fs.writeFileSync(path.join(dir, '2026-11-02.json'), JSON.stringify(mk('2026-11-02', 60)));
  fs.writeFileSync(path.join(dir, '2026-11-03.json'), JSON.stringify(mk('2026-11-03', 67.5)));
  fs.writeFileSync(path.join(dir, '2026-11-04.json'), JSON.stringify(mk('2026-11-04', 65)));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{bad');
  const rows = loadAlivenessHistory(root);
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-02', '2026-11-03', '2026-11-04']);
  const text = renderTrend(rows);
  assert.match(text, /2026-11-03/);
  assert.match(text, /\+7\.5/);
  assert.match(text, /-2\.5/);
  assert.match(text, /最新分维/);
  assert.equal(renderTrend([]), '暂无历史日报（先运行 --write 生成）');
});

test('checkAlivenessRegression：总分/分维下降超阈值才失败；不足两天不阻塞', () => {
  const mk = (day, index, score) => ({ day, index, coverage: 0.9, dimensions: [{ key: 'continuity', name: '连续性', score }] });
  assert.equal(checkAlivenessRegression([mk('d1', 60, 0.8)]).ok, true);
  assert.equal(checkAlivenessRegression([mk('d1', 60, 0.8)]).noBaseline, true);
  const ok = checkAlivenessRegression([mk('d1', 60, 0.8), mk('d2', 58, 0.75)]);
  assert.equal(ok.ok, true);
  const bad = checkAlivenessRegression([mk('d1', 60, 0.8), mk('d2', 50, 0.5)]);
  assert.equal(bad.ok, false);
  assert.ok(bad.drops.some((d) => d.kind === 'index'));
  assert.ok(bad.drops.some((d) => d.kind === 'dimension'));
});
