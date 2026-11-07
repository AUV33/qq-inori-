import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_TOOL_FLAGS,
  SEND_TOOL_NAMES,
  SOCIAL_V2_TOOLS_DEFAULTS,
  TOOL_CONFIG_FLAGS,
  isSendToolName,
} from '../src/domain/shared/tool-flags.js';

test('SEND_TOOL_NAMES 全部有开关映射（否则注册期过滤会漏）', () => {
  const missing = SEND_TOOL_NAMES.filter((name) => !TOOL_CONFIG_FLAGS[name]);
  assert.deepEqual(missing, [], `缺少开关映射：${missing.join(', ')}`);
});

test('isSendToolName 识别完整/短名，排除发到别的会话的工具', () => {
  for (const name of SEND_TOOL_NAMES) {
    assert.equal(isSendToolName(name), true, name);
    assert.equal(isSendToolName(`mcp__snowluma__${name}`), true, `mcp__snowluma__${name}`);
  }
  assert.equal(isSendToolName('qq_send_to'), false);
  assert.equal(isSendToolName('mcp__snowluma__qq_scene_send'), false);
  assert.equal(isSendToolName(''), false);
});

test('CONSOLE_TOOL_FLAGS 覆盖 SOCIAL_V2_TOOLS_DEFAULTS 的全部键', () => {
  const missing = Object.keys(SOCIAL_V2_TOOLS_DEFAULTS).filter((flag) => !CONSOLE_TOOL_FLAGS.includes(flag));
  assert.deepEqual(missing, [], `保存时会被丢掉的 flag：${missing.join(', ')}`);
});
