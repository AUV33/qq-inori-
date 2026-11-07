// [ARCH-GUARD] 目标架构的依赖方向闸门：domain/** 不得反向依赖入口/运行时/适配器。
// 对应 docs/internal/_archive/架构/架构-目标架构-20261103.md 第 3 节的依赖规则（可机检的那部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from '../scripts/audit-architecture.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('domain 层不依赖入口、运行时与适配器', () => {
  const bad = checkArchitecture(SRC);
  assert.deepEqual(
    bad.map((v) => `${v.rule} ${v.file} → ${v.spec}`),
    [],
    'domain/** 出现了反向依赖（应通过 ports 而不是直接 import 入口/适配器）',
  );
});
test('合成违规：domain 反向依赖入口/适配器、shared 依赖业务域都会被拦', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-guard-'));
  const mk = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, 'utf8'); };
  mk('domain/conversation/a.mjs', "import { x } from '../../adapters/dsh-client.js';");
  mk('domain/shared/b.mjs', "import { y } from '../leaves/inori-state.js';");
  mk('domain/leaves/c.mjs', "import { z } from './d.mjs';");
  const bad = checkArchitecture(root);
  const rules = bad.map((v) => v.rule).sort();
  assert.ok(rules.includes('R1'), '应拦 domain → adapters，实际 ' + JSON.stringify(bad));
  assert.ok(rules.includes('R4'), '应拦 shared → leaves，实际 ' + JSON.stringify(bad));
  assert.equal(bad.filter((v) => v.file === 'domain/leaves/c.mjs').length, 0, '正常相对导入不应误报');
});

