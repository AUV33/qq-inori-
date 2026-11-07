// bootstrap/text-utils 金标：思考强度归一、静默标记、脱敏（正则 + 已知令牌）、CQ 转义、活动日志尾部。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT, normalizeReasoningEffort,
  isSilentMarker, redactSensitiveText, escapeCqText, readActivityTail,
} from '../src/bootstrap/text-utils.mjs';
import { KNOWN_AGENT_TOKENS } from '../src/bootstrap/agent-tokens.mjs';

test('normalizeReasoningEffort：只接受 low/high/max，大小写与空白归一', () => {
  assert.deepEqual(REASONING_EFFORT_OPTIONS, ['low', 'high', 'max']);
  assert.equal(REASONING_EFFORT_DEFAULT, 'max');
  assert.equal(normalizeReasoningEffort(' HIGH '), 'high');
  assert.equal(normalizeReasoningEffort('Max'), 'max');
});

test('normalizeReasoningEffort：非法值必须抛错（回退策略交给调用方）', () => {
  for (const bad of ['turbo', '', null, undefined, 123]) {
    assert.throws(() => normalizeReasoningEffort(bad), /思考强度只能是/, String(bad));
  }
});

test('isSilentMarker：只认整条 [SILENT]，大小写不敏感', () => {
  assert.equal(isSilentMarker('[SILENT]'), true);
  assert.equal(isSilentMarker('  [silent]  '), true);
  assert.equal(isSilentMarker('说点 [SILENT] 别的'), false, '不能误伤正常说话');
  assert.equal(isSilentMarker(''), false);
  assert.equal(isSilentMarker(null), false);
});

test('redactSensitiveText：命中敏感正则需要打码，正常文本原样', () => {
  assert.equal(redactSensitiveText('token=abcd1234'), '***');
  assert.equal(redactSensitiveText('今天天气不错'), '今天天气不错');
  assert.equal(redactSensitiveText(null), '');
});

test('redactSensitiveText：已知 agent token 必须精确打码（32-hex 不匹配正则，只能靠名单）', () => {
  const token = [...KNOWN_AGENT_TOKENS][0];
  if (!token) return; // 名单为空时跳过（运行期才会加载）
  const out = redactSensitiveText(`带令牌 ${token} 的句子`);
  assert.ok(!out.includes(token));
  assert.ok(out.includes('***'));
});

test('escapeCqText：把 [CQ: 换全角冒号，避免被网关当 CQ 码解析', () => {
  assert.equal(escapeCqText('[CQ:at,qq=1]'), '[CQ：at,qq=1]');
  assert.equal(escapeCqText('普通文本'), '普通文本');
  assert.equal(escapeCqText(null), '');
});

test('readActivityTail：取末尾 n 行；文件缺失返回空串', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-textutils-'));
  const file = path.join(dir, 'activity.log');
  fs.writeFileSync(file, ['l1', 'l2', 'l3', 'l4'].join('\n') + '\n', 'utf8');
  assert.equal(readActivityTail(file, 2), 'l3\nl4');
  assert.equal(readActivityTail(file, 99), 'l1\nl2\nl3\nl4');
  assert.equal(readActivityTail(path.join(dir, 'nope.log'), 3), '');
});
