#!/usr/bin/env node
// extract-memory.mjs · 手动跑一轮「本地 3B 记忆抽取」，用于验证/补录（桥接里也会自动跑）
//
// 用法：
//   node scripts/extract-memory.mjs --key private:10001 --dry-run
//   node scripts/extract-memory.mjs --key group:123456789 --write
//
// 默认 dry-run：只打印抽到的事实，不写库。--write 才追加到对应 scope 的记忆文件。
import fs from 'node:fs';
import path from 'node:path';
import { completeLocal3b, local3bAlive, ensureLocal3b } from '../src/domain/memory/local-3b.js';
import { extractFacts } from '../src/domain/leaves/inori-memory-extract.js';
import { filesForScope, loadEntries } from '../src/domain/memory/memory-retrieve.js';
import { appendJsonl } from '../../ai-companion-kit/packages/shared/learning-store.mjs';
import { PROJECT_ROOT, bridgePath, MEMORY_DIR } from '../src/domain/shared/project-paths.js';

const argv = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const key = String(opt('key', 'private:10001'));
const write = argv.includes('--write');
const cfg = JSON.parse(fs.readFileSync(bridgePath('config.json'), 'utf8'));

const stateFile = bridgePath('state', 'social-v2.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const conv = state?.conversations?.[key];
if (!conv) { console.error(`没有这个会话：${key}`); process.exit(2); }
const messages = (conv.recentMessages ?? []).filter((m) => m && !m.isSelf && String(m.text ?? '').trim()).slice(-16);
if (messages.length < 2) { console.error('最近没有足够的入站消息'); process.exit(2); }

if (!(await local3bAlive(cfg))) {
  console.log('本地 3B 没起来，先拉起（下一轮可用）；本次直接退出');
  await ensureLocal3b(cfg, (l) => console.log(l));
  process.exit(3);
}

const P = filesForScope(cfg.socialV2?.memory?.dir || MEMORY_DIR, key);
const rows = loadEntries(P.file).slice(-600);
const out = await extractFacts({
  messages,
  existingTexts: rows.map((r) => String(r?.text ?? '')),
  max: Number(cfg.socialV2?.memoryExtract?.maxFacts) || 3,
  complete: (prompt) => completeLocal3b(cfg, { prompt, maxTokens: 280, timeoutMs: 20000, log: (l) => console.log(l) }),
});

console.log(`会话 ${key}：${messages.length} 条入站消息 → 抽出 ${out.facts.length} 条`);
for (const f of out.facts) console.log('  ·', f);
if (!out.facts.length) { console.log('（模型原文）', String(out.raw ?? '').slice(0, 200)); process.exit(0); }

if (write) {
  const d = new Date();
  const day = d.toLocaleDateString('sv-SE');
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  for (const fact of out.facts) {
    appendJsonl(P.file, { day, time: `${day} ${hm}`, kind: 'fact', text: fact, theme: '抽取', scope: P.scope, importance: 2 }, { source: 'cli/extract-memory' });
  }
  console.log(`已写入 ${out.facts.length} 条 → ${path.relative(PROJECT_ROOT, P.file)}`);
} else {
  console.log('（dry-run：加 --write 才写入）');
}
