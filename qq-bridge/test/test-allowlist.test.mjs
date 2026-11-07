// [MATRIX] allowlist.mjs 的直接测试：名单文件解析、文件权威、deny 优先、行级编辑保留注释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAllowlist } from '../src/domain/shared/allowlist.mjs';

function make(t, fileText = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inori-allowlist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'allowlist.txt');
  if (fileText !== null) fs.writeFileSync(file, fileText, 'utf8');
  const logs = [];
  const writes = [];
  const al = createAllowlist({
    ROOT: dir,
    log: (msg) => logs.push(String(msg)),
    writeTextAtomic: (f, text, opts) => { writes.push({ f, text, opts }); fs.writeFileSync(f, text, 'utf8'); },
  });
  return { dir, file, al, logs, writes };
}

const cfg = (over = {}) => ({
  deny: { private: [], group: [] },
  allow: { private: [], group: [] },
  allowAllWhenEmpty: false,
  ...over,
});

test('无名单文件时回落到 config.allow / allowAllWhenEmpty，且兼容单复数键', (t) => {
  const { al } = make(t);
  assert.equal(al.readWallEntries(), null);
  assert.equal(al.loadAllowlistFile(), null);
  assert.equal(al.allowed('private', 10001, cfg({ allow: { private: ['10001'], group: [] } })), true);
  assert.equal(al.allowed('private', '10002', cfg({ allow: { private: ['10001'], group: [] } })), false);
  assert.equal(al.allowed('group', '777', cfg({ allow: { privates: ['1'], groups: ['777'] } })), true);
  assert.equal(al.allowed('group', '999', cfg()), false);
  assert.equal(al.allowed('group', '999', cfg({ allowAllWhenEmpty: true })), true);
});

test('名单文件解析：BOM / 注释 / 行内注释 / 非法行告警，groups 是 group 的别名', (t) => {
  const { al, logs } = make(t, '\uFEFF# 名单\nprivate:10001 # 主人\ngroup:777\n乱写一行\n\n');
  assert.deepEqual(al.readWallEntries(), { private: [10001], group: [777] });
  const loaded = al.loadAllowlistFile();
  assert.deepEqual(loaded.private, ['10001']);
  assert.deepEqual(loaded.group, ['777']);
  assert.equal(loaded.groups, loaded.group);
  assert.ok(logs.some((l) => l.includes('无法识别')), '坏行必须可见，不能静默忽略');
  assert.ok(logs.some((l) => l.includes('已载入名单文件')));
});

test('名单文件一旦存在就是权威：config.allow 整段不可达，且不会漏回 allowAllWhenEmpty', (t) => {
  const { al, logs } = make(t, 'private:10001\n');
  const c = cfg({ allow: { private: ['10001', '10002'], group: ['777'] }, allowAllWhenEmpty: true });
  assert.equal(al.allowed('private', '10001', c), true);
  assert.equal(al.allowed('private', '10002', c), false, '只在 config 里的私聊不得放行');
  assert.equal(al.allowed('group', '777', c), false, '文件没写 group 时群一律拒绝');
  assert.equal(al.allowed('group', '777', cfg({ allowAllWhenEmpty: true })), false);
  assert.ok(logs.some((l) => l.includes('不一致')), '配置与文件分歧必须告警');
});

test('deny 优先于名单文件；id 数字/字符串统一比较', (t) => {
  const { al } = make(t, 'private:10001\ngroup:777\n');
  assert.equal(al.allowed('private', '10001', cfg({ deny: { private: ['10001'], group: [] } })), false);
  assert.equal(al.allowed('private', 10001, cfg()), true);
  assert.equal(al.allowed('group', 777, cfg()), true);
});

test('writeWallEntries 只增删条目并保留注释/行内说明，写后缓存失效', (t) => {
  const { al, file, writes } = make(t, '# 名单注释\nprivate:10001 # 主人\ngroup:777\ngroup:888\n');
  assert.equal(al.allowed('group', '777', cfg()), true); // 先建立缓存
  al.writeWallEntries({ private: ['10001', '10002'], group: ['888'] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].opts?.source, 'bridge/console-whitelist');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('# 名单注释'), '注释行必须保留');
  assert.ok(text.includes('private:10001 # 主人'), '保留条目的行内说明必须保留');
  assert.ok(text.includes('private:10002'), '新增条目必须追加');
  assert.ok(text.includes('group:888'), '保留的群条目必须留下');
  assert.equal(text.includes('group:777'), false, '被移除的群条目必须删掉');
  assert.equal(al.readWallEntries().private.length, 2);
  assert.equal(al.allowed('group', '777', cfg()), false, '写后缓存必须失效，不能读到旧名单');
  assert.equal(al.allowed('private', '10002', cfg()), true);
});
