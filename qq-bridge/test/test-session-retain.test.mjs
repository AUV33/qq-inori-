import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  planRetention,
  sweepRetention,
  planStaleArchive,
  planOrphanRetention,
  indexSessionDirs,
  findHerWorkspace,
  EPHEMERAL_KINDS,
} from '../src/domain/leaves/inori-session-retain.js';

const DAY = 86400000;

function mkHome({ herDir = 'D:\\fake\\qq-bridge\\state\\agents', otherDir = 'D:\\fake\\other' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-retain-'));
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  const wsDir = path.join(home, 'sessions', '--fake-agents--');
  fs.mkdirSync(wsDir, { recursive: true });
  return { home, wsDir, herDir, otherDir };
}

function writeStore(home, { herDir, herIds = [], archived = [] }) {
  const store = {
    global: { archivedSessionIds: archived },
    tables: {
      workspaces: {
        w1: { id: 'w1', path: herDir, title: '她', sessionIds: herIds },
        w2: { id: 'w2', path: 'D:\\fake\\other', title: '别的', sessionIds: [] },
      },
    },
  };
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(store), 'utf8');
  return store;
}

function makeSession(home, id, { ageDays = 0, bytes = 100, wsDirName = '--fake-agents--' } = {}) {
  const dir = path.join(home, 'sessions', wsDirName, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(file, t, t);
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

test('planRetention 只挑「已归档 + 不在用 + 超期」', () => {
  const { home, herDir } = mkHome();
  const ids = ['session-old', 'session-fresh', 'session-live', 'session-unarchived', 'session-ephemeral'];
  writeStore(home, { herDir, herIds: ids, archived: ids });
  makeSession(home, 'session-old', { ageDays: 10 });
  makeSession(home, 'session-fresh', { ageDays: 1 });
  makeSession(home, 'session-live', { ageDays: 30 });
  makeSession(home, 'session-unarchived', { ageDays: 30 });
  makeSession(home, 'session-ephemeral', { ageDays: 2 });
  // unarchived 那条不在归档集合里
  const store = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  store.global.archivedSessionIds = ids.filter((x) => x !== 'session-unarchived');
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(store), 'utf8');

  const plan = planRetention({
    dshHome: home,
    herWorkspaceDir: herDir,
    liveIds: new Set(['session-live']),
    kinds: { 'session-ephemeral': { kind: 'ownlife', at: Date.now() } },
    days: 7,
    ephemeralDays: 1,
    now: Date.now(),
  });
  const picked = plan.candidates.map((c) => c.sid).sort();
  assert.deepEqual(picked, ['session-ephemeral', 'session-old']);
  assert.equal(plan.stats.live, 1);
  assert.equal(plan.stats.fresh >= 1, true);
});

test('sweepRetention 删目录并统计字节', () => {
  const { home, herDir } = mkHome();
  writeStore(home, { herDir, herIds: ['session-a'], archived: ['session-a'] });
  const dir = makeSession(home, 'session-a', { ageDays: 9, bytes: 2048 });
  const plan = planRetention({ dshHome: home, herWorkspaceDir: herDir, liveIds: new Set(), days: 7 });
  assert.equal(plan.candidates.length, 1);
  const out = sweepRetention(plan.candidates);
  assert.equal(out.removed, 1);
  assert.equal(out.bytes, 2048);
  assert.equal(fs.existsSync(dir), false);
});

test('planStaleArchive 挑闲置的未归档会话，跳过 live 与新鲜会话', () => {
  const { home, herDir } = mkHome();
  const ids = ['session-stale', 'session-new', 'session-busy', 'session-archived'];
  writeStore(home, { herDir, herIds: ids, archived: ['session-archived'] });
  makeSession(home, 'session-stale', { ageDays: 3 });
  makeSession(home, 'session-new', { ageDays: 0 });
  makeSession(home, 'session-busy', { ageDays: 5 });
  makeSession(home, 'session-archived', { ageDays: 30 });
  const plan = planStaleArchive({
    dshHome: home,
    herWorkspaceDir: herDir,
    liveIds: new Set(['session-busy']),
    minIdleMs: 24 * 3600000,
  });
  assert.deepEqual(plan.ids.map((x) => x.sid), ['session-stale']);
});

test('planOrphanRetention 只挑未登记、不在 live、超过 30 天的孤儿目录', () => {
  const { home, herDir } = mkHome();
  writeStore(home, { herDir, herIds: ['session-owned'], archived: [] });
  const store = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  store.tables.workspaces.w2.sessionIds = ['session-other-owned'];
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(store), 'utf8');

  makeSession(home, 'session-owned', { ageDays: 40 });
  makeSession(home, 'session-other-owned', { ageDays: 40 });
  makeSession(home, 'session-orphan-old', { ageDays: 40, bytes: 2048 });
  makeSession(home, 'session-orphan-fresh', { ageDays: 2 });
  makeSession(home, 'session-orphan-live', { ageDays: 40 });

  const plan = planOrphanRetention({
    dshHome: home,
    herWorkspaceDir: herDir,
    liveIds: new Set(['session-orphan-live']),
    orphanDays: 30,
    now: Date.now(),
  });
  assert.deepEqual(plan.candidates.map((c) => c.sid), ['session-orphan-old']);
  assert.equal(plan.candidates[0].kind, 'orphan');
  assert.equal(plan.stats.orphan, 1);
  assert.equal(plan.stats.owned, 2);
  assert.equal(plan.stats.live, 1);
  assert.equal(plan.stats.fresh, 1);
});

test('planOrphanRetention 没有工作区/没有已登记目录时安全返回空', () => {
  const { home, herDir } = mkHome();
  writeStore(home, { herDir, herIds: [], archived: [] });
  const plan = planOrphanRetention({ dshHome: home, herWorkspaceDir: herDir });
  assert.deepEqual(plan.candidates, []);
});

test('没有工作区记录时安全返回空', () => {
  const { home, herDir } = mkHome();
  writeStore(home, { herDir: 'D:\\fake\\none', herIds: [], archived: [] });
  const plan = planRetention({ dshHome: home, herWorkspaceDir: herDir });
  assert.deepEqual(plan.candidates, []);
  const stale = planStaleArchive({ dshHome: home, herWorkspaceDir: herDir });
  assert.deepEqual(stale.ids, []);
});

test('indexSessionDirs / findHerWorkspace 基础行为', () => {
  const { home, herDir } = mkHome();
  writeStore(home, { herDir, herIds: ['session-x'], archived: [] });
  makeSession(home, 'session-x', { bytes: 7 });
  const index = indexSessionDirs(home);
  assert.equal(index.has('session-x'), true);
  assert.equal(index.get('session-x').bytes, 7);
  const store = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
  assert.equal(findHerWorkspace(store, herDir)?.title, '她');
  assert.equal(findHerWorkspace(store, 'D:\\nope'), null);
  assert.equal(EPHEMERAL_KINDS.has('ownlife'), true);
  assert.equal(EPHEMERAL_KINDS.has('chat'), false);
});
