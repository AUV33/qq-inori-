// 经验系统：上下文挑选 / 投票 / 去重 / 触发词推断 自检（2026-10-26）
import assert from 'node:assert/strict';
import { selectForContext, vote, add, inferTrigger } from '../src/domain/leaves/inori-lessons.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

function mk(text, confidence = 0.7, hits = 0) {
  return { id: 'l' + text.slice(0, 2), text, kind: 'about-me', at: new Date().toISOString(), usedAt: new Date().toISOString(), hits, confidence, up: 0, down: 0, trigger: '' };
}

ok('上下文相关时优先挑相关经验', () => {
  const list = [
    mk('他一说累我先别急着给建议', 0.9, 5),
    mk('手机黑屏先看 adb 设备列表', 0.5, 0),
    mk('他打三角洲时别催他', 0.5, 0),
  ];
  const r = selectForContext(list, '今天一起打三角洲吗');
  assert.equal(r.selected[0].text, '他打三角洲时别催他');
});

ok('没有相关命中时回退到置信度前 N', () => {
  const list = [mk('经验A', 0.9), mk('经验B', 0.5), mk('经验C', 0.4)];
  const r = selectForContext(list, '完全无关的上下文');
  assert.equal(r.selected[0].text, '经验A');
});

ok('空上下文按置信度排序', () => {
  const list = [mk('低', 0.3), mk('高', 0.95)];
  const r = selectForContext(list, '');
  assert.equal(r.selected[0].text, '高');
});

ok('up 加置信度 / down 减置信度', () => {
  const list = [mk('经验', 0.5)];
  const up = vote(list, list[0].id, 'up');
  assert.equal(up.entry.confidence, 0.65);
  const down = vote(list, list[0].id, 'down');
  assert.equal(down.entry.confidence, 0.4);
});

ok('置信度掉到阈值以下会被放下', () => {
  const list = [mk('经验', 0.3)];
  const r = vote(list, list[0].id, 'down'); // 0.3-0.25=0.05 <= 0.2 -> 删除
  assert.equal(r.removed, true);
  assert.equal(list.length, 0);
});

ok('新经验重复（高重叠）被拒', () => {
  const list = [];
  const a = add(list, '他一说累我先别急着给建议');
  assert.equal(a.ok, true);
  const b = add(list, '他一说累我先别急着给建议');
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'duplicate');
});

ok('inferTrigger：高频词成触发词（长词优先，不吐碎片）', () => {
  assert.equal(inferTrigger('今天一起打三角洲吗？三角洲新版本今天更新了'), '三角洲');
  assert.equal(inferTrigger('手机又黑屏了 黑屏之后我点了半天没反应'), '黑屏');
});

ok('inferTrigger：不够频繁就不硬造', () => {
  assert.equal(inferTrigger('随便一句话'), '');
  assert.equal(inferTrigger(''), '');
});

ok('同 kind 的近重复合并而不是新增', () => {
  const list = [];
  add(list, '他累的时候先别急着给建议');
  const r = add(list, '他累时先别急着给建议', { mergeNear: true });
  assert.equal(list.length, 1);
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);
  assert.ok(list[0].text.includes('他累'));
});

console.log(`🎉 经验系统测试通过（${passed} 项）`);
