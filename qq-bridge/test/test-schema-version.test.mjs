import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSchemas, DATASETS } from '../src/domain/shared/schema-version.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-schema-'));
}

function writeFixtures(dir) {
  fs.writeFileSync(path.join(dir, 'lessons.jsonl'), JSON.stringify({ id: 'l1', text: '旧经验' }) + '\n');
  fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify({ version: 1, items: [{ id: 's1', name: '旧技能' }] }));
  fs.writeFileSync(path.join(dir, 'cognition.jsonl'), JSON.stringify({ id: 'c1', text: '旧认知' }) + '\n');
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({}));
}

test('首次登记：补默认值、写清单、留备份', () => {
  const dir = tmpDir();
  writeFixtures(dir);
  const logs = [];
  const report = ensureSchemas({ dir, log: (l) => logs.push(l) });
  assert.deepEqual(Object.keys(report.manifest).sort(), ['cognition', 'lessons', 'memory', 'skills']);

  const lessons = JSON.parse(fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8').trim());
  assert.equal(lessons.confidence, 0.7);
  assert.equal(lessons.up, 0);
  assert.equal(lessons.down, 0);
  assert.equal(lessons.text, '旧经验', '旧值不许被改写');

  const skills = JSON.parse(fs.readFileSync(path.join(dir, 'skills.json'), 'utf8'));
  assert.equal(skills.items[0].attempts, 0);
  assert.equal(skills.items[0].name, '旧技能');
  assert.equal(skills.schemaVersion, DATASETS.skills.current);

  const cog = JSON.parse(fs.readFileSync(path.join(dir, 'cognition.jsonl'), 'utf8').trim());
  assert.equal(cog.kind, 'general');
  assert.deepEqual(cog.evidence, []);

  const backups = fs.readdirSync(dir).filter((n) => n.includes('.bak-schema-'));
  assert.ok(backups.length >= 3, backups.join(','));
  assert.ok(logs.some((l) => l.includes('lessons')));
});

test('幂等：第二次跑不再改文件（含清单与备份）', () => {
  const dir = tmpDir();
  writeFixtures(dir);
  ensureSchemas({ dir });
  const before = {
    lessons: fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8'),
    skills: fs.readFileSync(path.join(dir, 'skills.json'), 'utf8'),
    manifest: fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'),
    backups: fs.readdirSync(dir).filter((n) => n.includes('.bak-schema-')).length,
  };
  const report = ensureSchemas({ dir });
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.normalized, []);
  assert.equal(fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8'), before.lessons);
  assert.equal(fs.readFileSync(path.join(dir, 'skills.json'), 'utf8'), before.skills);
  // 2026-10-28 修：清单内容没变时不再重写/不再留 .bak（桥接频繁重启会让备份无界增长）
  assert.equal(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'), before.manifest);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.bak-schema-')).length, before.backups);
});

test('备份有上限：同文件最多保留 5 份', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'lessons.jsonl'), JSON.stringify({ id: 'l1', text: 'x' }) + '\n');
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ lessons: { version: 1 } }));
  for (let i = 0; i < 7; i += 1) {
    fs.writeFileSync(path.join(dir, `lessons.jsonl.bak-schema-2026-01-0${i + 1}T00-00-00-000Z`), 'x');
  }
  ensureSchemas({ dir });
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('lessons.jsonl.bak-schema-'));
  assert.ok(backups.length <= 5, `实际 ${backups.length} 份：${backups.join(',')}`);
});

test('dryRun：只报告，不落盘', () => {
  const dir = tmpDir();
  writeFixtures(dir);
  const report = ensureSchemas({ dir, dryRun: true });
  // 内存里的计划要能看到目标版本，但文件一律不动
  assert.ok(report.manifest.lessons);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8')).lessons, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8').trim()).confidence, undefined);
});

test('清单版本比代码新：拒绝改动并告警', () => {
  const dir = tmpDir();
  writeFixtures(dir);
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ lessons: { version: 9 } }));
  const before = fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8');
  const report = ensureSchemas({ dir });
  assert.equal(fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8'), before);
  assert.ok(report.warnings.some((w) => w.includes('lessons')));
  assert.ok(report.skipped.includes('lessons'));
});

test('从旧版本升级：按链迁移并推进版本号', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'lessons.jsonl'), JSON.stringify({ id: 'l1', text: 'x' }) + '\n');
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ lessons: { version: 1 } }));
  const report = ensureSchemas({ dir });
  assert.ok(report.changed.includes('lessons'));
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8').trim());
  assert.equal(row.confidence, 0.7);
  assert.equal(report.manifest.lessons.version, DATASETS.lessons.current);
});

test('没有数据文件也不崩：只登记版本', () => {
  const dir = tmpDir();
  const report = ensureSchemas({ dir });
  assert.ok(report.manifest.lessons);
  assert.ok(report.skipped.includes('lessons'));
  assert.equal(fs.existsSync(path.join(dir, 'schema.json')), true);
});
