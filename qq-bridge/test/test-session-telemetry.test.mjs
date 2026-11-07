// session-telemetry 金标：模型记录、token 账本摄入、重连后「进行中回合」重建与幽灵回合自愈。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTelemetry } from '../src/domain/conversation/session-telemetry.mjs';

const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

function makeCtx(overrides = {}) {
  const out = { logs: [], ingested: [], baselines: [], snapshots: [], created: 0 };
  const collectors = new Map();
  const v2TurnStartAt = new Map();
  const svc = createSessionTelemetry({
    cfg: { dsh: { model: 'deepseek-flash', provider: 'deepseek-official' } },
    log: (...args) => out.logs.push(args.map(String).join(' ')),
    tokenLedger: {
      ingestEvent: (p) => out.ingested.push(p),
      ingestBaseline: (p) => out.baselines.push(p),
      ingestSnapshotRecords: (p) => out.snapshots.push(p),
    },
    createTurnCollector: () => {
      out.created += 1;
      const events = [];
      return {
        events,
        push(event) {
          events.push(event);
          if (event.type === 'turn/end') return { reason: { kind: 'completed' }, text: '回复文本' };
          return null;
        },
      };
    },
    collectors,
    v2TurnStartAt,
    // unwrap 要的是 DSH 信封：{result:{ok,value}}
    api: { sessions: { list: async () => ({ result: { ok: true, value: overrides.runningList ?? [] } }) } },
    ...overrides.ctxExtra,
  });
  return { svc, out, collectors, v2TurnStartAt };
}

const start = (turn) => ({ type: 'turn/start', data: { turn } });
const end = (turn) => ({ type: 'turn/end', data: { turn } });
const msg = (turn, text) => ({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });

test('rememberModel / forgetSession：只认非空 model，getMap 可查', () => {
  const h = makeCtx();
  h.svc.rememberModel('s1', { model: 'deepseek-flash', provider: 'p' });
  assert.deepEqual(h.svc.getMap().get('s1'), { model: 'deepseek-flash', provider: 'p' });
  h.svc.rememberModel('s1', { model: '' });
  assert.equal(h.svc.getMap().get('s1').model, 'deepseek-flash', '空 model 不覆盖');
  h.svc.forgetSession('s1');
  assert.equal(h.svc.getMap().has('s1'), false);
});

test('recordSessionUsage：model/selection 事件会更新模型，并把 model/provider 带进账本', () => {
  const h = makeCtx();
  h.svc.recordSessionUsage('s1', { type: 'model/selection', data: { model: 'deepseek-pro', provider: 'p2' } });
  assert.equal(h.svc.getMap().get('s1').model, 'deepseek-pro');
  h.svc.recordSessionUsage('s1', { type: 'assistant/message', data: { usage: { model: 'from-usage' } } });
  assert.equal(h.out.ingested.length, 2);
  assert.equal(h.out.ingested[1].model, 'from-usage', '事件自带的 model 优先');
  assert.equal(h.out.ingested[1].provider, 'p2', 'provider 回落到已知值');
});

test('recordSessionUsage：账本抛错只记日志，不影响 QQ 主链', () => {
  const h = makeCtx({ ctxExtra: { tokenLedger: { ingestEvent: () => { throw new Error('账本坏了'); } } } });
  assert.doesNotThrow(() => h.svc.recordSessionUsage('s1', { type: 'x' }));
  assert.ok(h.out.logs.some((l) => l.includes('token 账本：摄入事件失败')));
});

test('recordSessionSnapshot：写入 baseline 与逐轮记录，并用 nominalModel 兜底', () => {
  const h = makeCtx();
  h.svc.recordSessionSnapshot('s1', {
    projections: { values: { modelSelection: { lastUsed: { model: 'm1', provider: 'p1' } } } },
    records: [],
  });
  assert.equal(h.svc.getMap().get('s1').model, 'm1');
  assert.equal(h.out.baselines.length, 1);
  assert.equal(h.out.baselines[0].model, 'm1');
  assert.equal(h.out.snapshots.length, 1);

  const bare = makeCtx();
  bare.svc.recordSessionSnapshot('s2', { projections: {}, records: [] });
  assert.equal(bare.out.baselines[0].model, 'deepseek-flash', '没有选择记录时用 cfg.dsh.model');
});

