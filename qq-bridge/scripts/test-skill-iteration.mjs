// [SKILL-ITER] 技能迭代：只优化不淘汰、版本 history、archived 不删除、重复建议
import assert from 'node:assert/strict';
import { load, upsert, find, applyOutcome, suggestMerges, stats } from '../src/domain/leaves/inori-skills.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('✅ ' + name); }

function fresh() { return { version: 1, items: [] }; }

ok('新技能带 attempts/confidence/status/history', () => {
  const store = fresh();
  const { skill } = upsert(store, { name: '安装游戏', steps: ['a', 'b'], verify: '文件:/tmp/x' });
  assert.equal(skill.version, 1);
  assert.equal(skill.attempts, 0);
  assert.equal(skill.confidence, 0.5);
  assert.equal(skill.status, 'untested');
  assert.deepEqual(skill.hints, []);
  assert.deepEqual(skill.history, []);
  assert.equal(skill.archived, false);
});

ok('重写技能：version+1、旧步骤进 history、失败史保留', () => {
  const store = fresh();
  const { skill } = upsert(store, { name: '安装游戏', desc: 'old', steps: ['a', 'b'], verify: '文件:/tmp/x' });
  applyOutcome(store, skill.id, { ok: false, hint: '点安装没反应' });
  const r = upsert(store, { name: '安装游戏', desc: 'new', steps: ['c', 'd'], verify: '文件:/tmp/y' });
  assert.equal(r.skill.version, 2);
  assert.equal(r.skill.history.length, 1);
  assert.deepEqual(r.skill.history[0].steps, ['a', 'b']);
  assert.equal(r.skill.history[0].desc, 'old');
  assert.equal(r.skill.fail, 0); // 当前版本清零
  assert.equal(r.skill.lifetime.fail, 1); // 旧版失败留在 lifetime
  assert.equal(r.skill.hints[0], '点安装没反应');
  assert.equal(r.skill.degraded, false);
});

ok('失败 5 次且从未成功：degraded 且仍在库/可检索，不删除', () => {
  const store = fresh();
  const { skill } = upsert(store, { name: '方舟部署', steps: ['a'], tags: ['明日方舟'] });
  for (let i = 0; i < 5; i += 1) applyOutcome(store, skill.id, { ok: false, hint: `失败点${i}` });
  assert.equal(store.items.length, 1);
  assert.equal(skill.degraded, true);
  assert.equal(skill.retired, false);
  assert.equal(skill.status, 'degraded');
  assert.equal(skill.hints.length, 5);
  assert.ok(find(store, '明日方舟').length > 0, '降级技能仍可检索');
});

ok('不确定（ok=null）只记尝试，不算成功/失败', () => {
  const store = fresh();
  const { skill } = upsert(store, { name: 'X', steps: ['a'] });
  applyOutcome(store, skill.id, { ok: null, source: 'turn' });
  assert.equal(skill.attempts, 1);
  assert.equal(skill.success, 0);
  assert.equal(skill.fail, 0);
});

ok('超上限只 archived，不从数组删除', () => {
  const store = fresh();
  for (let i = 0; i < 200; i += 1) {
    upsert(store, { name: `技能${i}`, steps: ['x'], tags: ['批量'] });
  }
  assert.equal(store.items.length, 200);
  upsert(store, { name: '技能201', steps: ['x'], tags: ['批量'] });
  assert.equal(store.items.length, 201, '没有删除旧条目');
  assert.equal(store.items.filter((s) => s.archived).length, 1);
  assert.equal(find(store, '技能0').some((h) => h.skill.name === '技能0'), false, '归档后不再默认检索');
});

ok('相似技能只给合并建议，不自动合并', () => {
  const store = fresh();
  upsert(store, { name: '明日方舟拖拽部署干员', desc: '拖动干员到战场', steps: ['a'] });
  upsert(store, { name: '明日方舟拖拽部署干员（旧）', desc: '拖动干员到战场', steps: ['a'] });
  const merges = suggestMerges(store, 0.6);
  assert.equal(store.items.length, 2, '不自动合并');
  assert.ok(merges.length >= 1);
  assert.ok(merges[0].similarity >= 0.6);
});

ok('stats 区分 degraded/archived/proven', () => {
  const store = fresh();
  const { skill } = upsert(store, { name: 'S', steps: ['a'] });
  applyOutcome(store, skill.id, { ok: true });
  const st = stats(store);
  assert.equal(st.proven, 1);
  assert.equal(st.degraded, 0);
  assert.equal(st.archived, 0);
});

console.log(`\n技能迭代机制测试：${pass} 项通过`);
