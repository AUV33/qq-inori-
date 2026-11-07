// 抽离后遗症回归：黑话库落盘必须走注入的 getter（曾经直接读 app.mjs 的闭包变量 → 每次保存都 ReferenceError，
// 学到的词条重启就丢）。这条测试钉住"可写/只读"两条路径的真实行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlangStore } from '../src/domain/social/slang-store-service.mjs';

function makeCtx(overrides = {}) {
  const logs = [];
  const actions = [];
  const state = { entries: [{ content: '绷不住', status: 'confirmed' }], writable: true, saved: [] };
  const ctx = {
    log: (...args) => logs.push(args.join(' ')),
    logAction: (row) => actions.push(row),
    saveSlang: (file, entries) => {
      state.saved.push({ file, entries });
      return { staled: 0, dropped: 0, entries };
    },
    SLANG_FILE: 'slang.json',
    SLANG_MAX_ENTRIES: 500,
    getSlangEntries: () => state.entries,
    setSlangEntries: (v) => { state.entries = v; },
    getSlangStoreWritable: () => state.writable,
    ...overrides,
  };
  return { svc: createSlangStore(ctx), state, logs, actions };
}

test('可写时落盘，并把当前词条交给 saveSlang', () => {
  const h = makeCtx();
  h.svc.saveSlangStore();
  assert.equal(h.state.saved.length, 1);
  assert.equal(h.state.saved[0].file, 'slang.json');
  assert.equal(h.state.saved[0].entries.length, 1);
});

test('只读降级时一个字都不写（启动时加载失败不能覆盖磁盘）', () => {
  const h = makeCtx();
  h.state.writable = false;
  h.svc.saveSlangStore();
  assert.equal(h.state.saved.length, 0, '只读状态下绝不能落盘');
  assert.ok(h.logs.some((l) => l.includes('只读降级')), '要留下只读提示');
});

test('清理僵尸候选 / 超上限丢弃都要记账（日志+账本双写）', () => {
  const h = makeCtx({
    saveSlang: () => ({ staled: 3, dropped: 2, entries: [{ content: 'a' }] }),
  });
  h.state.entries = [{ content: 'a' }, { content: 'b' }, { content: 'c' }];
  h.svc.saveSlangStore();
  assert.ok(h.logs.some((l) => l.includes('清理僵尸候选 3 条')));
  assert.ok(h.logs.some((l) => l.includes('丢弃 2 条')));
  assert.equal(h.actions.length, 1, '清尸要进 action-log');
  assert.equal(h.actions[0].action, 'prune');
  assert.equal(h.state.entries.length, 1, '丢弃后的结果要回写到内存词条');
});

test('saveSlang 抛错只记日志，不把异常甩给调用方', () => {
  const h = makeCtx({ saveSlang: () => { throw new Error('磁盘满'); } });
  assert.doesNotThrow(() => h.svc.saveSlangStore());
  assert.ok(h.logs.some((l) => l.includes('保存黑话库失败')));
});
