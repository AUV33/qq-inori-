// memory-organize-service 金标：dry-run 不动文件、apply 才归档、失败只记账不外抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryOrganize } from '../src/domain/memory/memory-organize-service.mjs';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memorg-'));
}

function makeCtx(dir, overrides = {}) {
  const logs = [];
  return {
    svc: createMemoryOrganize({
      fs, path, log: (m) => logs.push(String(m)), MEM_DIR: dir,
      cfg: { socialV2: { memory: { dir } } },
      planOrganize: (rows) => ({ total: rows.length, summary: { archived: 1, kept: rows.length - 1 }, index: { count: rows.length }, archiveIndexes: [0] }),
      atomicWriteJson: () => {},
      ...overrides,
    }),
    logs,
  };
}

function writeRows(dir, name, rows) {
  fs.writeFileSync(path.join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('dry-run：只出计划，不建 _archive、不动原文件', () => {
  const dir = makeDir();
  const { svc } = makeCtx(dir);
  writeRows(dir, 'memory.jsonl', [{ text: 'old' }, { text: 'new' }]);
  const out = svc.organizeMemoryFiles({ apply: false });
  assert.equal(out.files['memory.jsonl'].total, 2);
  assert.equal(out.archived, 0);
  assert.equal(fs.existsSync(path.join(dir, '_archive')), false);
  const rows = fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 2, 'dry-run 不能改原文件');
});

test('apply：旧快照进 _archive、原文件保留剩余行、并留一份 .bak-org 备份', () => {
  const dir = makeDir();
  const { svc, logs } = makeCtx(dir);
  writeRows(dir, 'memory.jsonl', [{ text: 'old', kind: 'summary' }, { text: 'new', kind: 'fact' }]);
  const out = svc.organizeMemoryFiles({ apply: true });
  assert.equal(out.archived, 1);
  const archived = fs.readFileSync(path.join(dir, '_archive', 'memory.jsonl'), 'utf8').trim();
  assert.ok(archived.includes('"old"'));
  assert.ok(JSON.parse(archived)._archived, '归档行要带 _archived 标记');
  const kept = fs.readFileSync(path.join(dir, 'memory.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(kept.map((r) => r.text), ['new']);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('memory.jsonl.bak-org-')), '要留备份');
  assert.ok(logs.some((l) => l.includes('旧快照归档 1 条')));
});

test('目录读不了 → 错误记进 out.errors，不抛', () => {
  const dir = makeDir();
  const { svc } = makeCtx(path.join(dir, 'nope'));
  const out = svc.organizeMemoryFiles({ apply: true });
  assert.equal(out.archived, 0);
  assert.equal(out.errors.length, 1);
});

test('单行 JSON 坏了只跳过该行，不整份丢弃', () => {
  const dir = makeDir();
  const { svc } = makeCtx(dir);
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), '{"text":"a"}\n不是JSON\n{"text":"b"}\n', 'utf8');
  const out = svc.organizeMemoryFiles({ apply: false });
  assert.equal(out.files['memory.jsonl'].total, 2, '坏行被跳过，好行都算');
});

test('整理结果会写 index.json（供检索层读）', () => {
  const dir = makeDir();
  const { svc } = makeCtx(dir);
  writeRows(dir, 'memory.jsonl', [{ text: 'a' }]);
  svc.organizeMemoryFiles({ apply: false });
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.files['memory.jsonl'].count, 1);
  assert.ok(index.at);
});
