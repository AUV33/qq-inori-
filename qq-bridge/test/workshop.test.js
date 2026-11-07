// test: 工坊沙箱全量行为验证（node test/workshop.test.js）
import { runScript, listWorkshop, readWorkshop } from '../src/domain/leaves/inori-workshop.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail); }
}

// 纯计算 + 顶层 return
let r = await runScript('print([1,2,3].map(x=>x*x)); return 10*6;');
check('纯计算+return', r.ok && r.output.includes('4') && r.result === '60', JSON.stringify(r));

// 工坊文件 API（含中文、换行）
r = await runScript(`
  const w = safeWrite('game1.md', '## 我的小游戏\\n规则：石头剪刀布');
  print(w.ok);
  const l = safeList();
  print(l.map(x=>x.name).join(','));
  return 0;
`);
check('工坊文件读写', r.ok && r.output.includes('true'), JSON.stringify(r));

// 越界读/写
r = await runScript('print(safeRead("../state/curiosity.json").error); return 0;');
check('越界读被挡', r.ok && r.output.includes('越界'), r.output);
r = await runScript('print(safeWrite("../../qq.json","z").error); return 0;');
check('越界写被挡', r.ok && r.output.includes('越界'), r.output);

// require 不可用
r = await runScript('try { require("node:fs"); } catch(e) { print("blocked:" + e.message.slice(0,30)); } return 0;');
check('require 被挡', r.output.includes('blocked'), r.output);

// 网络不可见
r = await runScript('print(typeof fetch, typeof process); return 0;');
check('fetch/process 不可见', r.output.includes('undefined undefined'), r.output);

// 死循环超时（worker 内 vm timeout 2s + 主看门狗兜底 4s）
const t0 = Date.now();
r = await runScript('let i=0; while(true){i++;} ', { timeoutMs: 2000 });
const elapsed = Date.now() - t0;
check('死循环超时打断', !r.ok && /超时/.test(r.error) && elapsed < 6000, JSON.stringify({ err: r.error, ms: elapsed }));

// async/await 可用
r = await runScript('await new Promise(res=>setTimeout(res,50)); print("done async"); return 42;');
check('async await', r.ok && r.output.includes('done async') && r.result === '42', JSON.stringify(r));

// 输出截断
r = await runScript('for (let i=0;i<50;i++){ print("xxxxxxxxxx"); } return 0;', { outputCap: 200 });
check('输出截断', r.truncated && r.output.length <= 200 + 100, String(r.output.length));

// 持久化验证（工坊文件真的写进目录）
const r4 = await runScript('return safeList().map(x=>x.name);');
check('工坊持久', (r4.result ?? '').includes('game1'), JSON.stringify(r4.result));

console.log(`\nworkshop.test: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
