// audit-architecture.mjs · 目标架构（六边形）的依赖方向检查。
//
// 规则（只查"方向"，不查风格）：
//   R1 domain/**（领域/叶子）不得 import 入口与运行时：app.mjs / bridge.js / console-server.mjs / onebot/**
//   R2 domain/** 不得 import adapters/**（本仓尚未建目录，先占位）
//   R3 任何 src 文件不得用绝对路径 import（必须是相对）
//
// 说明：叶子目前仍允许 import '../project-paths.js' 与 ai-companion-kit（共享纯工具）；
// 这是已知的过渡形态，等 ports 起来后再收紧（见 docs/internal/_archive/架构/架构-目标架构-20261103.md）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_FOR_DOMAIN = [/app\.mjs$/, /bridge\.js$/, /console-server\.mjs$/, /(^|\/)onebot\//, /(^|\/)adapters\//];
const ABS_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

export function checkArchitecture(srcDir) {
  const violations = [];
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
    }
  })(srcDir);

  for (const file of files) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (ABS_PATH.test(spec)) {
        violations.push({ file: rel, rule: 'R3', spec });
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec.split('?')[0]);
      const tRel = path.relative(srcDir, target).split(path.sep).join('/');
      // R4：共享内核不依赖任何业务域（单向依赖：业务域 → shared）
      if (rel.startsWith('domain/shared/') && tRel.startsWith('domain/') && !tRel.startsWith('domain/shared/')) {
        violations.push({ file: rel, rule: 'R4', spec, target: tRel });
      }
      if (rel.startsWith('domain/')) {
        for (const re of FORBIDDEN_FOR_DOMAIN) {
          if (re.test(tRel)) violations.push({ file: rel, rule: 'R1', spec, target: tRel });
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const bad = checkArchitecture(src);
  if (bad.length) {
    console.error(`架构检查失败：${bad.length} 处依赖方向违规`);
    for (const v of bad.slice(0, 20)) console.error(`  [${v.rule}] ${v.file} → ${v.spec}`);
    process.exit(1);
  }
  console.log('✅ 架构检查通过（domain 不依赖入口/运行时/适配器）');
}
