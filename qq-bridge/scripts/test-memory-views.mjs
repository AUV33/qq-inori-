// 记忆视图统一 + 技能判据机检 测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unifyEntries, normalizeText } from '../src/domain/leaves/inori-memory-views.js';
import { parseVerifySpec, checkVerify } from '../src/domain/leaves/inori-skill-verify.js';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

let passed = 0;
const tests = [];
function ok(name, fn) { tests.push({ name, fn }); }

const DAY = 86400000;
const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

ok('同文不同视图只留一条（保留重要度高的 fact）', () => {
  const now = Date.now();
  const entries = [
    { kind: 'group-digest', text: '他今天说想换工作', time: fmt(now - DAY) },
    { kind: 'fact', text: '他今天说想换工作', time: fmt(now - DAY), importance: 4 },
    { kind: 'browse', text: '今天网上看过：招聘网站', time: fmt(now - DAY) },
  ];
  const r = unifyEntries(entries);
  assert.equal(r.entries.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.ok(r.entries.some((e) => e.kind === 'fact'));
});

ok('完全同文只留一条（保留较新的时间）', () => {
  const now = Date.now();
  const entries = [
    { kind: 'fact', text: '他喜欢猫', time: fmt(now - 30 * DAY) },
    { kind: 'fact', text: '他喜欢猫', time: fmt(now) },
  ];
  const r = unifyEntries(entries);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].time, fmt(now));
});

ok('normalizeText 去标点/空白/大小写', () => {
  assert.equal(normalizeText('Hello, World!'), 'helloworld');
  assert.equal(normalizeText('他 说：好的。'), '他说好的');
});

ok('verify 判据解析', () => {
  assert.equal(parseVerifySpec('文件:package.json').type, 'file');
  assert.equal(parseVerifySpec('网址:https://example.com').type, 'url');
  assert.equal(parseVerifySpec('命令:dir').type, 'cmd');
  assert.equal(parseVerifySpec('能看到结果').type, 'text');
  assert.equal(parseVerifySpec('').type, 'text');
});

ok('verify 机检：文件存在/不存在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
  const f = path.join(dir, 'ok.txt');
  fs.writeFileSync(f, 'x');
  assert.equal((await checkVerify('文件:' + f)).ok, true);
  assert.equal((await checkVerify('文件:' + path.join(dir, 'nope.txt'))).ok, false);
});

ok('verify 机检：cmd 判据默认不执行，只记录（显式 skill_verify 才跑）', async () => {
  const r = await checkVerify('命令:echo hi');
  assert.equal(r.ok, null);
  assert.ok(/skill_verify|人工确认/.test(r.evidence));
  // [KNOWING-DOING] 显式允许时才执行命令判据：exit 0 → ok=true
  const run = await checkVerify('命令:exit 0', { allowCommand: true });
  assert.equal(run.ok, true);
  assert.match(run.evidence, /exit 0/);
  const bad = await checkVerify('命令:exit 1', { allowCommand: true });
  assert.equal(bad.ok, false);
});

for (const t of tests) {
  await t.fn();
  passed += 1;
  console.log('✅ ' + t.name);
}
console.log(`🎉 记忆视图/技能判据测试通过（${passed} 项）`);
