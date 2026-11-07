import { readBridgeSource } from './lib/bridge-source.mjs';
// test-interest-encounter.mjs · 「遇到」驱动的兴趣/好奇：未知→好奇、喜欢→感兴趣
// 纯模块断言 + 桥接接线锁（防止以后重构把它弄丢）
import assert from 'node:assert';
import fs from 'node:fs';
import { detectLikes, recordEncounter, openEncounters, renderEncounterLine } from '../src/domain/leaves/inori-interest.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
};

check('她说到喜欢 → 能识别出片段', () => {
  const hit = detectLikes('这个好可爱啊，想要');
  assert.ok(hit && hit.phrase, '应识别出喜欢');
  assert.ok(hit.snippet.includes('好可爱'), String(hit.snippet));
});

check('普通陈述不算喜欢', () => {
  assert.strictEqual(detectLikes('今天上班'), null);
  assert.strictEqual(detectLikes(''), null);
});

check('遇到不认识的东西 → 记成 unknown 事实', () => {
  let s = { items: [] };
  s = recordEncounter(s, { kind: 'unknown', what: '乐子人', src: '群聊' }, Date.now());
  assert.strictEqual(s.items.length, 1);
  assert.strictEqual(s.items[0].kind, 'unknown');
});

check('重复遇到只刷新时间、不加条目', () => {
  const t = Date.now();
  let s = { items: [] };
  s = recordEncounter(s, { kind: 'unknown', what: '乐子人', src: '群聊' }, t - 1000);
  s = recordEncounter(s, { kind: 'unknown', what: '乐子人', src: '群聊' }, t);
  assert.strictEqual(s.items.length, 1);
  assert.strictEqual(s.items[0].at, t);
});

check('24h 外的旧遇到不再渲染', () => {
  const t = Date.now();
  let s = { items: [] };
  s = recordEncounter(s, { kind: 'like', what: '好可爱', src: 'private' }, t - 2 * 24 * 3600000);
  s = recordEncounter(s, { kind: 'unknown', what: '乐子人', src: '群聊' }, t);
  const open = openEncounters(s, t);
  assert.strictEqual(open.like.length, 0, '旧 like 应过期');
  assert.strictEqual(open.unknown.length, 1);
});

check('渲染：两类都带许可，空则 null', () => {
  const t = Date.now();
  let s = { items: [] };
  s = recordEncounter(s, { kind: 'unknown', what: '乐子人', src: '群聊' }, t);
  s = recordEncounter(s, { kind: 'like', what: '好可爱', src: 'private' }, t);
  const line = renderEncounterLine(s, t);
  assert.ok(line.includes('乐子人') && line.includes('好可爱'), String(line));
  assert.ok(line.includes('心里痒就看') || line.includes('心里痒就去弄明白'), String(line));
  assert.strictEqual(renderEncounterLine({ items: [] }, t), null);
});

check('桥接接线：导入 + 两个记录点 + 唤醒注入', () => {
  const src = readBridgeSource();
  assert.ok(src.includes("from './inori-interest.js'"), '没有导入 inori-interest');
  assert.ok(src.includes('wakeEncounterLine('), '没有唤醒注入 helper');
  assert.ok(src.includes('recordEncounter(enc, { kind: \'like\''), '没有"喜欢"记录点');
  assert.ok(src.includes('recordEncounter(enc, { kind: \'unknown\''), '没有"未知"记录点');
  // [PARTS-ARRAY] wake-prompt 改成 parts 数组拼装了；契约不变：这几行仍然进基底。
  assert.match(src, /interestLine,\s*glossLine,\s*encounterLine,/, '基底没拼 interest/gloss/encounterLine');
  assert.match(src, /encounterLine,\s*\n?\s*failureLine,/, 'encounterLine 后面没接 failureLine');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
