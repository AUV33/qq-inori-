// test-privacy-scan.test.mjs · 发布隐私闸门的回归测试
//
// 背景：扫描根曾只指向 qq-bridge/，ai-companion-kit 里的一个 API key 字面量躺了两个提交
// 而扫描一直报绿；allowPaths 的宽泛前缀还会让新增文件整份免检。这里在临时目录里造一棵
// 迷你仓库，验证「全仓覆盖」与「凭据规则不可被整文件放行豁免」两件事不会回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(HERE, '..', 'scripts', 'privacy-scan.mjs');
// 拼接构造：本测试文件自身不能带一个会被本仓库闸门命中的完整凭据字面量。
const FAKE_KEY = 'sk' + '-' + 'a'.repeat(32);
const LEAK_LINE = `const KEY = '${FAKE_KEY}';\n`;
const SAFE_LINE = 'const KEY = process.env.PHONE_VISION_KEY;\n';
const KEY_RULE = 'API key 字面量（sk-）';

function withTempTree(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inori-privacy-'));
  try {
    const kit = path.join(root, 'ai-companion-kit', 'tests', 'legacy');
    const scripts = path.join(root, 'qq-bridge', 'scripts');
    fs.mkdirSync(kit, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(kit, '_leak.mjs'), LEAK_LINE, 'utf8');
    // 文件名落在 scripts/probe- 这个历史 allowPaths 前缀下：NEVER_ALLOW 必须让它照样被扫。
    fs.writeFileSync(path.join(scripts, 'probe-new.mjs'), LEAK_LINE, 'utf8');
    fs.writeFileSync(path.join(root, 'qq-bridge', 'clean.mjs'), 'export const ok = 1;\n', 'utf8');
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function scan(root) {
  const r = spawnSync(process.execPath, [SCANNER, `--root=${root}`, '--no-git', '--json'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const stdout = r.stdout ?? '';
  const start = stdout.indexOf('{');
  assert.ok(start >= 0, `扫描器没有输出 JSON：${stdout}\n${r.stderr ?? ''}`);
  return { status: r.status, result: JSON.parse(stdout.slice(start)) };
}

test('全仓扫描：kit 与整文件放行前缀里的 API key 都必须被拦下', () => {
  withTempTree((root) => {
    const { status, result } = scan(root);
    assert.equal(status, 1, '发现凭据字面量时闸门必须失败');
    const files = result.findings.filter((f) => f.rule === KEY_RULE).map((f) => f.file);
    assert.ok(
      files.some((f) => f.endsWith('ai-companion-kit/tests/legacy/_leak.mjs')),
      `kit 侧泄漏未发现：${files.join(', ')}`,
    );
    assert.ok(
      files.some((f) => f.endsWith('qq-bridge/scripts/probe-new.mjs')),
      `allowPaths 前缀里的新增文件被漏掉：${files.join(', ')}`,
    );
    assert.ok(!files.some((f) => f.endsWith('qq-bridge/clean.mjs')), '干净文件被误报');
  });
});

test('凭据改为环境变量注入后，不再命中 API key 规则', () => {
  withTempTree((root) => {
    fs.writeFileSync(path.join(root, 'ai-companion-kit', 'tests', 'legacy', '_leak.mjs'), SAFE_LINE, 'utf8');
    fs.writeFileSync(path.join(root, 'qq-bridge', 'scripts', 'probe-new.mjs'), SAFE_LINE, 'utf8');
    const { result } = scan(root);
    // 不硬性要求整体退出码：维护者本机的 privacy-rules.json 可能另有自定义规则命中。
    const keyFindings = result.findings.filter((f) => f.rule === KEY_RULE);
    assert.equal(keyFindings.length, 0, `环境变量注入仍被当成字面量：${JSON.stringify(keyFindings)}`);
  });
});
