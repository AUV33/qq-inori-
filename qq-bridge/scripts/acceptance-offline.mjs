#!/usr/bin/env node
// acceptance-offline.mjs · 离线验收聚合（服务全停时也能重复跑）
//
// 跑 living-eval / 文风基线 / 社交图迁移 dry-run / 运行时 PII / 灾难快照 / people 加密状态。
// 只读优先；快照写临时目录，不碰真实数据。退出码：关键项失败=1，警告=0。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

function run(script, args = []) {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env,
  });
  let body = null;
  try { body = JSON.parse(out.stdout.trim()); } catch { /* 非 JSON */ }
  return { status: out.status, body, stderr: out.stderr };
}

const checks = [];
function add(name, ok, detail, critical = false) { checks.push({ name, ok: !!ok, detail, critical: !!critical }); }

const ev = run('living-eval.mjs');
add('living-eval', ev.status === 0 && ev.body && ev.body.passed === ev.body.total, ev.body ? String(ev.body.passed) + '/' + String(ev.body.total) : (ev.stderr || 'no-output'), true);

const st = run('style-baseline.mjs', ['--compare']);
add('style-drift', st.status === 0, st.status === 0 ? (st.body && st.body.drift && st.body.drift.drift ? 'drift=true' : 'drift=false') : ((st.body && st.body.reason) || st.stderr || 'no-baseline'));

const gr = run('social-graph-migrate.mjs');
add('social-graph', gr.status === 0, gr.status === 0 ? ('migrated=' + String(gr.body && gr.body.migrated) + ', already=' + String(gr.body && gr.body.already) + ', skipped=' + String(gr.body && gr.body.skipped)) : (gr.stderr || 'failed'));

const pii = run('privacy-scan.mjs', ['--runtime']);
const pb = pii.body || {};
add('runtime-pii', pii.status === 0, 'files=' + String(pb.files) + ', total=' + String(pb.total) + ', findings=' + String((pb.findings || []).length));

let snapOk = false;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-snapshot-'));
  const take = run('state-snapshot.mjs', ['take', '--out=' + dir]);
  const verify = run('state-snapshot.mjs', ['verify', '--dir=' + dir]);
  snapOk = take.status === 0 && verify.status === 0 && verify.body && verify.body.ok === true;
  add('snapshot', snapOk, snapOk ? ('checked=' + String(verify.body.checked)) : (take.stderr || verify.stderr || 'failed'), true);
  fs.rmSync(dir, { recursive: true, force: true });
} catch (error) {
  add('snapshot', false, String(error && error.message ? error.message : error), true);
}

const pe = run('people-encrypt.mjs', ['status']);
add('people-encryption', pe.status === 0, pe.status === 0 ? ('encrypted=' + String(pe.body && pe.body.encrypted) + ', key=' + String(pe.body && pe.body.keyAvailable)) : (pe.stderr || 'no-people'));

const pd = run('people-encrypt.mjs', ['doctor']);
const pdWarnings = (pd.body && pd.body.warnings) || [];
add('people-doctor', pd.status === 0 && pdWarnings.length === 0, pd.status === 0 ? ('people=' + String(pd.body && pd.body.people) + ', warnings=' + JSON.stringify(pdWarnings)) : (pd.stderr || 'doctor-failed'));

const criticalFails = checks.filter(function (c) { return c.critical && !c.ok; }).length;
const warnings = checks.filter(function (c) { return !c.ok && !c.critical; }).length;
const report = { v: 1, at: new Date().toISOString(), ok: criticalFails === 0, criticalFails: criticalFails, warnings: warnings, checks: checks };

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write('[acceptance-offline] ' + (report.ok ? '关键项通过' : '关键项失败') + '（warnings ' + String(warnings) + '）\n');
  for (const c of checks) {
    process.stdout.write('  ' + (c.ok ? '✅' : (c.critical ? '❌' : '⚠️')) + ' ' + c.name + ': ' + c.detail + '\n');
  }
}
// --strict：警告也当失败（用于发布前验收；日常默认只关键项失败才 1）。
process.exitCode = report.ok && (!strict || warnings === 0) ? 0 : 1;