test('recordSessionSnapshot：空快照直接返回；抛错只记日志', () => {
  const h = makeCtx();
  h.svc.recordSessionSnapshot('s1', null);
  assert.equal(h.out.baselines.length, 0);

  const bad = makeCtx({ ctxExtra: { tokenLedger: { ingestBaseline: () => { throw new Error('坏'); } } } });
  assert.doesNotThrow(() => bad.svc.recordSessionSnapshot('s1', { projections: {}, records: [] }));
  assert.ok(bad.out.logs.some((l) => l.includes('处理会话快照失败')));
});

test('rebuildInFlightCollector：只重放「有 start 没 end」的回合（断线时仍在跑的那个）', () => {
  const h = makeCtx();
  h.svc.rebuildInFlightCollector('s1', [
    { type: 'event', event: start(1) },
    { type: 'event', event: msg(1, '已结束的回合不应重放') },
    { type: 'event', event: end(1) },
    { type: 'event', event: start(2) },
    { type: 'event', event: msg(2, '进行中的回合') },
  ]);
  const collector = h.collectors.get('s1');
  assert.ok(collector, '要为进行中的回合装回 collector');
  assert.deepEqual(collector.events.map((e) => e.type), ['turn/start', 'assistant/message']);
  assert.ok(h.out.logs.some((l) => l.includes('重连后恢复了进行中的回合')));
});

test('rebuildInFlightCollector：没有进行中回合/没有记录 → 不创建 collector', () => {
  const h = makeCtx();
  h.svc.rebuildInFlightCollector('s1', [{ type: 'event', event: start(1) }, { type: 'event', event: end(1) }]);
  assert.equal(h.collectors.has('s1'), false);
  h.svc.rebuildInFlightCollector('s2', []);
  assert.equal(h.collectors.has('s2'), false);
  assert.equal(h.out.created, 0);
});

test('幽灵回合自愈：20 秒后 DSH 报 running=false 就立刻解除 busy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx({ runningList: [{ sessionId: 's1', running: false }] });
  h.v2TurnStartAt.set('s1', 123);
  h.svc.rebuildInFlightCollector('s1', [{ type: 'event', event: start(7) }]);
  const collector = h.collectors.get('s1');
  assert.ok(collector);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(h.collectors.has('s1'), false, '要解除 busy');
  assert.equal(h.v2TurnStartAt.has('s1'), false);
  assert.ok(h.out.logs.some((l) => l.includes('running=false')));
});

test('幽灵回合兜底：2 分钟看门狗也会解除（DSH 查询失败时）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx({ ctxExtra: { api: { sessions: { list: async () => { throw new Error('查不到'); } } } } });
  h.svc.rebuildInFlightCollector('s1', [{ type: 'event', event: start(7) }]);
  assert.ok(h.collectors.has('s1'));
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(h.collectors.has('s1'), false);
  assert.ok(h.out.logs.some((l) => l.includes('没有结束，已解除 busy')));
});

test('自愈只动「当初那个 collector」：期间换成新 collector 就不许删', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeCtx({ runningList: [{ sessionId: 's1', running: false }] });
  h.svc.rebuildInFlightCollector('s1', [{ type: 'event', event: start(7) }]);
  const fresh = { push: () => null, events: [] };
  h.collectors.set('s1', fresh); // 期间来了一个新回合
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(h.collectors.get('s1'), fresh, '新回合不能被幽灵清理误删');
});

test('rebuildInFlightCollector：恢复回合时通知调度器（避免槽位 60s 误回收）', () => {
  const recovered = [];
  const h = makeCtx({ ctxExtra: { onTurnRecovered: (sid) => recovered.push(sid) } });
  h.svc.rebuildInFlightCollector('s1', [{ type: 'event', event: start(1) }, { type: 'event', event: msg(1, '半句') }]);
  assert.deepEqual(recovered, ['s1']);
  const h2 = makeCtx({ ctxExtra: { onTurnRecovered: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => h2.svc.rebuildInFlightCollector('s2', []), '通知失败不影响恢复');
});
