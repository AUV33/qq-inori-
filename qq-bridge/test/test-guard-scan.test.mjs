// [GUARD-MULTI-ROOT] 护栏扫哪些文件、备份叫什么名字 —— 用临时目录做真实回归。
//
// 为什么值得单独锁：扫漏了等于没有护栏；备份名撞了等于回滚成别人的文件。
// 这两件事以前只能靠「跑起来看看」，改坏了当场没人知道。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCodeFiles, backupNameFor, needsSmoke } from '../scripts/guard-scan.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-scan-'));
  const mk = (rel) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'export const x = 1;\n');
    return full;
  };
  const srcDir = path.join(root, 'qq-bridge', 'src');
  const packagesRoot = path.join(root, 'ai-companion-kit', 'packages');
  mk('qq-bridge/src/bridge.js');
  mk('qq-bridge/src/helper.mjs');
  mk('qq-bridge/src/notes.txt');
  mk('ai-companion-kit/packages/qzone-mcp/src/qzone-mcp.js');
  mk('ai-companion-kit/packages/qzone-mcp/src/lib/nested.js');
  mk('ai-companion-kit/packages/diary-mcp/src/index.js');
  mk('ai-companion-kit/packages/qzone-mcp/dist/bundle.js');
  mk('ai-companion-kit/packages/qzone-mcp/src/node_modules/dep.js');
  mk('ai-companion-kit/packages/qzone-mcp/src/test/only-test.js');
  return { root, srcDir, packagesRoot };
}

test('扫到桥接 src 和各包 src 下的 js/mjs（含嵌套），跳过 dist/node_modules/test/非代码', () => {
  const { srcDir, packagesRoot } = fixture();
  const files = collectCodeFiles({ srcDir, packagesRoot }).map((f) => path.basename(f)).sort();
  assert.deepEqual(files, ['bridge.js', 'helper.mjs', 'index.js', 'nested.js', 'qzone-mcp.js']);
});

test('包目录不存在时不炸（没有 ai-companion-kit 的机器）', () => {
  const { srcDir } = fixture();
  const files = collectCodeFiles({ srcDir, packagesRoot: 'Z:\\definitely\\missing' });
  assert.equal(files.length, 2);
});

test('备份名：bridge src 保持原名，其它用相对路径转义', () => {
  const { root, srcDir } = fixture();
  const bridge = path.join(srcDir, 'bridge.js');
  assert.equal(backupNameFor(bridge, { projectRoot: root, srcDir }), 'bridge.js.good.js');

  const pkgFile = path.join(root, 'ai-companion-kit', 'packages', 'diary-mcp', 'src', 'index.js');
  assert.equal(
    backupNameFor(pkgFile, { projectRoot: root, srcDir }),
    'ai-companion-kit__packages__diary-mcp__src__index.js.good.js',
  );
});

test('两个包的同名 index.js 不会撞到同一份备份', () => {
  const { root, srcDir } = fixture();
  const a = path.join(root, 'ai-companion-kit', 'packages', 'a', 'src', 'index.js');
  const b = path.join(root, 'ai-companion-kit', 'packages', 'b', 'src', 'index.js');
  const na = backupNameFor(a, { projectRoot: root, srcDir });
  const nb = backupNameFor(b, { projectRoot: root, srcDir });
  assert.notEqual(na, nb);
});

test('入口拆成 bridge.js + app.mjs 后，两边都要冒烟', () => {
  assert.equal(needsSmoke('/x/qq-bridge/src/bridge.js'), true);
  assert.equal(needsSmoke('/x/qq-bridge/src/app.mjs'), true);
  assert.equal(needsSmoke('/x/qq-bridge/src/outgoing-queue.mjs'), false);
  assert.equal(needsSmoke('/x/ai-companion-kit/packages/qzone-mcp/src/qzone-mcp.js'), false);
});
