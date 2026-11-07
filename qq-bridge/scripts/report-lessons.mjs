// 经验效果日报（只读）：不自动改置信度，只把代理数据摊开给人看
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const STATE = `${PROJECT_ROOT}/data/state`;
const OUT = path.join(STATE, '..', 'reports');
fs.mkdirSync(OUT, { recursive: true });

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const lessons = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'lessons.jsonl'), 'utf8').split('\n').filter(Boolean).join(',').replace(/\}\,?\{/g, '},{')) || []; } catch { return []; } })();

const usage = readJsonl(path.join(STATE, 'lesson-usage.jsonl'));
const byId = new Map();
for (const row of usage) {
  const ids = Array.isArray(row.ids) ? row.ids : [];
  for (const id of ids) {
    if (!byId.has(id)) byId.set(id, { turns: 0, completed: 0, other: 0 });
    const s = byId.get(id);
    s.turns += 1;
    if (String(row.outcome || '').includes('completed')) s.completed += 1; else s.other += 1;
  }
}
const cfg = (() => { try { return JSON.parse(fs.readFileSync(`${PROJECT_ROOT}/qq-bridge/config.json`, 'utf8')); } catch { return {}; } })();
const lf = cfg?.socialV2?.lessons?.file || path.join(STATE, 'lessons.jsonl');
const list = readJsonl(lf);

const rows = list.map((l) => {
  const s = byId.get(l.id) || { turns: 0, completed: 0, other: 0 };
  return { text: String(l.text || '').slice(0, 40), conf: l.confidence ?? '', hits: l.hits ?? 0, turns: s.turns, rate: s.turns ? (s.completed / s.turns * 100).toFixed(0) + '%' : '-' };
}).sort((a, b) => b.turns - a.turns);

const day = new Date().toLocaleDateString('sv-SE');
const md = [
  '# 经验效果（代理指标，只读）',
  '',
  '> 说明：这是「经验被注入的回合完成率」，不是因果证明；改置信度仍只走她投票。',
  '',
  '| 经验 | 置信度 | 被用 | 注入回合 | 完成率 |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.text} | ${r.conf} | ${r.hits} | ${r.turns} | ${r.rate} |`),
  '',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
].join('\n');
fs.writeFileSync(path.join(OUT, `lesson-usage-${day}.md`), md + '\n', 'utf8');
console.log('wrote', path.join(OUT, `lesson-usage-${day}.md`));
