// [STICKER-USE] 表情包的策略文案与注入位置（2026-10-29）
//
// 背景：她 14 张收藏表情都有备注、工具全开，却 21 小时一张没发（历史总共 5 次）。
// 不是链路坏（send-sticker 端点、短引用都正常），是两处软问题：
//   ① 表情块在装饰层，落在 10.9k 字 prompt 的 79% 处——读到那儿她已经准备收尾；
//   ② 策略 680 字、7 条里 5 条「不要/别」+「每 3~5 轮一张」的配额说法，读起来像禁令。
// 这里锁住：后续重构别把这两块挪回去，也别把文案改回禁令腔/配额腔。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildStickerStrategyHint } from '../src/domain/send/sticker-lib.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const hint = buildStickerStrategyHint();

test('策略文案：先给许可与场合，保留两条硬约束', () => {
  assert.ok(hint.includes('想用就用'), '要有许可，不是只有禁令');
  assert.ok(hint.includes('qq_send_sticker'), '给发送工具');
  assert.ok(hint.includes('不能在同一气泡里附带文字'), '保留单气泡约束（MCP 工具同口径）');
  assert.ok(hint.includes('一条消息只能是一张'), '保留一条一张');
  assert.ok(!hint.includes('每 3~5 轮'), '不设配额——配额会把她任务化');
  assert.ok(!/^【表情包策略/m.test(hint), '标题不再叫“策略”，避免像规矩');
  assert.ok(hint.length < 600, `文案要短（实际 ${hint.length} 字）`);
});

// [STICKER-COMBO] 2026-10-30：她不是不会发，是每次权衡都选文字——「说一句 + 配一张」要两次调用、
// 两条气泡，而文字一次就够。qq_send_message 增加可选 stickerId/stickerQuery 后成本回到一条文字。
// 这里锁住三件事：工具面确实有入口、端点确实先发文字再发表情、lastContext 不再恒为常量。
test('组合发送：qq_send_message 可带 stickerId，一次调用发文字+表情', () => {
  assert.ok(hint.includes('qq_send_message'), '策略提示要告诉她这个更省事的入口');
  assert.ok(!hint.includes('配不上就先不发'), '末句不再是「不发」的否决句');
  // qq_send_message 的注册已随二代仿真组拆到 mcp-reserved2-tools.js；源码契约需同时检索两个文件。
  const mcp = read('../src/mcp-snowluma-safe.js') + '\n' + read('../src/mcp-reserved2-tools.js');
  const start = mcp.search(/server\.tool\(\s*'qq_send_message'/);
  const end = mcp.indexOf("'qq_send_to'", start > 0 ? start : 0);
  const sendBlock = mcp.slice(start > 0 ? start : 0, end > 0 ? end : mcp.length);
  assert.ok(sendBlock.includes('stickerId'), 'qq_send_message 暴露 stickerId');
  assert.ok(sendBlock.includes('stickerQuery'), 'qq_send_message 暴露 stickerQuery');
  const server = read('../src/adapters/console-server.mjs');
  assert.ok(server.includes('[STICKER-COMBO]'), '端点里有组合发送分支');
  assert.ok(server.includes("context: messages.join(' / ')"), '表情语境取这条文字');
  const app = read('../src/app.mjs') + read('../src/domain/social/sticker-service.mjs');
  assert.ok(app.includes('options.context'), 'sendStickerV2 接受真实语境');
  assert.ok(!app.includes("markStickerUsed(stickerEntries, entry.id, 'sticker')"), 'lastContext 不再恒为常量');
});

test('注入位置：表情块在核心层（紧跟首回复节奏），不在装饰层', () => {
  const src = read('../src/domain/persona/wake-prompt.mjs');
  const coreLine = src.match(/const coreParts = \[[\s\S]*?\];/);
  assert.ok(coreLine, '找到 coreParts');
  assert.ok(coreLine[0].includes('stickerLine, stickerPickLine'), '表情块必须进核心层（参考/装饰层末尾都太靠后）');
  const decoLine = src.match(/const decoParts = \[[\s\S]*?\];/);
  assert.ok(decoLine, '找到 decoParts');
  assert.ok(!decoLine[0].includes('stickerLine'), '装饰层不能再有表情块（会被预算裁掉/排到最后）');
});
