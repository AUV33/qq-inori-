// [SESSION-RETAIN] DSH 会话目录保留策略。
//
// 背景：DSH 没有删除会话的 API，workspace/archiveSession 只是「隐藏」；桥接又按
// 聊天/隔离/任务不断新建会话（一个任务一个会话、临时会话用完即归档）。结果是
// ~/.dsh/sessions/<workspace>/session-* 只增不减：她那个工作区 4 天堆了 627 个目录、
// 147MB，其中 565 个是早已归档、再也不会被打开的废会话。
//
// 这个模块做三件事，且都按「保守闸门」筛选：
//   1. planRetention / sweepRetention —— 删掉「已归档 + 不在用 + 超过保留期」的会话目录。
//      临时 kind（ownlife / slang / vision / task …）默认 1 天，聊天类默认 7 天。
//   2. planStaleArchive —— 把「未归档但早就没人用」的会话找出来归档，清掉侧栏堆积。
//      只认她工作区名下的会话，且绝不动 live 集合里的 id。
//   3. planOrphanRetention —— 清掉「不在任何 workspace 登记、也不在 live、闲置 30 天」的
//      孤儿目录（DSH 换工作区/丢登记后的残留）；只扫她的会话目录，默认 30 天。
//
// 依赖注入：dshHome / herWorkspaceDir / liveIds / kinds / now 全部由调用方传入，
// 模块本身不读全局状态，方便单测。

import fs from 'node:fs';
import path from 'node:path';

/** 用完即弃的会话 kind：归档后保留期短（默认 1 天）。 */
export const EPHEMERAL_KINDS = new Set([
  'ownlife', 'slang', 'vision', 'intake', 'diary', 'reflect', 'gate', 'groupfact', 'task', 'probe',
]);

export const RETENTION_DEFAULTS = Object.freeze({
  days: 7,            // 聊天类已归档会话的保留期
  ephemeralDays: 1,   // 临时 kind 已归档会话的保留期
  archiveStaleHours: 24, // 未归档会话闲置多久算「废弃」
  orphanDays: 30,     // 不在 workspace 登记里的孤儿目录，闲置多久才清
  maxDeletePerRun: 500,
  maxOrphanDelete: 200,
  maxArchivePerRun: 200,
});

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normPath(p) {
  const n = path.normalize(String(p ?? ''));
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** 找到她的工作区记录（按路径匹配；标题会变，路径是稳定的）。 */
export function findHerWorkspace(store, herWorkspaceDir) {
  const want = normPath(herWorkspaceDir);
  for (const ws of Object.values(store?.tables?.workspaces ?? {})) {
    if (normPath(ws?.path) === want) return ws;
  }
  return null;
}

/** 扫 ~/.dsh/sessions/<workspace>/session-*，返回 sessionId -> {dir, bytes, mtime}。 */
export function indexSessionDirs(dshHome) {
  const index = new Map();
  const root = path.join(dshHome, 'sessions');
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return index;
  }
  for (const wsDir of workspaceDirs) {
    const full = path.join(root, wsDir.name);
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      const dir = path.join(full, e.name);
      let bytes = 0;
      let mtime = 0;
      try {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!f.isFile()) continue;
          const st = fs.statSync(path.join(dir, f.name));
          bytes += st.size;
          mtime = Math.max(mtime, st.mtimeMs);
        }
      } catch {
        continue;
      }
      // 同一个 id 理论上只在一个工作区目录下；重复时保留先扫到的。
      if (!index.has(e.name)) index.set(e.name, { dir, bytes, mtime });
    }
  }
  return index;
}

function cutoffFor(kinds, sid, now, days, ephemeralDays) {
  const kind = kinds?.[sid]?.kind;
  const keepDays = kind && EPHEMERAL_KINDS.has(String(kind)) ? ephemeralDays : days;
  return now - Math.max(0, Number(keepDays) || 0) * 86400000;
}

/**
 * 计算可以删的已归档会话。
 * @returns {{candidates: Array<{sid, dir, bytes, mtime, kind}>, stats: object}}
 */
