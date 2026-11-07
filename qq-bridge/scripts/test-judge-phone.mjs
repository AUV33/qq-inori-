// test-judge-phone.mjs · 技能判据机检：judge-phone 行为 + 8 条技能都可机检
import assert from 'node:assert';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };
const JUDGE = `${PROJECT_ROOT}/qq-bridge/scripts/judge-phone.mjs`;
const runJudge = (spec) => {
  try {
    const out = execFileSync(process.execPath, [JUDGE, spec], { encoding: 'utf8', timeout: 120000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') };
  }
};

check('file: 存在 → 0，证据可读', () => {
  const r = runJudge(`file:${JUDGE}`);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out.trim().split(/\r?\n/).pop());
  assert.equal(j.ok, true);
  assert.match(j.evidence, /文件存在/);
});

check('file: 不存在 → 1', () => {
  const r = runJudge('file:D:/nope/definitely-not-here.txt');
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out.trim().split(/\r?\n/).pop());
  assert.equal(j.ok, false);
});

check('格式不对 → 2（没条件检查，不是"没做成"）', () => {
  const r = runJudge('随便写点什么');
  assert.equal(r.code, 2);
});

check('>=8 条技能：机器判据可机检，人工判据保留 verifyHuman', () => {
  const j = JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/data/state/skills.json`, 'utf8'));
  assert.ok(j.items.length >= 8);
  // 判据里写的是本机绝对路径；按当前仓库根比对，斜杠统一成 / 再匹配。
  const root = PROJECT_ROOT.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const machine = new RegExp(`^命令:\\s*node\\s*${root}/qq-bridge/scripts/judge-phone\\.mjs\\s+(pkg|text|textAny|nottext|file):`);
  for (const s of j.items) {
    assert.ok(machine.test(String(s.verify).replace(/\\/g, '/')) || String(s.verifyHuman || '').trim(),
      `${s.name} 既没有机器判据也没有人工判据：${s.verify}`);
    assert.ok(s.verifyHuman, `${s.name} 缺 verifyHuman（原人工判据丢了）`);
  }
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
