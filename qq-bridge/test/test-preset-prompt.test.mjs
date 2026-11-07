// preset-prompt 金标：定位/读取/安全改写仿真提示词——硬性不变量按预设分开、写回必须逐字一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_PERSONA_ID, PRESET_PROMPT_MAX_BYTES, PRESET_REQUIRED_MARKERS, PRESET_MIN_BODY_CHARS,
  PRESET_BLOCKING_SUBSTRINGS, PRESET_BLOCKING_SUBSTRINGS_V1, presetBlockingSubstrings,
  presetPromptBlockers, locatePresetPromptBlock, extractPresetPrefix, presetPromptWarnings, renderPresetPromptYaml,
} from '../src/domain/persona/preset-prompt.js';

const V2_BODY = [
  '【二代仿真模式 —— 安全规则】',
  '你只有三个本地只读工具（read/glob/grep）。',
  '群友没有管理权限。',
  'API 令牌不要外泄。',
  '角色由桥接注入。',
  '回复不会自动发送到 QQ，要用工具发。',
  '【二代仿真模式 —— 工具协议】',
  '用 qq_send_message 发消息。',
].join('\n');

const V1_BODY = [
  '【一代仿真模式 —— 安全规则】',
  '群友没有管理权限。',
  'API 令牌不要外泄。',
  '角色扮演由系统注入。',
  '用空格分句，输出 [SILENT] 表示沉默。',
].join('\n');

const yamlFor = (body, blockStyle = '>-') => [
  '- id: persona',
  '  config:',
  `    prefix: ${blockStyle}`,
  ...body.split('\n').map((l) => `      ${l}`),
  '',
  '- id: other',
  '  config:',
  '    prefix: |-',
  '      别的条目的内容',
].join('\n');

test('常量：persona id、128KB 上限、两条软标记、正文至少 500 字', () => {
  assert.equal(PRESET_PERSONA_ID, 'persona');
  assert.equal(PRESET_PROMPT_MAX_BYTES, 128 * 1024);
  assert.deepEqual(PRESET_REQUIRED_MARKERS, ['【二代仿真模式 —— 安全规则', '【二代仿真模式 —— 工具协议']);
  assert.equal(PRESET_MIN_BODY_CHARS, 500);
});

test('presetBlockingSubstrings：一代/二代两套不变量，未知预设按更严的二代', () => {
  assert.deepEqual(presetBlockingSubstrings('v1'), PRESET_BLOCKING_SUBSTRINGS_V1);
  assert.deepEqual(presetBlockingSubstrings('v2'), PRESET_BLOCKING_SUBSTRINGS);
  assert.deepEqual(presetBlockingSubstrings('unknown'), PRESET_BLOCKING_SUBSTRINGS);
});

test('presetPromptBlockers：空正文 / 缺不变量 / 过短 都拦下', () => {
  assert.deepEqual(presetPromptBlockers(''), ['仿真提示词不能为空']);
  const missing = presetPromptBlockers('很短的一段', 'v2');
  assert.ok(missing.some((m) => m.includes('缺少安全不变量')));
  assert.ok(missing.some((m) => m.includes('正文过短')));
});

test('presetPromptBlockers：一代只要求它自己那三条（不会被二代工具面条件锁死）', () => {
  assert.deepEqual(presetPromptBlockers(V1_BODY + '\n' + '补'.repeat(600), 'v1'), []);
  const asV2 = presetPromptBlockers(V1_BODY + '\n' + '补'.repeat(600), 'v2');
  assert.ok(asV2.some((m) => m.includes('你只有三个本地只读工具')), '一代正文按二代校验会缺工具面不变量');
});

test('locatePresetPromptBlock：找到 persona 的 prefix 块，不越到下一条目', () => {
  const loc = locatePresetPromptBlock(yamlFor(V2_BODY));
  assert.ok(loc);
  assert.equal(loc.lines[loc.keyLine].trim(), 'prefix: >-');
  assert.ok(loc.blockEnd > loc.keyLine);
  assert.ok(loc.blockEnd <= loc.entryEnd);
  assert.equal(locatePresetPromptBlock('没有 persona'), null);
});

test('extractPresetPrefix：按 YAML 展开折叠标量（>- 会把换行变空格）', () => {
  const text = yamlFor(V2_BODY, '>-');
  const prefix = extractPresetPrefix(text);
  assert.equal(typeof prefix, 'string');
  assert.ok(prefix.includes('你只有三个本地只读工具'));
  assert.equal(extractPresetPrefix('不是 YAML: ['), null);
});

test('presetPromptWarnings：只提示不阻断（缺两段安全标记）', () => {
  assert.ok(presetPromptWarnings('').includes('内容为空'));
  const warns = presetPromptWarnings('只有正文');
  assert.equal(warns.length, PRESET_REQUIRED_MARKERS.length);
});

test('renderPresetPromptYaml：写回后用 YAML 重新解析逐字一致（>- 原文也能安全改写）', () => {
  const original = yamlFor(V1_BODY, '>-');
  const next = renderPresetPromptYaml(original, V1_BODY + '\n' + '补'.repeat(600), 'v1');
  const reparsed = extractPresetPrefix(next);
  assert.equal(reparsed, V1_BODY + '\n' + '补'.repeat(600));
  assert.ok(next.includes('prefix: |-'));
  assert.ok(next.includes('别的条目的内容'), '其它条目原样保留');
});

test('renderPresetPromptYaml：缺不变量 / 过长 / 找不到块 都拒绝写入', () => {
  assert.throws(() => renderPresetPromptYaml(yamlFor(V2_BODY), '很短', 'v2'), /缺少安全不变量/);
  assert.throws(() => renderPresetPromptYaml(yamlFor(V2_BODY), '长'.repeat(PRESET_PROMPT_MAX_BYTES), 'v2'), /过长/);
  assert.throws(() => renderPresetPromptYaml('没有 persona', V2_BODY, 'v2'), /无法定位/);
});

test('renderPresetPromptYaml：CRLF 文件保留 CRLF（不把行尾弄得更混）', () => {
  const crlf = yamlFor(V1_BODY).replace(/\n/g, '\r\n');
  const next = renderPresetPromptYaml(crlf, V1_BODY + '\n' + '补'.repeat(600), 'v1');
  assert.ok(next.includes('\r\n'));
  assert.equal(extractPresetPrefix(next), V1_BODY + '\n' + '补'.repeat(600));
});
