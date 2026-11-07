#!/usr/bin/env node
// state-snapshot.mjs · 宪章 G4：灾难快照 take/verify/restore（离线、只读优先）
//
// 用法：
//   node scripts/state-snapshot.mjs take [--out=<目录>] [--json]
//   node scripts/state-snapshot.mjs verify --dir=<快照目录> [--json]
//   node scripts/state-snapshot.mjs restore --dir=<快照目录> [--apply] [--json]
//
// 默认 root = data/state；take 默认输出 data/snapshots/<时间戳>。
// restore 默认 dry-run，--apply 才覆盖；覆盖前留 .bak-<时间戳>。
import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath, projectPath } from '../src/domain/shared/project-paths.js';
import { DEFAULT_STATE_FILES, createSnapshot, verifySnapshot, restoreSnapshot } from '../src/domain/shared/state-snapshot.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (prefix, fallback = '') => {
  const row = args.find((a) => a.startsWith(prefix));
  return row ? row.slice(prefix.length) : fallback;
};
const json = has('--json');
const action = args.find((a) => !a.startsWith('-')) || 'take';
const root = path.resolve(valueOf('--root=', stateDataPath()));
const files = valueOf('--files=') ? valueOf('--files=').split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_STATE_FILES;

function print(body) {
  if (json) { process.stdout.write(JSON.stringify(body, null, 2) + '\n'); return; }
  if (action === 'take') {
    process.stdout.write(`[snapshot] 已建 ${body.dest}：${body.files.length} 个文件${body.missing.length ? `（缺 ${body.missing.length}）` : ''}\n`);
  } else if (action === 'verify') {
    process.stdout.write(`[snapshot] ${body.ok ? '校验通过' : '校验失败'}：checked=${body.checked}${body.mismatched.length ? ` mismatched=${body.mismatched.join(',')}` : ''}${body.missing.length ? ` missing=${body.missing.join(',')}` : ''}\n`);
  } else {
    process.stdout.write(`[snapshot] 恢复${body.ok ? '成功' : '被拒绝'}${body.dryRun ? '（dry-run，加 --apply 才写）' : ''}：${body.restored.length} 个${body.skipped.length ? `，跳过 ${body.skipped.join(',')}` : ''}\n`);
  }
}

try {
  if (action === 'take') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.resolve(valueOf('--out=', projectPath('data', 'snapshots', stamp)));
    const body = createSnapshot({ root, dest, files });
    print(body);
  } else if (action === 'verify') {
    const dir = path.resolve(valueOf('--dir='));
    if (!dir) { console.error('verify 需要 --dir=<快照目录>'); process.exit(2); }
    const body = verifySnapshot({ dir });
    print(body);
    process.exitCode = body.ok ? 0 : 1;
  } else if (action === 'restore') {
    const dir = path.resolve(valueOf('--dir='));
    if (!dir) { console.error('restore 需要 --dir=<快照目录>'); process.exit(2); }
    const body = restoreSnapshot({ dir, root, dryRun: !has('--apply') });
    print(body);
    process.exitCode = body.ok ? 0 : 1;
  } else {
    console.error(`未知动作：${action}（take/verify/restore）`);
    process.exit(2);
  }
} catch (error) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2) + '\n');
  else console.error(`[snapshot] 失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
