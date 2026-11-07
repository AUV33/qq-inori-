// [ROLE-PRESET-STORE] 人格/预设文件层的回归锁。
//
// 这块从 app.mjs 搬出来（P3-1a）时最容易漂移的是三件事：
//   1) roleInjectMaxChars 被复制成模块状态，控制台改了上限、摘要还按旧值算；
//   2) 人格名校验少一条（Windows 设备名 / 保留名 / 超长）；
//   3) 预设备份的前缀丢了预设名，控制台「还原」列到另一个预设的备份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRolePresetStore, applyRoleInjectLimit, ROLE_INJECT_MAX_CHARS_DEFAULT } from '../src/domain/persona/role-preset-store.mjs';

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'role-preset-'));
  fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  let limit = ROLE_INJECT_MAX_CHARS_DEFAULT;
  const store = createRolePresetStore({
    root,
    stateDir: path.join(root, 'state'),
    atomicWriteText: (file, text) => fs.writeFileSync(file, text),
    sanitizeRoleName: (name) => String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, ''),
    getInjectMaxChars: () => limit,
  });
  return { root, store, setLimit: (n) => { limit = n; } };
}

const ROLE_TEXT = [
  '# 小满',
  '这是共同部分。',
  '## 一代专用 〔一代〕',
  '用空格分条。',
  '## 二代专用 〔二代〕',
  '这是二代才注入的内容。',
].join('\n');

test('listRoles：只列 .md、排除 README、按中文名排序', () => {
  const { root, store } = makeStore();
  fs.writeFileSync(path.join(root, 'roles', 'README.md'), '# readme');
  fs.writeFileSync(path.join(root, 'roles', '乙.md'), '# 乙');
  fs.writeFileSync(path.join(root, 'roles', '甲.md'), '# 甲');
  fs.writeFileSync(path.join(root, 'roles', 'note.txt'), 'not a role');
  assert.deepEqual(store.listRoles(), ['甲', '乙']);
});

test('roleSummaries：注入上限是动态读的，不冻结构造时的值', () => {
  const { root, store, setLimit } = makeStore();
  fs.writeFileSync(path.join(root, 'roles', '小满.md'), ROLE_TEXT);
  const first = store.roleSummaries()[0];
  assert.equal(first.name, '小满');
  assert.equal(first.chars, ROLE_TEXT.length);
  assert.equal(first.injectedV2, Math.min(first.charsV2, ROLE_INJECT_MAX_CHARS_DEFAULT));
  assert.equal(first.truncated, false);

  setLimit(5);
  const second = store.roleSummaries()[0];
  assert.equal(second.injectedV1, 5);
  assert.equal(second.injectedV2, 5);
  assert.equal(second.truncated, true);
});

test('roleWarnings：超上限 + 未标记的一代指令都要报', () => {
  const { store, setLimit } = makeStore();
  const text = '# 角色\n[SILENT] 不要说话\n' + '很长'.repeat(50);
  setLimit(20);
  const warnings = store.roleWarnings(text, 'v2');
  assert.ok(warnings.some((w) => w.includes('超出注入上限')));
  assert.ok(warnings.some((w) => w.includes('一代仿真专用指令')));
  // 一代模式不注入二代内容，但同一段未标记文本仍该提示
  assert.ok(store.roleWarnings(text, 'v1').length >= 1);
});

test('validateRoleName：合法名保留，空/保留/设备名/超长都拒绝', () => {
  const { store } = makeStore();
  assert.equal(store.validateRoleName(' 小满-A_1 '), '小满-A_1');
  assert.throws(() => store.validateRoleName('!!!'), /不能为空/);
  assert.throws(() => store.validateRoleName('README'), /保留名称/);
  assert.throws(() => store.validateRoleName('con'), /系统保留名称/);
  assert.throws(() => store.validateRoleName('长'.repeat(41)), /过长/);
});

test('validateRoleContent：去 BOM 式空白、拒绝空内容和超 64KB', () => {
  const { store } = makeStore();
  assert.equal(store.validateRoleContent('  # 角色\r\n正文  '), '# 角色\n正文');
  assert.throws(() => store.validateRoleContent('   '), /不能为空/);
  assert.throws(() => store.validateRoleContent('x'.repeat(64 * 1024 + 1)), /过长/);
});

test('writeRoleContent exclusive：已存在抛 EEXIST，不覆盖', () => {
  const { store } = makeStore();
  store.writeRoleContent('小满', 'A');
  assert.throws(() => store.writeRoleContent('小满', 'B', { exclusive: true }), /EEXIST/);
  assert.equal(store.readRoleContent('小满'), 'A\n');
});

test('writeRoleContent：自动补尾换行，读回一致', () => {
  const { root, store } = makeStore();
  store.writeRoleContent('小满', '# 角色\n正文');
  const file = path.join(root, 'roles', '小满.md');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 角色\n正文\n');
  assert.equal(store.readRoleContent('小满'), '# 角色\n正文\n');
});

test('预设：读 prefix、状态、备份前缀带预设名', () => {
  const { root, store } = makeStore();
  const presetDir = path.join(root, 'dsh', 'agent-presets', 'qq-chat-v2');
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(path.join(presetDir, 'agent.cordis.yml'), [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |-',
    '      hello prompt',
  ].join('\n'));

  const { prefix } = store.readPresetPromptText('qq-chat-v2');
  assert.equal(prefix, 'hello prompt');

  const status = store.presetStatus('qq-chat-v2');
  assert.equal(status.preset, 'qq-chat-v2');
  assert.match(status.label, /二代/);
  assert.equal(status.sourceFile, path.join('dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'));
  assert.equal(status.requiresRestart, true);

  const backup = store.backupPresetFile('qq-chat-v2');
  assert.ok(backup && fs.existsSync(backup));
  assert.match(path.basename(backup), /^qq-chat-v2\.agent\.cordis\.yml\./);
  const backups = store.listPresetBackups('qq-chat-v2');
  assert.equal(backups.length, 1);
  assert.equal(backups[0].file, path.basename(backup));
});

test('applyRoleInjectLimit：非法值回默认，合法值夹在 1000~20000', () => {
  assert.equal(applyRoleInjectLimit('abc'), ROLE_INJECT_MAX_CHARS_DEFAULT);
  assert.equal(applyRoleInjectLimit(1), 1000);
  assert.equal(applyRoleInjectLimit(999999), 20000);
  assert.equal(applyRoleInjectLimit('4321.4'), 4321);
});