export function planRetention({
  dshHome,
  herWorkspaceDir,
  liveIds = new Set(),
  kinds = {},
  now = Date.now(),
  days = RETENTION_DEFAULTS.days,
  ephemeralDays = RETENTION_DEFAULTS.ephemeralDays,
  maxDelete = RETENTION_DEFAULTS.maxDeletePerRun,
  store: providedStore = null,
} = {}) {
  const stats = { archived: 0, live: 0, missingDir: 0, fresh: 0, owned: 0 };
  const store = providedStore ?? readJson(path.join(dshHome, 'storages', 'workspace.json'), null);
  if (!store) return { candidates: [], stats };
  const ws = findHerWorkspace(store, herWorkspaceDir);
  if (!ws) return { candidates: [], stats };
  const archived = new Set((store.global?.archivedSessionIds ?? []).map(String));
  const index = indexSessionDirs(dshHome);
  const candidates = [];
  for (const raw of ws.sessionIds ?? []) {
    const sid = String(raw);
    stats.owned += 1;
    if (!archived.has(sid)) continue;
    stats.archived += 1;
    if (liveIds.has(sid)) { stats.live += 1; continue; }
    const entry = index.get(sid);
    if (!entry) { stats.missingDir += 1; continue; }
    if (!(entry.mtime > 0)) { stats.fresh += 1; continue; }
    if (entry.mtime >= cutoffFor(kinds, sid, now, days, ephemeralDays)) { stats.fresh += 1; continue; }
    candidates.push({ sid, dir: entry.dir, bytes: entry.bytes, mtime: entry.mtime, kind: kinds?.[sid]?.kind ?? null });
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  return { candidates: candidates.slice(0, Math.max(1, Number(maxDelete) || RETENTION_DEFAULTS.maxDeletePerRun)), stats };
}

/** 真正删除候选目录。返回删除统计；单个失败只记日志，不影响其余。 */
export function sweepRetention(candidates, { log = () => {} } = {}) {
  let removed = 0;
  let bytes = 0;
  const failed = [];
  for (const c of candidates) {
    try {
      fs.rmSync(c.dir, { recursive: true, force: true });
      removed += 1;
      bytes += c.bytes || 0;
    } catch (error) {
      failed.push({ sid: c.sid, error: error?.message ?? String(error) });
      log(`[session-retain] 删除失败 ${c.sid.slice(0, 14)}：${error?.message ?? error}`);
    }
  }
  return { removed, bytes, failed };
}

/**
 * 找出「未归档但已废弃」的会话 id：她工作区名下、不在 live 集合、目录闲置超过 minIdleMs。
 * 用于清掉 DSH 侧栏里堆积的旧会话（归档只是隐藏，可恢复）。
 */
export function planStaleArchive({
  dshHome,
  herWorkspaceDir,
  liveIds = new Set(),
  now = Date.now(),
  minIdleMs = RETENTION_DEFAULTS.archiveStaleHours * 3600000,
  maxArchive = RETENTION_DEFAULTS.maxArchivePerRun,
  store: providedStore = null,
} = {}) {
  const store = providedStore ?? readJson(path.join(dshHome, 'storages', 'workspace.json'), null);
  if (!store) return { ids: [], stats: {} };
  const ws = findHerWorkspace(store, herWorkspaceDir);
  if (!ws) return { ids: [], stats: {} };
  const archived = new Set((store.global?.archivedSessionIds ?? []).map(String));
  const index = indexSessionDirs(dshHome);
  const cutoff = now - Math.max(0, Number(minIdleMs) || 0);
  const ids = [];
  const stats = { unarchived: 0, live: 0, fresh: 0, missingDir: 0 };
  for (const raw of ws.sessionIds ?? []) {
    const sid = String(raw);
    if (archived.has(sid)) continue;
    stats.unarchived += 1;
    if (liveIds.has(sid)) { stats.live += 1; continue; }
    const entry = index.get(sid);
    if (!entry) { stats.missingDir += 1; continue; }
    if (!(entry.mtime > 0) || entry.mtime > cutoff) { stats.fresh += 1; continue; }
    ids.push({ sid, mtime: entry.mtime });
  }
  ids.sort((a, b) => a.mtime - b.mtime);
  return { ids: ids.slice(0, Math.max(1, Number(maxArchive) || RETENTION_DEFAULTS.maxArchivePerRun)), stats };
}

/**
 * 找出她工作区里「不在任何 workspace 登记、也不在 live」的孤儿会话目录。
 *
 * 为什么单独做：planRetention 只遍历 ws.sessionIds；DSH 换工作区/丢登记后，
 * 目录仍留在 sessions/<workspace>/ 下，永远不会进入任何计划（实测 47 个 / 33.9MB）。
 * 保守闸门：
 *   - 只扫「她的 workspace 登记会话所在的那个目录」，不跨工作区；
 *   - 任何 workspace 登记过的 id 都不动（避免误删别的角色）；
 *   - liveIds 不动；
 *   - 目录 mtime 必须早于 orphanDays（默认 30 天）；
 *   - 每次最多 maxDelete 个。
 */
export function planOrphanRetention({
  dshHome,
  herWorkspaceDir,
  liveIds = new Set(),
  now = Date.now(),
  orphanDays = RETENTION_DEFAULTS.orphanDays,
  maxDelete = RETENTION_DEFAULTS.maxOrphanDelete,
  store: providedStore = null,
} = {}) {
  const store = providedStore ?? readJson(path.join(dshHome, 'storages', 'workspace.json'), null);
  if (!store) return { candidates: [], stats: {} };
  const ws = findHerWorkspace(store, herWorkspaceDir);
  if (!ws) return { candidates: [], stats: {} };

  const index = indexSessionDirs(dshHome);
  const owned = new Set();
  for (const w of Object.values(store.tables?.workspaces ?? {})) {
    for (const sid of w?.sessionIds ?? []) owned.add(String(sid));
  }

  // 她的登记会话所在目录（通常是 sessions/<encoded-workspace>/）；从真实目录反推，
  // 不依赖 DSH 的 workspace 目录编码规则。
  const parents = new Set();
  for (const sid of ws.sessionIds ?? []) {
    const entry = index.get(String(sid));
    if (entry) parents.add(path.dirname(entry.dir));
  }
  if (!parents.size) return { candidates: [], stats: { parents: 0 } };

  const cutoff = now - Math.max(0, Number(orphanDays) || 0) * 86400000;
  const stats = { parents: parents.size, dirs: 0, owned: 0, live: 0, fresh: 0, missing: 0, orphan: 0 };
  const candidates = [];
  for (const parent of parents) {
    let entries;
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      stats.dirs += 1;
      const sid = e.name;
      if (owned.has(sid)) { stats.owned += 1; continue; }
      if (liveIds.has(sid)) { stats.live += 1; continue; }
      const entry = index.get(sid);
      if (!entry) { stats.missing += 1; continue; }
      if (!(entry.mtime > 0) || entry.mtime > cutoff) { stats.fresh += 1; continue; }
      stats.orphan += 1;
      candidates.push({ sid, dir: entry.dir, bytes: entry.bytes, mtime: entry.mtime, kind: 'orphan' });
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  return {
    candidates: candidates.slice(0, Math.max(1, Number(maxDelete) || RETENTION_DEFAULTS.maxOrphanDelete)),
    stats,
  };
}
