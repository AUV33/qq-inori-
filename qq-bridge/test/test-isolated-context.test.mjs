// [ISOLATED-CONTEXT] 回归锁：后台隔离会话不能拿到会话令牌/消息快照。
//
// 2026-10-28 00:59 真实事故：ownlife（她的自由时间）会话被投递了 buildWakePromptV2(主人私聊)，
// 于是它拿着一模一样的上下文和令牌，往主人私聊发了两句「困。都快一点了」「突然问这个干嘛」。
// 锁三件事：① 只有 task/gate 走完整唤醒上下文；② 其余走 buildIsolatedContextV2；
// ③ 这个轻上下文里绝不能出现 agentToken。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeSource } from '../scripts/lib/bridge-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 实现已从 bridge.js 迁到 app.mjs（2026-10-28 入口拆分）；合集里两者都有。
const src = readBridgeSource();

test('deliverToIsolated：只有 task/gate 拿完整唤醒上下文', () => {
  assert.match(src, /if \(kind === 'task' \|\| kind === 'gate'\)[\s\S]{0,120}buildWakePromptV2\(key, reason\)[\s\S]{0,200}else \{[\s\S]{0,400}buildIsolatedContextV2\(key\)/);
  assert.match(src, /buildContextPacket\(\{ purpose: 'isolated'/);
});

test('buildIsolatedContextV2 存在，且只给角色/会话清单/一句约束', () => {
  // 2026-10-28 重构后，app.mjs 里留下的是同名一行包装（转发到 runtime-services.mjs），
  // 真正的实现在合集后面。这里取**含 roleHintForMode 的那份**，别拿包装当实现。
  const starts = [];
  let i = src.indexOf('function buildIsolatedContextV2');
  while (i >= 0) { starts.push(i); i = src.indexOf('function buildIsolatedContextV2', i + 1); }
  assert.ok(starts.length > 0, '缺少 buildIsolatedContextV2');
  const body = starts.map((s) => src.slice(s, s + 6000)).find((b) => b.includes('roleHintForMode'));
  assert.ok(body, '找不到 buildIsolatedContextV2 的实现体');
  assert.match(body, /renderConversations/);
  assert.match(body, /这是背景，不是催你回话/);
  assert.ok(!/agentToken|ownerAgentToken|readToken/.test(body), '轻上下文里不许出现任何令牌');
});

test('自我加「」的规则已从角色卡移到提示层（wake-prompt 的【怎么发】）', (t) => {
  const dir = path.join(root, 'roles');
  const name = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.endsWith('.md')) : '';
  if (!name) { t.skip('本机没有 roles/*.md（人格卡私有，公开仓库不含）'); return; }
  const card = fs.readFileSync(path.join(dir, name), 'utf8');
  const wakePrompt = fs.readFileSync(path.join(root, 'src/domain/persona/wake-prompt.mjs'), 'utf8');
  assert.ok(!card.includes('留个信（「沉了」'), '角色卡仍保留带引号的示例');
  // [FORMAT-OWN] 2026-10-30：分条/引用/自我括号都交给她按提示词决定，不再写在角色卡里。
  assert.ok(!card.includes('别用「」把自己说的话括起来'), '角色卡不该再写发送规则（已移到提示层）');
  assert.match(wakePrompt, /【怎么发】/, '提示层缺少【怎么发】块');
  assert.match(wakePrompt, /别用「」把自己的话整条括起来/, '提示层缺少「」规则');
});
