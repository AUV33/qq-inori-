// inori-phone-availability 金标：「手机能不能用」的运行时事实——查不清就是 unknown，绝不把故障当"手机不在"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_TTL_MS, selectAdb, parseDevices, probePhone, createPhoneProbe, renderPhoneLine,
} from '../src/domain/leaves/inori-phone-availability.js';

test('selectAdb：按 cfg.phone → socialV2.phone → env → 默认 的优先级取存在的路径', () => {
  const exists = (p) => ['/cfg-adb', '/social-adb', '/env-adb', '/default-adb'].includes(p);
  assert.equal(selectAdb({ phone: { adb: '/cfg-adb' }, socialV2: { phone: { adb: '/social-adb' } } }, { exists, env: { PHONE_ADB: '/env-adb' } }), '/cfg-adb');
  assert.equal(selectAdb({ socialV2: { phone: { adb: '/social-adb' } } }, { exists, env: { PHONE_ADB: '/env-adb' } }), '/social-adb');
  assert.equal(selectAdb({}, { exists, env: { PHONE_ADB: '/env-adb' } }), '/env-adb');
  assert.equal(selectAdb({}, { exists: () => false, env: {} }), '', '都不存在就返回空串');
});

test('parseDevices：只数 device/offline/unauthorized，跳过表头与 banner', () => {
  const out = `* daemon started\nList of devices attached\nABC123\tdevice\nDEF456\toffline\nGHI789\tunauthorized\n\n`;
  assert.deepEqual(parseDevices(out), { device: 1, offline: 1, unauthorized: 1, total: 3 });
  assert.deepEqual(parseDevices(''), { device: 0, offline: 0, unauthorized: 0, total: 0 });
  assert.deepEqual(parseDevices(null), { device: 0, offline: 0, unauthorized: 0, total: 0 });
});

test('probePhone：没有 exec / 没有 adb 路径都返回 unknown（不瞎说"没设备"）', async () => {
  assert.deepEqual(await probePhone({ execFile: null }), { state: 'unknown', count: 0, reason: 'no-exec' });
  assert.deepEqual(await probePhone({ adbPath: '', execFile: () => {} }), { state: 'unknown', count: 0, reason: 'no-adb' });
});

test('probePhone：有设备 → available；offline/unauthorized/空列表 分别给不同 reason', async () => {
  const withOut = (stdout) => probePhone({ adbPath: '/adb', execFile: (p, a, o, cb) => cb(null, stdout) });
  assert.deepEqual(await withOut('List of devices attached\nX\tdevice\n'), { state: 'available', count: 1, reason: '' });
  assert.deepEqual(await withOut('X\toffline\n'), { state: 'unavailable', count: 0, reason: 'offline' });
  assert.deepEqual(await withOut('X\tunauthorized\n'), { state: 'unavailable', count: 0, reason: 'unauthorized' });
  assert.deepEqual(await withOut('List of devices attached\n'), { state: 'unavailable', count: 0, reason: 'no-device' });
});

test('probePhone：adb 报错/清空输出/抛异常 → unknown（故障不当"手机不在"）', async () => {
  const err = await probePhone({ adbPath: '/adb', execFile: (p, a, o, cb) => cb(new Error('boom'), '') });
  assert.deepEqual(err, { state: 'unknown', count: 0, reason: 'adb-error' });
  const thrown = await probePhone({ adbPath: '/adb', execFile: () => { throw new Error('ENOENT'); } });
  assert.equal(thrown.state, 'unknown');
});

test('createPhoneProbe：60 秒缓存内只探一次，过期后重新探；invalidate 立刻作废', async () => {
  let calls = 0;
  let t = 1_000_000;
  const probe = createPhoneProbe({
    adbPath: '/adb',
    now: () => t,
    execFile: (p, a, o, cb) => { calls += 1; cb(null, 'X\tdevice\n'); },
  });
  assert.equal((await probe.get()).state, 'available');
  assert.equal(calls, 1);
  assert.equal((await probe.get()).state, 'available');
  assert.equal(calls, 1, 'TTL 内命中缓存');
  t += DEVICE_TTL_MS + 1;
  await probe.get();
  assert.equal(calls, 2, '过期后重探');
  probe.invalidate();
  assert.equal(probe.peek(), null);
  await probe.get();
  assert.equal(calls, 3);
});

test('createPhoneProbe：并发只探一次（single-flight）', async () => {
  let calls = 0;
  const probe = createPhoneProbe({
    adbPath: '/adb',
    execFile: (p, a, o, cb) => { calls += 1; setTimeout(() => cb(null, 'X\tdevice\n'), 10); },
  });
  const [a, b, c] = await Promise.all([probe.get(), probe.get(), probe.get()]);
  assert.equal(calls, 1);
  assert.equal(a.state, 'available');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('renderPhoneLine：只有确定"没设备"才给话；三种原因措辞不同；available/unknown 返回 null', () => {
  assert.equal(renderPhoneLine({ state: 'available', count: 1 }), null);
  assert.equal(renderPhoneLine({ state: 'unknown', reason: 'adb-error' }), null);
  assert.equal(renderPhoneLine(null), null);

  const offline = renderPhoneLine({ state: 'unavailable', reason: 'offline' });
  assert.ok(offline.includes('设备显示 offline'));
  const unauth = renderPhoneLine({ state: 'unavailable', reason: 'unauthorized' });
  assert.ok(unauth.includes('没授权'));
  const none = renderPhoneLine({ state: 'unavailable', reason: 'no-device' });
  assert.ok(none.includes('没有已连接的设备'));
  for (const line of [offline, unauth, none]) {
    assert.ok(line.includes('先放着'), '只给事实+许可，不指使她干什么');
    assert.ok(line.includes('别把时间花在手机上'));
    assert.ok(!/必须|立刻|马上/.test(line), '不指使她干什么');
  }
});
