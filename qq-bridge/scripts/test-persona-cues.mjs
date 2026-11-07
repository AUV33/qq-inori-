import assert from 'node:assert/strict';
import { detectPersonaCues, renderPersonaCue } from '../src/domain/leaves/inori-persona-cues.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('被夸 → praise', () => {
  assert.deepEqual(detectPersonaCues(['你好厉害啊']), ['praise']);
  assert.ok(renderPersonaCue(['你好厉害啊']).includes('夸'));
});

ok('被损/拱火 → tease', () => {
  assert.ok(detectPersonaCues(['就这？菜']).includes('tease'));
});

ok('求助 → help', () => {
  assert.ok(detectPersonaCues(['帮我看看这个']).includes('help'));
});

ok('普通闲聊不触发', () => {
  assert.deepEqual(detectPersonaCues(['今天天气不错']), []);
  assert.equal(renderPersonaCue(['今天天气不错']), null);
});

ok('最多两句，不刷屏', () => {
  const line = renderPersonaCue(['你好厉害', '就这？', '帮我查一下']);
  assert.ok(line);
  assert.ok(line.split('（').length - 1 <= 3);
});

console.log(`🎉 性格触发测试通过（${passed} 项）`);
