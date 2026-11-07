import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuBusyPercent, cpuSnapshot, createResourceGate, kindOfLabel } from '../src/domain/memory/resource-gate.js';

const cpuAt = (idle, user, sys = 0) => [{ times: { idle, user, sys, nice: 0, irq: 0 } }];

test('kindOfLabel：isolated:slang → slang；任务/会话 label 也归到 kind', () => {
  assert.equal(kindOfLabel('isolated:slang'), 'slang');
  assert.equal(kindOfLabel('isolated:intake'), 'intake');
  assert.equal(kindOfLabel('task:ab12cd34'), 'task');
  assert.equal(kindOfLabel('private:1'), 'private');
  assert.equal(kindOfLabel(''), '');
});

test('cpuSnapshot：把多核累计 times 加起来', () => {
  const snap = cpuSnapshot([{ times: { idle: 10, user: 5, sys: 2, nice: 1, irq: 1 } }, { times: { idle: 20, user: 5, sys: 2, nice: 0, irq: 1 } }]);
  assert.equal(snap.idle, 30);
  assert.equal(snap.total, 47); // (10+5+2+1+1)+(20+5+2+0+1)
});

test('cpuBusyPercent：两次快照差分；没差分/坏数据 → 0', () => {
  assert.equal(cpuBusyPercent({ idle: 100, total: 200 }, { idle: 200, total: 400 }), 50);
  assert.equal(cpuBusyPercent({ idle: 100, total: 200 }, { idle: 100, total: 200 }), 0);
  assert.equal(cpuBusyPercent(null, { idle: 1, total: 2 }), 0);
  assert.equal(cpuBusyPercent({ idle: 5, total: 5 }, { idle: 1, total: 2 }), 0);
});

function makeGate(over = {}) {
  const logs = [];
  let free = 4 * 1024 ** 3;         // 4 GB
  let cpus = () => cpuAt(1000, 100);
  const gate = createResourceGate({
    enabled: true,
    observeOnly: true,
    minFreeMemMB: 1536,
    maxCpuPercent: 80,
    lowKinds: ['intake', 'slang', 'groupfact'],
    log: (line) => logs.push(line),
    memFree: () => free,
    cpus: () => cpus(),
    setTimer: () => null,
    clearTimer: () => {},
    ...over,
  });
  return {
    gate,
    logs,
    setFree(gb) { free = gb * 1024 ** 3; },
    setCpus(next) { cpus = next; },
  };
}

test('资源门：资源充足时什么都不挡', () => {
  const { gate } = makeGate();
  assert.equal(gate.shouldHold({ label: 'isolated:slang', kind: 'background' }), false);
});

test('资源门：只对低优先级 kind 生效，chat/高优先级后台不受影响', () => {
  const { gate, setFree } = makeGate({ observeOnly: false });
  setFree(0.5); // 空闲 512MB < 1.5GB
  gate.sample();
  assert.equal(gate.shouldHold({ label: 'private:1', kind: 'chat' }), false);
  assert.equal(gate.shouldHold({ label: 'isolated:gate', kind: 'background' }), false);
  assert.equal(gate.shouldHold({ label: 'isolated:slang', kind: 'background' }), true);
});

test('资源门：observeOnly 只记不打', () => {
  const { gate, logs, setFree } = makeGate({ observeOnly: true });
  setFree(0.5);
  gate.sample();
  assert.equal(gate.shouldHold({ label: 'isolated:intake', kind: 'background' }), false);
  assert.ok(logs.some((l) => l.includes('观察模式')), logs.join('\n'));
});

test('资源门：CPU 超过阈值也算紧张（用两次采样差分）', () => {
  const { gate, setCpus } = makeGate({ observeOnly: false, memFree: () => 4 * 1024 ** 3 });
  // 第一次采样只有基线；第二次：idle +100，total +800（user+400、sys+300）→ 87.5% ≈ 88%
  setCpus(() => cpuAt(1100, 500, 300));
  gate.sample();
  assert.equal(gate.state().cpuPercent, 88);
  assert.equal(gate.shouldHold({ label: 'isolated:groupfact', kind: 'background' }), true);
});

test('资源门：读不到内存（0）时不判内存，避免误停', () => {
  const { gate } = makeGate({ observeOnly: false, memFree: () => 0 });
  gate.sample();
  assert.equal(gate.state().memLow, false);
  assert.equal(gate.shouldHold({ label: 'isolated:slang', kind: 'background' }), false);
});

test('资源门：enabled=false 时永不挡', () => {
  const { gate, setFree } = makeGate({ enabled: false, observeOnly: false });
  setFree(0.1);
  gate.sample();
  assert.equal(gate.shouldHold({ label: 'isolated:slang', kind: 'background' }), false);
});

test('资源门：state 暴露可配阈值，observeOnly 默认 true', () => {
  const { gate } = makeGate({ observeOnly: undefined });
  const s = gate.state();
  assert.equal(s.observeOnly, true);
  assert.equal(s.minFreeMemMB, 1536);
  assert.equal(s.maxCpuPercent, 80);
  assert.deepEqual(s.lowKinds, ['intake', 'slang', 'groupfact']);
});
