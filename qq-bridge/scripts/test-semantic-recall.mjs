// test-semantic-recall.mjs · 语义+词面混合检索：对题优先、实体命中、查询窗口
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recall, buildRecallQuery, lexicalBoost } from '../src/domain/memory/memory-retrieve.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semrecall-'));
const rows = [
  { time: '2026-10-26 20:00', text: '他家的猫叫团子，挑食，只吃某个牌子的罐头', who: '他', theme: '猫' },
  { time: '2026-10-26 21:00', text: '他最近在赶一个项目，天天加班到很晚', who: '他', theme: '工作' },
  { time: '2026-10-26 22:00', text: '我在玩三角洲，卡在第三关过不去，有点烦', who: '我', theme: '游戏' },
  { time: '2026-10-26 23:00', text: '示例bot想私聊我但QQ限制发不出去，只能在群里说话', who: '示例bot', theme: '示例bot' },
  { time: '2026-10-27 01:00', text: '群里在聊新出的显卡价格，有人抢到了', kind: 'group-digest' },
];
fs.writeFileSync(path.join(dir, 'memory.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const badEmbed = 'http://127.0.0.1:1';

async function top(q, opts = {}) {
  const r = await recall(q, { dir, scope: 'private', limit: 3, minSim: 0.05, embedUrl: badEmbed, timeoutMs: 400, ...opts });
  return r.entries.map((e) => e.text);
}

(async () => {
  check('查询窗口：3 条，笑声/语气词被洗掉', () => {
    const q = buildRecallQuery(['哈哈哈哈', '团子今天又不吃罐头了', '它是不是挑食', '嗯嗯'], { maxLen: 160 });
    assert.ok(!/哈哈/.test(q), q);
    assert.ok(q.includes('团子'), q);
  });

  check('lexicalBoost：实体命中加分', () => {
    const a = lexicalBoost('示例bot最近怎么样了', rows[3]);
    const b = lexicalBoost('示例bot最近怎么样了', rows[1]);
    assert.ok(a > b, `${a} vs ${b}`);
  });

  const cat = await top('团子今天又不吃罐头了，是不是挑食');
  check('猫的话题 → 猫记忆排第一', () => {
    assert.ok(cat[0].includes('团子'), JSON.stringify(cat));
  });

  const work = await top('他项目又加班到几点啊');
  check('工作的话题 → 工作记忆排第一', () => {
    assert.ok(work[0].includes('项目'), JSON.stringify(work));
  });

  const game = await top('三角洲那关还是过不去');
  check('游戏的话题 → 游戏记忆排第一', () => {
    assert.ok(game[0].includes('三角洲'), JSON.stringify(game));
  });

  const pp = await top('示例bot还是发不出去消息吗');
  check('提到群友 → 该群友记忆排第一', () => {
    assert.ok(pp[0].includes('示例bot'), JSON.stringify(pp));
  });

  const noise = await top('团子今天又不吃罐头了');
  check('显卡群摘要不挤进猫话题前排', () => {
    assert.ok(!noise.slice(0, 2).some((x) => x.includes('显卡')), JSON.stringify(noise));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
