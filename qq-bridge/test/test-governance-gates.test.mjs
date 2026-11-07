// 工程治理门禁的回归锁：避免"改完又漂移回去"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('npm test 链：含 wiring 门禁，且不再重复跑 test:inori', () => {
  const t = pkg.scripts.test;
  assert.match(t, /audit:wiring/, '接线审计必须进本地主链');
  assert.match(t, /test:core/);
  assert.ok(!t.includes('test:inori'), 'test:core 的 glob 已覆盖那 17 个文件，重复跑只会拖慢并掩盖顺序依赖');
  assert.match(t, /audit:arch/);
  assert.match(t, /matrix:check/);
  assert.match(t, /docs:check/);
});

test('致命策略单一：app.mjs 不再注册 unhandledRejection/uncaughtException', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/app.mjs'), 'utf8');
  assert.ok(!/process\.on\(['"]unhandledRejection['"]/.test(app), '重复监听会让状态保存被抢先 exit 跳过');
  assert.ok(!/process\.on\(['"]uncaughtException['"]/.test(app));
  assert.match(app, /__setCrashBeforeFatal/, '改为注入退出前钩子');
  const forensics = fs.readFileSync(path.join(ROOT, 'src/crash-forensics.js'), 'utf8');
  assert.match(forensics, /__setCrashBeforeFatal/);
  assert.match(forensics, /beforeFatal\(kind, err\)/, '退出前必须先调用宿主的 saveState/releaseLock');
});

test('审计快照有产出口径，且 CI 有 Windows runtime smoke', () => {
  const privacy = fs.readFileSync(path.join(ROOT, 'scripts/privacy-scan.mjs'), 'utf8');
  assert.match(privacy, /--out/);
  assert.match(privacy, /security-audit\.json/);
  assert.ok(pkg.scripts['audit:security'], '提供显式产出审计快照的脚本');
  const ci = fs.readFileSync(path.resolve(ROOT, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /runner\.os == 'Windows'/, '真实运行形态是 Windows 进程群，必须有 Windows 侧验证');
});

test('docs:check 只校验「当前基线」，不误伤历史快照', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'scripts/check-docs.mjs'), 'utf8');
  assert.match(doc, /当前基线\|当前模块\|现状\|实测口径/);
  assert.ok(!/Math\.abs\(claimed - actualModules\) > 3\) \{\s*errors\.push/.test(doc) || doc.includes('isCurrent'));
});
