// 记忆召回测试集：20 个「她应该答得上来」的问题，任何一条 top5 命中期望关键词即算过。
// 只测不改判据；用来证明「按需检索」真的能查回来。
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(path.join(here, '../src/memory-retrieve.js')).href);

const CASES = [
  { q: '主人的生日是哪天', scope: 'private', expect: ['生日', '10月26'] },
  { q: '主人喜欢什么', scope: 'private', expect: ['喜欢'] },
  { q: '我答应过他什么', scope: 'private', expect: ['答应', '说好', '承诺', '保证', '一定'] },
  { q: '明日方舟基建怎么排', scope: 'private', expect: ['基建', '贸易站', '制造站', '龙门币'] },
  { q: '他让我记的生日是哪天', scope: 'private', expect: ['生日'] },
  { q: '群1074最近在聊什么', scope: 'group_123456789', expect: ['群里在聊', '群像', '发言'] },
  { q: '群里有人吵架吗', scope: 'group_123456789', expect: ['吵', '骂', '生气', '冲突'] },
  { q: '群里有人说要踢人吗', scope: 'group_123456789', expect: ['踢', '禁言', '管理员'] },
  { q: '她说过别叫吗', scope: 'group_123456789', expect: ['别叫', '不叫'] },
  { q: '上下文重复输入输出这件事', scope: 'group_123456789', expect: ['上下文', '重复'] },
  { q: '群656 昨晚聊了什么', scope: 'group_123456789', expect: ['群里在聊', '群像', '发言', '晚安'] },
  { q: '主人被群里叫到要不要回', scope: 'group_123456789', expect: ['叫到', '艾特', '拍一拍', '要说'] },
  { q: '群里谁最爱发图', scope: 'group_123456789', expect: ['图', '群像', '发言'] },
  { q: '画世界是什么', scope: 'private', expect: ['画世界', '画'] },
  { q: '她最近看过什么视频', scope: 'private', expect: ['视频', 'B站', '看了'] },
  { q: '他生日那天说了什么', scope: 'private', expect: ['生日', '穷', '一百', '炒股'] },
  { q: '她最近改过自己什么', scope: 'private', expect: ['改', '重构', '修复', '进化'] },
  { q: '手机操作先做什么', scope: 'private', expect: ['dump', '截图', '坐标', '手机'] },
  { q: '记忆检索怎么做的', scope: 'private', expect: ['检索', '记忆', 'embed'] },
  { q: '管理员说小满不会在大群说话', scope: 'group_123456789', expect: ['小满', '大群', '说话'] },
];

const hitList = [];
for (const c of CASES) {
  const r = await m.recall(c.q, { scope: c.scope, limit: 5 });
  const texts = r.entries.map((e) => String(e.text ?? ''));
  const hitIdx = texts.findIndex((t) => c.expect.some((k) => t.includes(k)));
  hitList.push({ ...c, ok: hitIdx >= 0, rank: hitIdx >= 0 ? hitIdx + 1 : null, n: texts.length, mode: r.mode, top: texts[0]?.slice(0, 50) });
  console.log(`${hitIdx >= 0 ? '✅' : '❌'} [${c.scope}] ${c.q} → ${hitIdx >= 0 ? `top${hitIdx + 1}` : '未命中'}｜${texts[0]?.slice(0, 40) ?? ''}`);
}
const ok = hitList.filter((x) => x.ok).length;
console.log(`\n命中 ${ok}/${CASES.length}（${Math.round((ok / CASES.length) * 100)}%）`);
process.exit(ok >= 16 ? 0 : 1);
