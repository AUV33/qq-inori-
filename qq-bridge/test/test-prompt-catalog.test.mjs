// prompt-catalog.js 单测：可查目录的入口、块标题映射、私聊过滤与预算截断。
//
// 契约重点（文件头纪律）：目录里只列**真实注册过的工具**——漏注册/改名必须直接红，
// 否则她照目录去调一个不存在的工具，比不给入口更糟。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOOKUP_ENTRIES, lookupEntryFor, lookupHintFor, renderLookupCatalog, EXTERNAL_TOOLS, DIRECT_TOOLS, CATALOG_MAX_CHARS } from '../src/domain/persona/prompt-catalog.js';
import { TOOL_CONFIG_FLAGS } from '../src/domain/shared/tool-flags.js';
import { compactInjection, enforceInjectionBudget } from '../src/domain/persona/prompt-budget.js';

const toolOf = (call) => String(call).split(/[ (]/)[0];

test('目录只列真实注册过的工具（漏注册/改名直接红）', () => {
  assert.ok(LOOKUP_ENTRIES.length >= 5, '目录不能退化成空壳');
  // 外部 MCP（memory）的工具名必须能在桥接的工具面文案里找到，否则就是我们编的
  const consoleSrc = fs.readFileSync(new URL('../src/adapters/console-server.mjs', import.meta.url), 'utf8');
  for (const name of EXTERNAL_TOOLS) {
    assert.ok(consoleSrc.includes(name), `外部工具 ${name} 在 console-server 的工具面文案里不存在`);
  }
  // 直接常驻的辅助工具必须在 MCP 里真的注册了（registerTool('qq_me', ...)）。
  // DIRECT_TOOLS 可能随拆分迁到 mcp-reserved2-tools.js；源码契约需同时检索两个文件。
  const mcpSrc = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    + '\n' + fs.readFileSync(new URL('../src/mcp-reserved2-tools.js', import.meta.url), 'utf8');
  for (const name of DIRECT_TOOLS) {
    assert.ok(mcpSrc.includes(`'${name}'`), `直接常驻工具 ${name} 在 MCP 里没有注册`);
  }
  for (const entry of LOOKUP_ENTRIES) {
    assert.ok(entry.area && entry.call, `条目缺 area/call：${JSON.stringify(entry)}`);
    assert.ok(Array.isArray(entry.blocks) && entry.blocks.length, `${entry.area} 没有可匹配的块标题`);
    assert.ok(
      TOOL_CONFIG_FLAGS[toolOf(entry.call)] || EXTERNAL_TOOLS.includes(toolOf(entry.call)) || DIRECT_TOOLS.includes(toolOf(entry.call)),
      `目录指向不存在的工具：${entry.call}（tool-flags、外部工具、直接常驻清单里都没有 ${toolOf(entry.call)}）`,
    );
  }
});

test('lookupEntryFor：完全相等优先，包含匹配兜底，空/未知返回 null', () => {
  assert.equal(lookupEntryFor('你最近')?.area, '我自己的事（写过的/今天定的/干过的/认知/长期事实/挂着的）');
  assert.equal(lookupEntryFor('今天还没定')?.area, '我自己的事（写过的/今天定的/干过的/认知/长期事实/挂着的）');
  assert.equal(lookupEntryFor('可用表情包')?.area, '表情库');
  // 包含匹配：标题被前后缀包住时仍能定位到更具体的条目
  assert.equal(lookupEntryFor('【群聊黑话表（最近 30 条）】')?.area, '黑话/梗');
  assert.equal(lookupEntryFor(''), null);
  assert.equal(lookupEntryFor(null), null);
  assert.equal(lookupEntryFor('一个完全不在目录里的标题'), null);
});

test('lookupHintFor：命中给「完整版：工具」，未命中给空串（不造死入口）', () => {
  assert.equal(lookupHintFor('你今天给自己定的'), '（完整版：qq_me）');
  assert.equal(lookupHintFor('可用表情包'), '（完整版：qq_list_stickers）');
  assert.equal(lookupHintFor('无法映射的块'), '');
  assert.equal(lookupHintFor(''), '');
});

test('renderLookupCatalog：有表头、每行是「内容 → 工具」', () => {
  const text = renderLookupCatalog();
  assert.ok(text.startsWith('【能自己查】'), '缺表头，她会不知道这是工具索引');
  const lines = text.split('\n').slice(1);
  assert.ok(lines.length >= 5, `条目太少：${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^- .+ → [A-Za-z_][A-Za-z0-9_]*(\(.+\))?$/, `行格式不对：${line}`);
  }
});

test('renderLookupCatalog：私聊去掉纯群内容，群里保留', () => {
  const priv = renderLookupCatalog({ scene: 'private' });
  for (const area of ['群里谁在/群习惯', '黑话/梗', '群友档案/印象']) {
    assert.ok(!priv.includes(area), `私聊不该出现群入口：${area}`);
  }
  const group = renderLookupCatalog({ scene: 'group' });
  assert.ok(group.includes('黑话/梗'), '群里应该保留黑话入口');
});

test('renderLookupCatalog：maxChars 预算生效，默认不超过 CATALOG_MAX_CHARS', () => {
  assert.ok(renderLookupCatalog().length <= CATALOG_MAX_CHARS, '默认目录超预算');
  const tight = renderLookupCatalog({ maxChars: 80 });
  assert.ok(tight.length <= 80, `预算没兜住：${tight.length}`);
  assert.ok(tight.split('\n').length <= 3, '预算很紧时不该继续堆条目');
  const tiny = renderLookupCatalog({ maxChars: 10 });
  assert.equal(tiny.split('\n').length, 1, '预算小于表头时只留表头');
  assert.ok(tiny.startsWith('【能自己查】'));
});

// ── 与预算模块的咬合：截断/丢块时必须留下"去哪儿查"，否则丢了就是真丢了 ─────
test('compactInjection：截断处挂追回入口，不传 hintFor 时保持旧行为', () => {
  const text = `【你最近】\n${'我自己写的话。'.repeat(40)}\n`;
  const plain = compactInjection(text, { caps: { 你最近: 60 }, mergeGroups: [] });
  assert.ok(plain.trimmed.includes('你最近'));
  assert.ok(!plain.text.includes('完整版'), '不传 hintFor 不应出现指针');

  const hinted = compactInjection(text, { caps: { 你最近: 60 }, mergeGroups: [], hintFor: lookupHintFor });
  assert.match(hinted.text, /…（完整版：qq_me/);
  assert.ok(hinted.text.length < text.length, '挂了指针也仍应比原文短');
});

test('enforceInjectionBudget：丢块时放得下就留一行追回指针', () => {
  const text = [
    '【当前角色】人设不能丢',
    '【群聊黑话表】' + '黑'.repeat(120),
    '【收尾】必须留',
  ].join('\n');
  const budget = text.length - 60;
  const tight = enforceInjectionBudget(text, budget, { placeholderFor: lookupHintFor });
  assert.ok(tight.dropped.includes('群聊黑话表'));
  assert.ok((tight.placeholders ?? []).includes('群聊黑话表'));
  assert.match(tight.text, /【群聊黑话表】（完整版：qq_slang_query）/);
  assert.ok(tight.text.length <= budget, '指针不能把预算撑破');

  const plain = enforceInjectionBudget(text, budget);
  assert.ok(!plain.text.includes('群聊黑话表'));
  assert.deepEqual(plain.placeholders ?? [], []);
});

test('enforceInjectionBudget：预算极紧时指针让位，不撑破上限', () => {
  const text = [
    '【当前角色】人设不能丢',
    '【群聊黑话表】' + '黑'.repeat(200),
    '【收尾】必须留',
  ].join('\n');
  const r = enforceInjectionBudget(text, 40, { placeholderFor: lookupHintFor });
  assert.ok(r.text.length <= 40, `结果 ${r.text.length} 字，超上限`);
  assert.ok(!r.text.includes('【群聊黑话表】（完整版'), '放不下时不该硬留指针');
});
