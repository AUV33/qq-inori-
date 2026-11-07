#!/usr/bin/env node
// migrate-schemas.mjs · 数据层格式版本的手动入口（启动时 bridge 也会自动跑一次）
//
// 用法：
//   node scripts/migrate-schemas.mjs --dry-run   # 只报告要做什么，不落盘（可以在桥接运行时用）
//   node scripts/migrate-schemas.mjs             # 真跑（改文件前自动备份 .bak-schema-<时间戳>）
//   node scripts/migrate-schemas.mjs --json      # 机器读
//   node scripts/migrate-schemas.mjs --force     # 桥接在跑也强行迁移（有并发写风险，别默认用）
//
// 为什么默认拦住「桥接在跑」：迁移是读-改-写，桥接同时也在追加 lessons/hits。
// 最优时机是桥接启动时（持锁、无并发）；手动跑请先停桥接，或用 --dry-run 只看。
import net from 'node:net';
import { ensureSchemas, DATASETS } from '../src/domain/shared/schema-version.js';
import { stateDataPath } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const asJson = argv.includes('--json');
const force = argv.includes('--force');
const dir = stateDataPath();

function bridgeAlive(port = 3100, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { sock.destroy(); } catch { /* ignore */ } resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

if (!dryRun && !force && await bridgeAlive()) {
  console.error('桥接正在运行（3100 有响应）：迁移会和它的写入抢文件。');
  console.error('建议：先停桥接再迁移（或直接重启桥接，启动时会自己迁移）；只想看结果用 --dry-run。');
  process.exit(2);
}

const lines = [];
const report = ensureSchemas({ dir, dryRun, log: (line) => lines.push(line) });

if (asJson) {
  console.log(JSON.stringify({ dir, dryRun, datasets: Object.fromEntries(Object.entries(DATASETS).map(([k, v]) => [k, v.current])), ...report }, null, 2));
} else {
  console.log(`数据目录：${dir}${dryRun ? '（dry-run，不落盘）' : ''}`);
  console.log(`代码当前版本：${Object.entries(DATASETS).map(([k, v]) => `${k}=v${v.current}`).join('  ')}`);
  for (const line of lines) console.log(line);
  console.log(`升级：${report.changed.join(',') || '无'}｜首次登记：${report.normalized.join(',') || '无'}｜已是最新：${report.skipped.join(',') || '无'}`);
  for (const w of report.warnings) console.log(`⚠️  ${w}`);
}

process.exitCode = report.warnings.length ? 1 : 0;
