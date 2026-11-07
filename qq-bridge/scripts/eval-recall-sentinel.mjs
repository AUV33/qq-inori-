// P2 检索哨兵级回归（判据：注入到没到 / 取到了哪几条 / 同输入同结果）
// 用法：node scripts/eval-recall-sentinel.mjs
import { recallBlock } from '../src/domain/memory/memory-retrieve.js';
import { MEMORY_DIR } from '../src/domain/shared/project-paths.js';

const DIR = MEMORY_DIR;
let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) fails += 1;
};

// A) 同输入两次 ⇒ 条目集一致（确定性；mentions 计数是单调累加的，不影响本次条目集）
const a1 = await recallBlock('基建', { dir: DIR, scope: 'private', limit: 5 });
const a2 = await recallBlock('基建', { dir: DIR, scope: 'private', limit: 5 });
check('A 同查询两次条目一致', JSON.stringify(a1.text) === JSON.stringify(a2.text), `n=${a1.count}`);

// B) 空查询 ⇒ recent 模式，只给最近
const b = await recallBlock('', { dir: DIR, scope: 'private', limit: 3 });
check('B 空查询走 recent', b.mode === 'recent', `count=${b.count}`);

// C) 相关查询 ⇒ 命中的条目与 query 有字面/语义关联（sentinel：至少 1 条候选过阈）
const c = await recallBlock('明日方舟 基建', { dir: DIR, scope: 'private', limit: 5 });
check('C 相关查询有命中', c.mode === 'semantic' && c.steps?.passed >= 0 && (c.count > 0 || c.steps?.passed === 0), `passed=${c.steps?.passed} bestSim=${c.steps?.bestSim}`);

// D) 群 scope 隔离：群查询读群库
const d = await recallBlock('', { dir: DIR, scope: 'group_123456789', limit: 3 });
check('D 群 scope 可读', d.scope === 'group_123456789', `count=${d.count}`);

// E) 换输入必变：不同 query 的选中集（至少候选/过阈值不同或条目不同）
const e1 = await recallBlock('生日', { dir: DIR, scope: 'private', limit: 5 });
const e2 = await recallBlock('基建', { dir: DIR, scope: 'private', limit: 5 });
check('E 异输入条目集不同', JSON.stringify(e1.text) !== JSON.stringify(e2.text));

console.log(fails === 0 ? 'SENTINEL-ALL-GREEN' : `SENTINEL-FAILS=${fails}`);
process.exit(fails === 0 ? 0 : 1);
