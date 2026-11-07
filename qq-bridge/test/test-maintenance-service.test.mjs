// maintenance-service 的运维金标：备份清理、日志裁剪、活动会话集合。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaintenance } from '../src/domain/shared/maintenance-service.mjs';

function ctx(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maint-'));
  const base = {
    fs, path,
    cfg: { sessionRetain: {}, socialV2: {} },
    log: () => {},
    state: { sessions: {} },
    isolatedSessions: new Map(),
    getSlangLearnerSessionId: () => null,
    learnerSessions: new Set(),
    transientArchiveTimers: new Map(),
    getTaskPoolRunning: () => [],
    planRetention: () => ({ candidates: [] }),
    sweepRetention: () => ({ removed: 0, bytes: 0 }),
    planStaleArchive: () => ({ ids: [] }),
    HER_WORKSPACE_DIR: dir,
    sessionKinds: {},
    RETENTION_DEFAULTS: { days: 7, ephemeralDays: 1, archiveStaleHours: 24 },
    dshHomeDir: () => dir,
    api: { workspace: { archiveSession: async () => {} } },
    getDshReady: () => false,
    MEM_DIR: dir,
    STATE_DATA_DIR: dir,
    stateDataPath: (...p) => path.join(dir, ...p),
    maintainMemoryDir: () => ({ compacted: 0, factsArchived: 0, archived: 0, files: 0, errors: [] }),
    pruneUtterances: () => ({ removed: 0, files: 0 }),
    pruneRaw: () => ({ removed: 0, files: 0 }),
    pruneEmbeddingCaches: () => ({ dropped: 0, removedFiles: 0, files: 0 }),
  };
  Object.assign(base, overrides);
  return { svc: createMaintenance(base), dir };
}

test('cleanupOldBackups：只删过期且匹配 .bak-* 的文件', () => {
  const h = ctx();
  const old = path.join(h.dir, 'a.bak-20260101');
  const fresh = path.join(h.dir, 'b.bak-20260101');
  const normal = path.join(h.dir, 'c.txt');
  for (const f of [old, fresh, normal]) fs.writeFileSync(f, 'x');
  const tenDaysAgo = Date.now() - 10 * 86400000;
  fs.utimesSync(old, new Date(tenDaysAgo), new Date(tenDaysAgo));
  fs.utimesSync(normal, new Date(tenDaysAgo), new Date(tenDaysAgo));
  h.svc._cleanupOldBackups(h.dir, 7);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(normal), true);
});

test('trimLogTail：只保留最后 N 行', () => {
  const h = ctx();
  const file = path.join(h.dir, 'log.jsonl');
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n');
  h.svc._trimLogTail(file, 3);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), ['line7', 'line8', 'line9']);
});

test('liveSessionIdSet：合并所有不能动的会话', () => {
  const h = ctx({
    state: { sessions: { 'group:1': 's1', 'private:2': 's2' } },
    isolatedSessions: new Map([['ownlife', 's3']]),
    getSlangLearnerSessionId: () => 's4',
    learnerSessions: new Set(['s5']),
    transientArchiveTimers: new Map([['s6', null]]),
    getTaskPoolRunning: () => [{ sessionId: 's7' }],
  });
  assert.deepEqual([...h.svc._liveSessionIdSet()].sort(), ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
});
