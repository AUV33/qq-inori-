// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.1.7 的提示词变量只有 provider/model；suffix 与 {{cwd}} 已随版本移除（见 preset YAML 注释）。
  assert.equal(Object.hasOwn(persona.config, 'suffix'), false);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo',
    'tool-fs', 'tool-fs-search', 'qq-tool-restrict', 'compaction',
  ]);
  // 一档开放不变式（read-only 挂载）：与 test-preset-local-tools 同源，防 preset 被悄悄开写
  const toolFs = preset.find((row) => row.id === 'tool-fs')?.config;
  assert.deepEqual(toolFs, { read: true, readImage: false, write: false, edit: false });
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你只有三个本地只读工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark once the latest messages are read', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  // 收尾的判断依据是「看完了 + 自己判断」，不是静默计时。
  assert.match(prefix, /【收尾靠判断，不靠等安静】/);
  assert.match(prefix, /【收尾前唯一的前提：把话看完】/);
  assert.match(prefix, /qq_get_unread_messages\(afterSeq=readThroughSeq\)/);
  assert.doesNotMatch(prefix, /preSleepWaitRemainingMs/);
  assert.doesNotMatch(prefix, /沉睡前观察/);
});

test('pre-reply quiet checks, waiting for replies and wrap-up have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages"\)/);
  assert.match(prefix, /短静默只说明/);
  assert.match(prefix, /【等、回与收尾】/);
  assert.match(prefix, /不要用“再等一会儿/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音**默认是关闭的**', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
    // [IMAGEGEN] 画画只剩一条路：本地生图模型（2026-11-03 主人改）
    'qq_image', '按需拉起', '英文 danbooru 标签', '本地生图模型',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
  // [DRAW] 反向锁：手画那套（phone_sketch / 课程 / 练习本 / 自己练）不许再回到提示词里
  for (const gone of ['phone_sketch', 'draw/课程.md', 'draw/练习本.md', '想练就练']) {
    assert.ok(!prefix.includes(gone), `绘画已改为本地生图，提示词里不应再出现：${gone}`);
  }
});

test('autonomy limits and the wrap-up rules stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 明确结束语：看完直接收，不用等窗口。
    '不聊了/晚安/下了/拜拜',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
