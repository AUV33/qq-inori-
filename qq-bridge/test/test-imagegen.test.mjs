// inori-imagegen.js 的纯函数与生命周期边界（不拉真模型、不占显存）。
// 判据只落在「能不能判」的部分：提示词校验、内存体检、空闲关闭、串行队列。
// 真出图要靠 tools/sd-vulkan 与服务实测，不在这里假装。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { IMAGEGEN_DEFAULTS, createImageGen, freeMemMB, normalizePrompt, parseActualSeed } from '../src/domain/leaves/inori-imagegen.js';

test('从 A1111 兼容响应里挖真实种子（-1 只是回显，不能当种子用）', () => {
  const withInfo = { info: JSON.stringify({ all_seeds: [29312], generation_info: [{ sample_params: { seed: 5 } }] }) };
  assert.equal(parseActualSeed(withInfo), 29312);
  // info 已经是对象时同样要能取
  assert.equal(parseActualSeed({ info: { all_seeds: [7] } }), 7);
  // 退化情况：没有 info / 坏 JSON / 负数 → null
  assert.equal(parseActualSeed({}), null);
  assert.equal(parseActualSeed({ info: 'not json' }), null);
  assert.equal(parseActualSeed({ info: JSON.stringify({ all_seeds: [-1] }) }), null);
});

test('提示词校验：中文被挡回，英文标签放行', () => {
  const cn = normalizePrompt('一个女孩在雨里');
  assert.equal(cn.ok, false);
  assert.match(cn.reason, /英文 danbooru 标签/);

  const empty = normalizePrompt('   ');
  assert.equal(empty.ok, false);

  const long = normalizePrompt('a, '.repeat(500));
  assert.equal(long.ok, false);

  const ok = normalizePrompt(' 1girl, white dress, night sky ');
  assert.equal(ok.ok, true);
  assert.equal(ok.prompt, '1girl, white dress, night sky');
});

test('默认配置里「按需拉起」的关键参数有值且在合理区间', () => {
  assert.equal(IMAGEGEN_DEFAULTS.enabled, true);
  assert.ok(IMAGEGEN_DEFAULTS.port > 1024 && IMAGEGEN_DEFAULTS.port < 65535);
  assert.ok(IMAGEGEN_DEFAULTS.idleMs >= 60000, '空闲关闭不能短于 1 分钟，否则来回重启');
  assert.ok(IMAGEGEN_DEFAULTS.minFreeMemMB >= 256, '内存门槛太低会把整机拖进交换区');
  assert.match(IMAGEGEN_DEFAULTS.modelPath, /\.gguf$/, '默认走量化模型；fp16 在 1.5GB 可用内存下起不来');
});

test('缺少二进制/模型时立刻报错，不去 spawn', async () => {
  const gen = createImageGen({
    rootDir: path.join(os.tmpdir(), 'no-such-root-inori'),
    cfg: { binPath: 'tools/nope/sd-server.exe', modelPath: 'tools/nope/model.gguf', minFreeMemMB: 0 },
    log: () => {}
  });
  await assert.rejects(() => gen.ensure(), /找不到 sd-server/);
});

test('内存不足时报错而不是硬拉（宁可不画）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  fs.writeFileSync(path.join(dir, 'fake-server.exe'), '');
  fs.writeFileSync(path.join(dir, 'fake-model.gguf'), '');
  const gen = createImageGen({
    rootDir: dir,
    cfg: {
      binPath: 'fake-server.exe',
      modelPath: 'fake-model.gguf',
      minFreeMemMB: 1024 * 1024 // 1TB：任何机器都不够
    },
    log: () => {}
  });
  await assert.rejects(() => gen.ensure(), /可用内存只剩/);
});

test('空闲关闭：idleMs 到点后不再认为自己还在跑（没进程时也幂等）', () => {
  const gen = createImageGen({ rootDir: os.tmpdir(), cfg: { idleMs: 60000 }, log: () => {} });
  assert.deepEqual(gen.stop(), { ok: true, stopped: false });
  assert.ok(freeMemMB() > 0);
});

test('状态查询不拉服务、只说实话', async () => {
  const gen = createImageGen({ rootDir: os.tmpdir(), cfg: { binPath: 'nope', modelPath: 'nope' }, log: () => {} });
  const st = await gen.status();
  assert.equal(st.running, false);
  assert.equal(st.healthy, false);
  assert.equal(st.binExists, false);
  assert.equal(st.modelExists, false);
});
