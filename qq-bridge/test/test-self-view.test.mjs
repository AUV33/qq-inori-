// self-view.js 单测：qq_me 的段定义与渲染（纯函数，不联网、不读盘）。
//
// 契约重点：每段必须有 id/label/请求方式/字数帽；渲染必须"截断可追回"（告诉用哪段单独取），
// 一段失败只标没取到，不影响其它段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ME_SECTIONS, ME_SECTION_IDS, sectionsFor, renderMeView } from '../src/domain/persona/self-view.js';

test('段定义：id 唯一、字段齐全、读取路径是函数', () => {
  assert.ok(ME_SECTIONS.length >= 5, '段太少：qq_me 应该覆盖自述/计划/行为/认知/事实');
  const ids = new Set();
  for (const s of ME_SECTIONS) {
    assert.match(s.id, /^[a-z]+$/, `id 不合法：${s.id}`);
    assert.ok(!ids.has(s.id), `id 重复：${s.id}`);
    ids.add(s.id);
    assert.ok(s.label && s.label.length >= 2, `${s.id} 缺 label`);
    assert.ok(['GET', 'POST'].includes(s.method), `${s.id} 的 method 不对`);
    assert.equal(typeof s.path, 'function', `${s.id} 的 path 必须是函数`);
    assert.ok(s.cap > 0, `${s.id} 缺字数帽`);
  }
  assert.deepEqual([...ME_SECTION_IDS], ME_SECTIONS.map((s) => s.id));
});

test('sectionsFor：all/缺省取全部，指定段只取一段，未知段返回空', () => {
  assert.equal(sectionsFor().length, ME_SECTIONS.length);
  assert.equal(sectionsFor('all').length, ME_SECTIONS.length);
  const one = sectionsFor('day');
  assert.equal(one.length, 1);
  assert.equal(one[0].id, 'day');
  assert.deepEqual(sectionsFor('nope'), []);
});

test('段的请求：path 带 key 且编码，body 带 key（只读动作）', () => {
  const byId = Object.fromEntries(ME_SECTIONS.map((s) => [s.id, s]));
  assert.match(byId.day.path('group:123'), /key=group%3A123/);
  assert.match(byId.cognition.path('private:9'), /key=private%3A9/);
  assert.equal(byId.plan.body('private:9').action, 'get');
  assert.equal(byId.curiosity.body('group:1').action, 'list');
});

test('renderMeView：段抬头齐全，长文按帽截断并给追回指引', () => {
  const long = '字'.repeat(900);
  const text = renderMeView([
    { id: 'self', label: '我写过的', cap: 100, text: long },
    { id: 'plan', label: '今天给自己定的', cap: 100, text: '三件事' },
  ]);
  assert.ok(text.startsWith('【我的状态】'));
  assert.match(text, /【我写过的】/);
  assert.match(text, /…（截了，用 section 单独取可看全）/);
  assert.match(text, /【今天给自己定的】\n三件事/);
});

test('renderMeView：一段失败只标没取到，不影响其它段', () => {
  const text = renderMeView([
    { id: 'facts', label: '关于他的长期事实', cap: 100, error: '记忆读取失败：403' },
    { id: 'self', label: '我写过的', cap: 100, text: '一句话' },
  ]);
  assert.match(text, /【关于他的长期事实】（没取到：记忆读取失败：403）/);
  assert.match(text, /【我写过的】\n一句话/);
});

test('renderMeView：总帽兜住，超了告诉她用哪段单独取', () => {
  const text = renderMeView([
    { id: 'self', label: 'A', cap: 100, text: '甲'.repeat(100) },
    { id: 'plan', label: 'B', cap: 100, text: '乙'.repeat(100) },
    { id: 'day', label: 'C', cap: 100, text: '丙'.repeat(100) },
  ], { maxChars: 260 });
  assert.ok(text.includes('后面还有'), '超帽时必须告诉她还有几段');
  assert.match(text, /section="<id>"/);
  assert.ok(!text.includes('丙'.repeat(100)), '超帽的段不应整段塞进来');
});
