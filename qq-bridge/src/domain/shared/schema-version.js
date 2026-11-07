// schema-version.js · 数据层的格式版本与幂等迁移
//
// 为什么用「旁路清单」而不是给每条记录加 version：
//   1. 数据层是 jsonl，逐条加字段会改动所有写端、膨胀文件，收益只是“每行自带版本”；
//   2. 真正要回答的问题是「这份文件是哪一版格式」，那是文件级信息，清单就能回答；
//   3. 迁移只在启动时跑一次，可 dry-run、可回滚（先备份再原子替换）。
// 代价：把单个 jsonl 拷到别处会丢掉版本声明——可以接受，因为它本来就不是独立可用的数据。
//
// 规则：
//   · 清单版本 < 代码当前版本 → 依次跑迁移步骤，再写回；
//   · 清单里没有（首次/损坏）→ 记成当前版本，并跑一次幂等 normalize（只补默认值，不删不改旧值）；
//   · 清单版本 > 代码当前版本 → 数据比代码新，拒绝改动，只告警；
//   · 每个会改文件的迁移都先备份成 `<file>.bak-schema-<时间戳>`，再写临时文件原子替换。
import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from './project-paths.js';
import { renameWithRetry } from '../../bootstrap/fs-utils.mjs';

export const manifestPath = (dir) => path.join(dir ?? path.dirname(stateDataPath('x')), 'schema.json');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return { ok: true, value: JSON.parse(line) }; } catch { return { ok: false, raw: line }; }
    });
  } catch { return []; }
};

// 每个文件最多留几份 .bak-schema（按文件名里的时间戳，越新越留）。
// 为什么要有：2026-10-28 实测桥接在自进化循环里每几分钟重启一次，
// 每次启动都会重写 schema.json 并留一份备份 → 一天几百份、56% 的 state 目录是垃圾。
const BACKUP_KEEP = 5;

/** 只保留最近 BACKUP_KEEP 份 `<file>.bak-schema-*`（时间戳是 ISO，字典序即时间序）。 */
function pruneBackups(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-schema-`;
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort(); } catch { return; }
  const drop = names.slice(0, Math.max(0, names.length - BACKUP_KEEP));
  for (const n of drop) {
    try { fs.rmSync(path.join(dir, n), { force: true }); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'schema-version.js:45'); }
  }
}

/**
 * 备份 + 原子写；内容没变时**不写也不备份**（返回 false）。
 * 内容一致时重写文件只会让 mtime 变、再留一份无意义的 .bak——幂等迁移应该真的幂等。
 */
function backupAndWrite(file, text) {
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`[schema] 读取失败（按新建处理）: ${file}｜${error?.message ?? error}`);
  }
  if (existing === text) return false;
  if (existing !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(file, `${file}.bak-schema-${stamp}`); } catch (error) {
      console.error(`[schema] 迁移备份失败（继续迁移）: ${file}｜${error?.message ?? error}`);
    }
    pruneBackups(file);
  }
  const tmp = `${file}.tmp-schema-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  renameWithRetry(tmp, file);
  return true;
}

const writeJsonl = (file, values) => backupAndWrite(file, values.map((v) => JSON.stringify(v)).join('\n') + '\n');
const writeJson = (file, value) => backupAndWrite(file, JSON.stringify(value, null, 2) + '\n');

/** 迁移步骤：migrate[v] 是「把一条 v 版记录变成 v+1 版」的纯函数 */
export const DATASETS = {
  memory: { current: 1 },
  lessons: {
    current: 2,
    file: (dir) => path.join(dir, 'lessons.jsonl'),
    migrate: {
      1: (row) => ({
        ...row,
        confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.7,
        up: Number.isFinite(Number(row.up)) ? Number(row.up) : 0,
        down: Number.isFinite(Number(row.down)) ? Number(row.down) : 0,
      }),
    },
  },
  skills: {
    current: 2,
    file: (dir) => path.join(dir, 'skills.json'),
    mapItems: true,
    migrate: {
      1: (row) => ({
        ...row,
        attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0,
        success: Number.isFinite(Number(row.success)) ? Number(row.success) : 0,
        fail: Number.isFinite(Number(row.fail)) ? Number(row.fail) : 0,
      }),
    },
  },
  cognition: {
    current: 2,
    file: (dir) => path.join(dir, 'cognition.jsonl'),
    migrate: {
      1: (row) => ({
        ...row,
        kind: String(row.kind || 'general'),
        when: String(row.when ?? ''),
        unless: String(row.unless ?? ''),
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
      }),
    },
  },
};

function loadRows(spec, dir) {
  const file = spec.file(dir);
  if (spec.mapItems) {
    const data = readJson(file, null);
    return { data, rows: Array.isArray(data?.items) ? data.items : [] };
  }
  return { data: null, rows: readJsonl(file).filter((r) => r.ok).map((r) => r.value) };
}

function saveRows(spec, dir, data, rows, version) {
  const file = spec.file(dir);
  if (spec.mapItems) writeJson(file, { ...(data ?? {}), schemaVersion: version, items: rows });
  else writeJsonl(file, rows);
}

/**
 * 跑一次幂等迁移。
 * @param {{dir?: string, dryRun?: boolean, log?: (line: string) => void}} options
 */
export function ensureSchemas(options = {}) {
  const { dir = path.dirname(stateDataPath('x')), dryRun = false, log = () => {} } = options;
  const file = manifestPath(dir);
  const raw = readJson(file, null);
  const manifest = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const report = { changed: [], normalized: [], skipped: [], warnings: [], manifest };

  for (const [name, spec] of Object.entries(DATASETS)) {
    const current = Number(spec.current) || 1;
    const recorded = manifest[name]?.version;
    const from = Number(recorded ?? 0);
    if (Number.isFinite(from) && from > current) {
      report.warnings.push(`${name}: 数据版本 ${from} 比代码版本 ${current} 新，拒绝改动`);
      report.skipped.push(name);
      continue;
    }
    const isFresh = !Number.isFinite(from) || from <= 0;
    const needsUpgrade = !isFresh && from < current;
    if (!isFresh && !needsUpgrade) { report.skipped.push(name); continue; }

    log(`[schema] ${name}: ${isFresh ? `首次登记 v${current}（幂等 normalize）` : `v${from} → v${current}`}`);
    if (!spec.file) { // memory 只登记版本（分多文件，不在启动时重写）
      report.normalized.push(name);
      manifest[name] = { version: current, updatedAt: new Date().toISOString() };
      continue;
    }

    const { data, rows } = loadRows(spec, dir);
    if (!rows.length) {
      report.skipped.push(name);
      manifest[name] = { version: current, updatedAt: new Date().toISOString() };
      continue;
    }

    let out = rows;
    if (isFresh) {
      // 首次登记：只补默认值（幂等），不删不改旧值
      const step = spec.migrate?.[current - 1];
      out = step ? rows.map((row) => step(row)) : rows;
      if (!dryRun) saveRows(spec, dir, data, out, current);
      if (!dryRun) report.normalized.push(name);
    } else {
      for (let v = from; v < current; v += 1) {
        const step = spec.migrate?.[v];
        if (!step) { report.warnings.push(`${name}: 缺少 v${v}→v${v + 1} 迁移步骤`); break; }
        out = out.map(step);
      }
      if (!dryRun) saveRows(spec, dir, data, out, current);
      if (!dryRun) report.changed.push(name);
    }
    manifest[name] = { version: current, updatedAt: new Date().toISOString() };
  }

  if (!dryRun) writeJson(file, manifest);
  report.manifest = manifest;
  return report;
}
