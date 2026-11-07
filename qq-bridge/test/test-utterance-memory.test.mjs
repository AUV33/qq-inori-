// [UTTERANCE] 她说过的话进记忆库：可检索、默认不进召回池、不参与学习。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { poolForQuery, looksLikeSelfQuery, appendUtterance, pruneUtterances, loadEntries, UTTERANCE_KIND } from '../src/domain/memory/memory-retrieve.js';
import { buildQuoteContext } from '../src/domain/leaves/inori-quote-context.mjs';

const now = Date.parse('2026-10-30T19:10:00+08:00');

test('query 门控：普通问题不收她的发言，问「回的是哪」才收', () => {
  const rows = [
    { kind: 'fact', text: '主人下周一过生日' },
    { kind: UTTERANCE_KIND, text: '那你就别叫。' },
    { kind: 'group-digest', text: '今天群里聊了方舟' },
  ];
  const normal = poolForQuery(rows, '主人的生日是哪天').map((e) => e.kind);
  assert.deepEqual(normal, ['fact'], '普通问题：不含 utterance / digest');
  const selfQ = poolForQuery(rows, '你这一句回的是哪').map((e) => e.kind);
  assert.ok(selfQ.includes(UTTERANCE_KIND), '问自己说过的话时应收 utterance');
  assert.equal(looksLikeSelfQuery('你刚才那句是回谁'), true);
  assert.equal(looksLikeSelfQuery('今天天气怎么样'), false);
});

test('appendUtterance：写进对应 scope 的记忆文件，带前文 ctx', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utt-'));
  try {
    const ok = appendUtterance({
      dir, key: 'group:123456789', text: '那你就别叫。', at: now,
      ctx: [{ seq: 404, sender: '群友己', text: '被摸到规律了，一叫就冒头' }],
    });
    assert.equal(ok, true);
    const rows = loadEntries(path.join(dir, 'memory-group_123456789.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, UTTERANCE_KIND);
    assert.equal(rows[0].who, '我');
    assert.equal(rows[0].ctx[0].seq, 404);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pruneUtterances：14 天外与被挤出上限的旧发言清掉，其它行原样', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utt-prune-'));
  try {
    const file = path.join(dir, 'memory.jsonl');
    const rows = [
      { at: new Date(now - 30 * 86400000).toISOString(), kind: 'fact', text: '很久以前的事实' },
      { at: new Date(now - 20 * 86400000).toISOString(), kind: UTTERANCE_KIND, text: '太旧的发言', time: now - 20 * 86400000 },
      ...Array.from({ length: 5 }, (_, i) => ({ at: new Date(now - i * 1000).toISOString(), kind: UTTERANCE_KIND, text: `新发言${i}`, time: now - i * 1000 })),
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = pruneUtterances(dir, { maxAgeDays: 14, maxPerFile: 3, now });
    assert.equal(r.removed, 3, `应删 1 条过旧 + 2 条超上限，实际 ${r.removed}`);
    const left = loadEntries(file);
    assert.equal(left.filter((e) => e.kind === UTTERANCE_KIND).length, 3);
    assert.ok(left.some((e) => e.kind === 'fact'), 'fact 不能被抖掉');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('引用上下文：能从 utterance 账本答「这句是回哪条」，不依赖 recentMessages 窗口', () => {
  const quoteAt = now;
  const messages = [
    { isSelf: false, sender: '群友戊', seq: 410, time: quoteAt,
      text: '[引用 小满：那你就别叫。]你这一句回的是哪', quoteTargetIsSelf: true },
  ];
  const utterances = [{
    kind: UTTERANCE_KIND, text: '那你就别叫。', time: now - 40 * 60000,
    ctx: [{ seq: 404, sender: '群友己', text: '被摸到规律了，一叫就冒头，跟打地鼠似的' }],
  }];
  const block = buildQuoteContext(messages, { now: quoteAt, utterances });
  assert.ok(block.includes('有人引用了你那条「那你就别叫。」'), block);
  assert.ok(block.includes('seq404'), block);
  // 没有账本、窗口里也没有她的原话 → 不出块（不编）
  assert.equal(buildQuoteContext(messages, { now: quoteAt, utterances: [] }), '');
});
