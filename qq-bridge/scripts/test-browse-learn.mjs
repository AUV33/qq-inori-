import assert from 'node:assert/strict';
import { extractTerms } from '../src/domain/leaves/inori-browse-learn.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('跨帖子多次出现的词被抽出', () => {
  const terms = extractTerms(['今天好烦啊，这个破游戏又卡了', '这游戏太肝了，不玩了不玩了'], { minFreq: 2 });
  assert.ok(terms.includes('游戏'));
  assert.ok(!terms.includes('不玩'), '含停用字的词应被过滤');
});

ok('已知词不重复抽', () => {
  const terms = extractTerms(['这游戏太肝了'], { known: new Set(['游戏']), minFreq: 1 });
  assert.ok(!terms.includes('游戏'));
});

ok('停用字/短碎片被过滤，长词优先', () => {
  const terms = extractTerms(['破防了破防了真的破防了'], { minFreq: 2, maxTerms: 3 });
  assert.ok(terms.includes('破防'));
  assert.ok(!terms.some((t) => t.length < 2));
});

ok('没有足够重复返回空', () => {
  assert.deepEqual(extractTerms(['随便一句话'], { minFreq: 2 }), []);
});

console.log(`🎉 逛帖学习测试通过（${passed} 项）`);
