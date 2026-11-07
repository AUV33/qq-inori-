// 生命周期实测：真把 sd-server 拉起来出图，再关掉、确认端口收回、再拉一次。
// 判据是机械的：端口通/不通、进程在/不在、图片字节数 > 0。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createImageGen } from '../src/domain/leaves/inori-imagegen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gen = createImageGen({
  rootDir: ROOT,
  cfg: { port: 8197, idleMs: 60000, minFreeMemMB: 400 },
  log: (m) => console.log('[log]', m)
});

const alive = async () => {
  try {
    const res = await fetch('http://127.0.0.1:8197/sdapi/v1/progress', { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
};

console.log('1) 初始状态：', JSON.stringify(await gen.status()));
assert.equal(await alive(), false, '一开始端口不该有人');

console.log('2) 冷启动出图…');
const t0 = Date.now();
const one = await gen.generate({ prompt: '1girl, black hair, school uniform, classroom, morning light', width: 512, height: 512, steps: 18, seed: 7 });
const coldMs = Date.now() - t0;
assert.ok(one.buffer.length > 1000, '图应该有内容');
fs.writeFileSync(path.join(os.tmpdir(), 'inori-imagegen-life.png'), one.buffer);
console.log(`   冷启动+出图 ${(coldMs / 1000).toFixed(1)}s，${(one.buffer.length / 1024).toFixed(0)}KB，seed=${one.seed}`);

console.log('3) 第二张（热）：');
const t1 = Date.now();
const two = await gen.generate({ prompt: '1boy, silver hair, school uniform, sunset, rooftop', width: 512, height: 512, steps: 18, seed: 11 });
const warmMs = Date.now() - t1;
console.log(`   热出图 ${(warmMs / 1000).toFixed(1)}s`);
assert.ok(two.buffer.length > 1000);

console.log('4) 中文提示词应被拒：');
await assert.rejects(() => gen.generate({ prompt: '一个女孩在雨里' }), /英文 danbooru/);

console.log('5) 关掉：');
const stop = gen.stop();
assert.equal(stop.stopped, true);
await new Promise((r) => setTimeout(r, 2500));
assert.equal(await alive(), false, '关掉后端口不该再应答');
console.log('   端口已收回');

console.log('6) 再拉一次（确认可以重复拉起）：');
const three = await gen.generate({ prompt: '1girl, cat ears, night city, neon lights', width: 512, height: 512, steps: 12, seed: 3 });
assert.ok(three.buffer.length > 1000);
gen.stop();
console.log('LIFECYCLE_OK');
process.exit(0);
