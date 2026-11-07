// 回归锁：对话唤醒的注入层（记忆/经验/目标/自我模型/念头/洞见…）必须真的进她收到的 prompt。
//
// 背景（2026-10-25 审计 blocker）：sendWakePromptV2 拼好 15+ 注入层后交给
// deliverPrompt(key, promptText, { wakeReason })，而 deliverPromptNow 的 wakeReason 分支
// 会用 buildWakePromptV2 **整体覆盖** promptText（本意是刷新令牌/快照）——注入层被丢弃，
// 她的长期记忆/状态在对话唤醒主通道全部缺席（反思等自主通道不受影响，所以问题一直隐身）。
// 修复方式：注入层通过 opts.wakeInjections 随唤醒一起传递，deliverPromptNow 重建基底后拼回。
//
// 本测试锁住这条链路的两侧接线（任一侧漂移就红），并锁定「基底重算只刷新令牌与快照」
// 的语义不变（buildWakePromptV2 仍被调用）。
import { readBridgeSource } from './lib/bridge-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = readBridgeSource();

// 发送侧：sendWakePromptV2 必须把拼好的注入层计算出来并传给 deliverPrompt
assert.ok(/wakeInjections\s*=/.test(src), 'sendWakePromptV2 侧：必须计算 wakeInjections');
assert.ok(/deliverPrompt\(\s*key\s*,\s*promptText\s*,\s*\{\s*wakeReason\s*:\s*reason\s*,\s*wakeInjections\s*\}\)/.test(src),
  'sendWakePromptV2 必须把 wakeInjections 传进 deliverPrompt');

// 接收侧：deliverPromptNow 的 wakeReason 分支必须消费 opts.wakeInjections 并拼在基底之后
const wakeBranch = src.slice(src.indexOf('if (opts.wakeReason)'));
assert.ok(wakeBranch.length > 0, 'deliverPromptNow 必须有 wakeReason 分支');
assert.ok(/promptText\s*=\s*buildWakePromptV2\(\s*key\s*,\s*opts\.wakeReason\s*\)/.test(wakeBranch),
  'wakeReason 分支仍重建基底（刷新令牌/快照的语义不能丢）');
assert.ok(/opts\.wakeInjections/.test(wakeBranch), 'wakeReason 分支必须消费 opts.wakeInjections');
// 顺序不变式：注入层拼在基底**前面**（与 sendWakePromptV2 的逐层 prepend 结果一致）
assert.ok(/promptText\s*=\s*opts\.wakeInjections\s*\+\s*promptText/.test(wakeBranch),
  '注入层必须拼在基底前面（prepend 语义）');

// 基底侧：buildWakePromptV2 内不得再自带这些注入层（它们只属于 sendWakePromptV2）
// 2026-10-28：主体已抽到 src/wake-prompt.mjs，断言直接扫模块本体。
const builder = fs.readFileSync(new URL('../src/domain/persona/wake-prompt.mjs', import.meta.url), 'utf8');
for (const marker of ['renderGoals(', 'loadLessons(', 'recallBlock(', 'buildSelfModel(', 'appendTask(']) {
  assert.ok(!builder.includes(marker), `buildWakePromptV2 基底不得内置注入层（${marker}）`);
}

// 基底必须带生活时间线（[LIFE-TIME]：刚醒不知道现在几点）
assert.ok(/renderLifeLine\(\s*lifeState/.test(builder), '基底含 renderLifeLine(lifeState) 生活时间线');

console.log('wake-inject 回归锁通过：注入层随 wakeInjections 传递，基底重算不再丢弃它们');
