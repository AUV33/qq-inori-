import fs from 'node:fs';

const rows = JSON.parse(fs.readFileSync('../data/reports/empty-catch-all-2026-10-31.json', 'utf8'));
const safe = /terminate|kill\(|rmSync|rm\(|unlink|remove|close|destroy|disconnect|clearTimeout|abort|JSON\.parse|fallback|可选|忽略|不影响|失败不挡|不挡主|跳过|already|not found|找不到|没有|noop|no-op|best.?effort|cleanup|清理|容错|保底|兜底/i;
const danger = /send|fetch|http|api\.|agentApi|writeFile|appendFile|rename|mkdir|readFile|save|persist|auth|token|session|task|agent|memory|skill|lesson|goal|intention|outcome|upload|download|spawn|exec|voice|image|worker|socket|ws\.|push|notify|record/i;
const classify = (r) => {
  const text = `${r.before} ${r.code} ${r.after}`;
  if (safe.test(text)) return '可接受';
  if (danger.test(text)) return '危险';
  return '需判断';
};
const groups = { 危险: [], 需判断: [], 可接受: [] };
for (const r of rows) groups[classify(r)].push(r);
const fmt = (r) => `- ${r.file}:${r.line} — ${r.code}\n  - 前：${r.before.slice(0, 140) || '（无）'}\n  - 后：${r.after.slice(0, 140) || '（无）'}`;
const md = [
  `# 空 catch 判断（${rows.length} 处）`,
  '',
  `- 危险：${groups.危险.length}`,
  `- 需判断：${groups.需判断.length}`,
  `- 可接受：${groups.可接受.length}`,
  '',
  '## 危险（优先看）',
  ...groups.危险.map(fmt),
  '',
  '## 需判断',
  ...groups.需判断.map(fmt),
  '',
  '## 可接受（清理/可选功能/已注明不挡主路）',
  ...groups.可接受.map(fmt),
  '',
].join('\n');
fs.writeFileSync('../data/reports/empty-catch-judgement-2026-10-31.md', md, 'utf8');
console.log(JSON.stringify({ total: rows.length, danger: groups.危险.length, maybe: groups.需判断.length, safe: groups.可接受.length }));
console.log(groups.危险.slice(0, 20).map((r) => `${r.file}:${r.line} ${r.code}`).join('\n'));
