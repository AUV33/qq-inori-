// [DISCIPLINE] 接缝契约的静态回归锁。
//
// 这些断言不是在测“某个函数算得对不对”，而是在测**以后改动不能把已经踩过的坑重新打开**：
//   · 抽出的模块不能拿走构造时的 currentMode/dshReady 快照；
//   · 发送失败路径不能引用不存在的 __deps.st/__deps.now；
//   · 配置加载器不能再次漏掉 imagegen；
//   · 已读水位只能有一个来源（快照 packet.readThroughSeq）；
//   · MCP 工具开关必须有对应的 socialV2.tools 默认项。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivityTrackerRegistry } from '../src/domain/leaves/inori-activity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('抽出的模块使用 getter，不冻结 currentMode/dshReady', () => {
  const intake = read('src/domain/conversation/message-intake.mjs');
  const schedule = read('src/domain/conversation/wake-schedule.mjs');
  const sender = read('src/domain/conversation/wake-sender.mjs');
  for (const [name, src] of [['message-intake', intake], ['wake-schedule', schedule], ['wake-sender', sender]]) {
    assert.ok(src.includes('getCurrentMode'), `${name} 缺少 getCurrentMode 依赖`);
    assert.ok(src.includes('modeNow()'), `${name} 没有实际使用 modeNow()`);
  }
  assert.ok(intake.includes('getDshReady') && intake.includes('dshReadyNow()'), 'message-intake 仍在用构造时 dshReady 快照');
  const app = read('src/app.mjs');
  const modeGetters = (app.match(/getCurrentMode: \(\) => currentMode/g) || []).length;
  assert.ok(modeGetters >= 3, `app 只给 ${modeGetters} 个模块注入 currentMode getter（应为 3：intake/scheduler/sender）`);
  assert.ok(app.includes('getDshReady: () => dshReady'), 'app 没有给 intake 注入 dshReady getter');
});

test('发送失败 catch 不再引用不存在的 __deps.st / __deps.now', () => {
  const consoleSrc = read('src/adapters/console-server.mjs')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/__deps\.st\b/.test(consoleSrc), 'console-server 仍引用 __deps.st');
  assert.ok(!/__deps\.now\b/.test(consoleSrc), 'console-server 仍引用 __deps.now');
  const app = read('src/app.mjs');
  assert.ok(!app.includes('get st() { return st; }'), 'console/pump deps 仍暴露未定义的 st getter');
  assert.ok(!app.includes('get now() { return now; }'), 'console deps 仍暴露未定义的 now getter');
});

test('loadConfig 显式透传 imagegen/life，config.example 有 quoteFix/imagegen/life', () => {
  const app = read('src/app.mjs') + read('src/bootstrap/config.mjs');
  assert.ok(app.includes('imagegen: { ...(file.imagegen ?? {}) }'), 'loadConfig 漏了 imagegen');
  // [LIFE-CONFIG] S4：生命内核运行模式必须显式透传，否则 config.json 写 life.mode 也开不起来。
  // 旧的 kernel.shadow 旋钮已移除，life.mode 是唯一开关。
  assert.ok(app.includes("life: {"), 'loadConfig 漏了 life');
  assert.ok(app.includes("mode: 'off'"), 'life.mode 默认值缺失');
  const example = JSON.parse(read('config.example.json'));
  assert.equal(typeof example.socialV2?.send?.quoteFix, 'boolean', 'config.example 缺 socialV2.send.quoteFix');
  assert.ok(example.imagegen && typeof example.imagegen === 'object', 'config.example 缺 imagegen');
  assert.ok(example.life && typeof example.life === 'object', 'config.example 缺 life');
  // 新部署默认开启影子内核（只推演/写回自我标量，不接管发送）；旧 config.json 无 life 段时 bootstrap 兜底 off。
  assert.equal(example.life.mode, 'shadow', 'config.example 的 life.mode 默认应为 shadow（新部署通电）');
});

