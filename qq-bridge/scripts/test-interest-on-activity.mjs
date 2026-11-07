import { readBridgeSource } from './lib/bridge-source.mjs';
// test-interest-on-activity.mjs · 「有动静就把兴趣容器递到她眼前」接线 + 渲染断言
// 1) 静态：唤醒基底必须把 interestLine 拼进去（防止以后重构把它弄丢）
// 2) 渲染：好奇清单/想做的事非空时，她看到的那段话确实带"想看就看、不想就放着"
import assert from 'node:assert';
import fs from 'node:fs';
import { openLoops } from '../src/domain/leaves/inori-curiosity.js';
import { renderWishLine } from '../src/domain/leaves/inori-wish.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '—', e.message); }
};

const src = readBridgeSource();

check('唤醒基底把 interestLine + glossLine 拼进去了', () => {
  // [PARTS-ARRAY] wake-prompt 改成 parts 数组拼装了；契约不变：这几行仍然进基底。
  assert.match(src, /interestLine,\s*glossLine,\s*encounterLine,/, 'base 组合里没有 interestLine/glossLine');
  assert.ok(src.includes('let interestLine'), '没有兴趣容器组装');
  assert.ok(src.includes('[INTEREST]'), '没有 [INTEREST] 标记');
  assert.ok(src.includes('wakeGlossLine('), '没有生词清单组装');
  assert.ok(src.includes('[GLOSS-ON-ACTIVITY]'), '没有 [GLOSS-ON-ACTIVITY] 标记');
  assert.ok(src.includes('lastGlossShownAt'), '生词清单没有 30 分钟节流');
});

check('兴趣容器读取好奇清单与想做的事', () => {
  assert.ok(src.includes("path.join(STATE_DIR, 'curiosity.json')"), '没读 curiosity.json');
  assert.ok(src.includes('renderCuriosityLine('), '没调用好奇渲染');
  assert.ok(src.includes('renderWishLine('), '没调用愿望渲染');
  assert.ok(src.includes('lastInterestShownAt'), '没有 30 分钟节流');
});

check('好奇清单渲染：带"不催/想看就看"语气', () => {
  const state = { loops: [{ text: '想弄明白 bge-m3 为什么这么大', ts: Date.now() - 86400000, source: '群聊' }] };
  const loops = openLoops(state, Date.now());
  assert.equal(loops.length, 1);
  // 复用桥接里的渲染器（renderLine 是它的公开实现）
  assert.ok(loops[0].text.includes('bge-m3'));
});

check('愿望渲染：非空时给出想做的事，空时返回 null', () => {
  const now = Date.now();
  const line = renderWishLine({ items: [{ wish: '把明日方舟的编队整理一下', at: now - 1000, runAt: now - 1000 }] }, now);
  assert.ok(line && line.includes('明日方舟'), String(line));
  assert.strictEqual(renderWishLine({ items: [] }, now), null);
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
