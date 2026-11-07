// rerank-on-demand 金标：在线就不动、不在线尝试拉起、120s 冷却内不重复、拉不起来也不抛错。
// 注意：测试里把 PATH 清空，确保**真的不会启动** python 子进程（否则会占内存/起服务）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const withFetch = (impl) => { globalThis.fetch = impl; return () => { globalThis.fetch = realFetch; }; };
const withoutPath = () => {
  const old = process.env.PATH;
  process.env.PATH = '';
  return () => { process.env.PATH = old; };
};

async function freshModule() {
  // 每次用查询串拿一个新实例，避免模块级 lastSpawn 冷却串测试
  return import(`../src/domain/memory/rerank-on-demand.js?t=${Date.now()}-${Math.random()}`);
}

test('服务在线 → 直接返回 true（不尝试拉起）', async () => {
  const mod = await freshModule();
  const restore = withFetch(async () => ({ ok: true }));
  const restorePath = withoutPath();
  try {
    let logged = false;
    assert.equal(await mod.ensureRerank(() => { logged = true; }), true);
    assert.equal(logged, false, '在线时不该有任何拉起日志');
  } finally { restorePath(); restore(); }
});

test('服务不在线 → 走拉起分支并记日志（PATH 已清空，实际不会启进程）', async () => {
  const mod = await freshModule();
  const restore = withFetch(async () => { throw new Error('ECONNREFUSED'); });
  const restorePath = withoutPath();
  try {
    const logs = [];
    const ok = await mod.ensureRerank((m) => logs.push(m));
    assert.equal(ok, true, '已发出拉起动作（不代表已就绪）');
    assert.ok(logs.some((l) => l.includes('不在线') || l.includes('拉起失败')));
  } finally { restorePath(); restore(); }
});

test('120 秒冷却内不重复拉起', async () => {
  const mod = await freshModule();
  const restore = withFetch(async () => { throw new Error('down'); });
  const restorePath = withoutPath();
  try {
    await mod.ensureRerank();
    assert.equal(await mod.ensureRerank(), false, '第二次必须被冷却挡住');
  } finally { restorePath(); restore(); }
});

test('拉不起来也不抛错（不能因为重排起不来就拖垮这一轮）', async () => {
  const mod = await freshModule();
  const restore = withFetch(async () => { throw new Error('down'); });
  const restorePath = withoutPath();
  try {
    await assert.doesNotReject(async () => mod.ensureRerank());
  } finally { restorePath(); restore(); }
});
