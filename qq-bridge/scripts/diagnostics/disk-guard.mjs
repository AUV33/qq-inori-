#!/usr/bin/env node
/**
 * disk-guard.mjs — 磁盘水位与 DSH 临时快照巡检。
 *
 * 背景：2026-10-31 C 盘从 100GB 掉到 23GB，根因是 DSH workspace-changes 插件
 * 每回合 `git add --all` 快照整个工作区；tools/sd-models 下 3.7GB 模型权重没被
 * .gitignore 忽略，每次压到 30 秒超时被 kill，半天在 %TEMP% 堆了 89GB。
 *
 * 本脚本只做「看」和「清过期快照」两件事：
 *   - 默认 dry-run，只报告 C 盘可用、TEMP 快照总量、最占地方的目录；
 *   - --apply 才删除「超过 --older-than 小时没动」的快照目录（默认 12 小时，
 *     与 DSH 插件自己的 sweep 口径一致，活跃会话不受影响）；
 *   - 与 src/inori-disk-guard.js 共用同一套判定，避免两处阈值漂移。
 *
 * 用法：
 *   node scripts/diagnostics/disk-guard.mjs                      # 巡检，dry-run
 *   node scripts/diagnostics/disk-guard.mjs --json               # 机器可读
 *   node scripts/diagnostics/disk-guard.mjs --list               # 逐条列出快照目录
 *   node scripts/diagnostics/disk-guard.mjs --apply              # 真删过期目录
 *   node scripts/diagnostics/disk-guard.mjs --apply --older-than 6
 *   node scripts/diagnostics/disk-guard.mjs --check              # critical 时退出码 2（给看护用）
 *
 * 保护：只认 temp 根下 `dsh-workspace-changes-` 前缀的目录；路径不匹配一律跳过。
 */
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_TEMP_PREFIX,
  DEFAULT_THRESHOLDS,
  evaluateDiskState,
  listSnapshotDirs,
  readDiskSpace,
  removeSnapshotDirs,
  selectStaleDirs,
  summarizeSnapshots,
} from '../../src/domain/leaves/inori-disk-guard.js';

function parseArgs(argv) {
  const out = {
    json: false,
    list: false,
    apply: false,
    check: false,
    olderThanHours: DEFAULT_THRESHOLDS.maxAgeHours,
    minFreeGB: DEFAULT_THRESHOLDS.minFreeGB,
    maxSnapshotGB: DEFAULT_THRESHOLDS.maxSnapshotGB,
    tempRoot: os.tmpdir(),
    prefix: DEFAULT_TEMP_PREFIX,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--list') out.list = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--check') out.check = true;
    else if (a === '--older-than') out.olderThanHours = Number(argv[++i]);
    else if (a === '--min-free-gb') out.minFreeGB = Number(argv[++i]);
    else if (a === '--max-snapshot-gb') out.maxSnapshotGB = Number(argv[++i]);
    else if (a === '--temp') out.tempRoot = path.resolve(argv[++i]);
  }
  return out;
}

function formatGB(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(2)} GB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = listSnapshotDirs({ tempRoot: args.tempRoot, prefix: args.prefix });
  const snapshots = summarizeSnapshots(dirs);
  const space = readDiskSpace(args.tempRoot);
  const state = evaluateDiskState({
    freeBytes: space?.free ?? null,
    totalBytes: space?.total ?? null,
    snapshotBytes: snapshots.bytes,
    minFreeGB: args.minFreeGB,
    maxSnapshotGB: args.maxSnapshotGB,
  });
  const stale = selectStaleDirs(dirs, {
    maxAgeMs: args.olderThanHours * 3600 * 1000,
    now: Date.now(),
  });

  let result = null;
  if (args.apply) {
    result = removeSnapshotDirs(stale, { tempRoot: args.tempRoot, prefix: args.prefix });
  }

  if (args.json) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      tempRoot: args.tempRoot,
      freeGB: state.freeGB,
      totalGB: state.totalGB,
      snapshotGB: state.snapshotGB,
      snapshotCount: snapshots.count,
      level: state.level,
      reasons: state.reasons,
      stale: stale.map((d) => ({ name: d.name, bytes: d.bytes, mtime: new Date(d.mtimeMs).toISOString() })),
      applied: result === null ? null : {
        removed: result.removed.length,
        freedBytes: result.freedBytes,
        failed: result.failed,
      },
    }, null, 2));
  } else {
    console.log(`临时根: ${args.tempRoot}`);
    console.log(`C 盘可用: ${state.freeGB === null ? '未知' : `${state.freeGB.toFixed(1)} GB`} / 总计 ${state.totalGB === null ? '未知' : `${state.totalGB.toFixed(1)} GB`}`);
    console.log(`TEMP 快照: ${formatGB(snapshots.bytes)}（${snapshots.count} 个目录）`);
    console.log(`判定: ${state.level}${state.reasons.length ? ` — ${state.reasons.join('；')}` : ''}`);
    console.log(`超过 ${args.olderThanHours} 小时没动: ${stale.length} 个，${formatGB(stale.reduce((s, d) => s + d.bytes, 0))}`);

    if (args.list) {
      const rows = [...dirs].sort((a, b) => b.bytes - a.bytes).slice(0, 30);
      console.log('\n目录（按大小）:');
      for (const d of rows) {
        const mark = stale.includes(d) ? '过期' : '活跃';
        console.log(`  ${formatGB(d.bytes).padStart(10)}  ${mark}  ${new Date(d.mtimeMs).toLocaleString('zh-CN')}  ${d.name}`);
      }
    }

    if (result) {
      console.log(`\n已删除 ${result.removed.length} 个过期目录，释放 ${formatGB(result.freedBytes)}${result.failed.length ? `，失败 ${result.failed.length} 个` : ''}`);
      for (const f of result.failed) console.log(`  失败 ${f.name}: ${f.error}`);
    } else if (stale.length) {
      console.log('\n（dry-run，未删除任何东西；确认后加 --apply）');
    }
  }

  if (args.check && state.level === 'critical') process.exitCode = 2;
}

main();