test('已读水位只有一个来源：prompt 用 wakeSnapshot.readThroughSeq，wake-sender 不再写 lastUnreadSeq', () => {
  const app = read('src/app.mjs') + read('src/domain/social/social-core.mjs');
  assert.ok(app.includes('promptReadThrough = wakeSnapshot'), 'prompt 没有使用快照水位');
  assert.ok(app.includes('lastPromptSeq = promptReadThrough'), 'lastPromptSeq 没有跟快照水位对齐');
  const rejectedAt = app.indexOf('if (!accepted.result.ok)');
  const advanceAt = app.indexOf('lastPromptSeq = promptReadThrough');
  assert.ok(rejectedAt > 0 && advanceAt > rejectedAt, 'lastPromptSeq 必须在 accepted.result.ok 之后才推进');
  const sender = read('src/domain/conversation/wake-sender.mjs');
  assert.ok(!sender.includes('st.lastPromptSeq = Number(st.lastUnreadSeq)'), 'wake-sender 还在把 lastUnreadSeq 当已展示水位');
});

test('MCP 工具开关都能在 socialV2.tools 默认表里找到', () => {
  const flagsSrc = read('src/domain/shared/tool-flags.js');
  const defaultsBlock = flagsSrc.match(/export const SOCIAL_V2_TOOLS_DEFAULTS\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  const defaults = new Set([...defaultsBlock.matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1]));
  const flagsBlock = flagsSrc.match(/export const TOOL_CONFIG_FLAGS\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  const flags = new Set([...flagsBlock.matchAll(/:\s*['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]));
  const missing = [...flags].filter((f) => !defaults.has(f));
  assert.deepEqual(missing, [], `这些 MCP 开关没有默认值：${missing.join(', ')}`);
  assert.ok(flags.has('image'), 'qq_image 没有映射到 image 开关');
  assert.equal(defaultsBlock.match(/groupAdmin:\s*(true|false)/)?.[1], 'false', 'groupAdmin 应默认关闭');
  for (const f of ['image', 'selfNote', 'hostAction', 'groupAdmin', 'wish', 'selfWake', 'ownLifeRhythm', 'myDay']) {
    assert.ok(flagsSrc.includes(`'${f}'`), `CONSOLE_TOOL_FLAGS 缺 ${f}`);
  }
  assert.ok(read('src/app.mjs').includes("from './domain/shared/tool-flags.js'"), 'app 没有从 tool-flags 导入默认表');
  assert.ok(read('src/mcp-snowluma-safe.js').includes("from './domain/shared/tool-flags.js'"), 'MCP 没有从 tool-flags 导入映射');
  const consoleSrc = read('src/adapters/console-server.mjs');
  assert.ok(consoleSrc.includes('const toolFlags = CONSOLE_TOOL_FLAGS;'), '控制台没有使用单一开关表');
  assert.ok(consoleSrc.includes('ownerPrivateTokenOk'), '群管理端点缺少 owner 私聊令牌校验');
  assert.ok(consoleSrc.includes('群管理动作只允许主人私聊令牌'), '群管理端点缺少明确的 403 文案');
});

test('自由度许可句在 app 接线，且 prompt 不再写“必须直接回”', () => {
  const app = read('src/app.mjs') + read('src/domain/social/social-core.mjs');
  assert.ok(app.includes('renderFreedomPermission'), 'app 没有接自由度许可句');
  assert.ok(app.includes('freedom-log.jsonl'), 'app 没有接自由度观测落盘');
  const prompt = read('src/domain/persona/wake-prompt.mjs');
  assert.ok(!prompt.includes('就直接回，不用等安静'), 'wake-prompt 还在写“必须直接回”');
});

test('self-recent 默认不在群里递私聊，且 app 接 sharePrivate', () => {
  const moduleSrc = read('src/domain/leaves/inori-self-recent.mjs');
  assert.ok(moduleSrc.includes('allowPrivate = false'), 'self-recent 默认应禁止私聊→群');
  assert.ok(moduleSrc.includes('selfIsGroup && !entryIsGroup && !allowPrivate'), '缺少 scope 过滤');
  const app = read('src/app.mjs') + read('src/domain/memory/self-context-service.mjs');
  assert.ok(app.includes('allowPrivate: cfg.socialV2?.memoryInject?.sharePrivate === true'), 'app 没有把 sharePrivate 接给 self-recent');
});

test('activity 轨迹按会话隔离，不把两个会话的步骤串在一起', () => {
  const tracker = createActivityTrackerRegistry();
  tracker.record('group:1', 'mcp__phone__phone_tap', { x: 1, y: 2 }, true);
  assert.equal(tracker.forKey('group:1').current.steps.length, 1);
  assert.equal(tracker.forKey('group:2').current, null, '另一个会话不应看到 group:1 的步骤');
});
