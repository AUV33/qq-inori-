#!/usr/bin/env node
// social-graph-migrate.mjs · 宪章 S6b：把旧社交图（昵称键）迁到 personId 键
//
// 用法：
//   node scripts/social-graph-migrate.mjs            # dry-run
//   node scripts/social-graph-migrate.mjs --apply    # 写回（先备份 .bak-<时间戳>）
//   node scripts/social-graph-migrate.mjs --json
//
// 映射来源：people.json 的 UIN + aliases（cleanName 后精确匹配）；同名多 UIN 视为歧义，跳过。
// 已带 personId 的行原样保留；无法解析的行保留并计入 skipped，不删除任何数据。
import fs from 'node:fs';
import path from 'node:path';
import { obsPaths } from './lib/observability-paths.mjs';
import { cleanName, pairKey } from '../src/domain/leaves/inori-social-graph.js';
import { personIdFor } from '../src/domain/social/identity-map.mjs';
// [PEOPLE-VAULT] people.json 可能是加密信封。
import { readPeopleFile } from '../src/domain/shared/people-vault.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const asJson = has('--json');
const paths = obsPaths();
const graphFile = paths.socialGraph;
const peopleFile = paths.people;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

const graph = readJson(graphFile, null);
let people = {};
try { people = readPeopleFile(peopleFile); } catch { people = readJson(peopleFile, {}); }
if (!graph || typeof graph !== 'object' || !graph.groups) { console.error('社交图不存在或形状不对：' + graphFile); process.exit(2); }

const nameToId = new Map();
const ambiguous = new Set();
for (const [uin, person] of Object.entries(people && typeof people === 'object' ? people : {})) {
  if (!/^\d{5,12}$/.test(String(uin))) continue;
  const pid = personIdFor('qq', String(uin));
  const names = [uin, ...Object.values(person?.aliases && typeof person.aliases === 'object' ? person.aliases : {})];
  for (const raw of names) {
    const name = cleanName(raw);
    if (!name) continue;
    if (nameToId.has(name) && nameToId.get(name) !== pid) ambiguous.add(name);
    else nameToId.set(name, pid);
  }
}
for (const name of ambiguous) nameToId.delete(name);

let migrated = 0;
let skipped = 0;
let merged = 0;
let already = 0;
const groups = {};
for (const [key, g] of Object.entries(graph.groups)) {
  const pairs = {};
  const source = g && typeof g.pairs === 'object' ? g.pairs : {};
  for (const [pk, row] of Object.entries(source)) {
    if (!row || typeof row !== 'object') { pairs[pk] = row; continue; }
    const a = cleanName(row.a);
    const b = cleanName(row.b);
    if (/^p_[0-9a-f]{12}$/.test(a) && /^p_[0-9a-f]{12}$/.test(b)) { pairs[pk] = row; already += 1; continue; }
    const pidA = nameToId.get(a);
    const pidB = nameToId.get(b);
    if (!pidA || !pidB || pidA === pidB) { pairs[pk] = row; skipped += 1; continue; }
    const first = pidA <= pidB ? pidA : pidB;
    const second = pidA <= pidB ? pidB : pidA;
    const newKey = pairKey(first, second);
    const forward = pidA === first;
    const existing = pairs[newKey];
    const aName = cleanName(row.aName || row.a);
    const bName = cleanName(row.bName || row.b);
    const next = existing || {
      a: first, b: second, aName: '', bName: '', ab: 0, ba: 0, reply: 0, adjacent: 0, mention: 0, pos: 0, neg: 0, lastAt: 0,
    };
    next.ab += forward ? Number(row.ab) || 0 : Number(row.ba) || 0;
    next.ba += forward ? Number(row.ba) || 0 : Number(row.ab) || 0;
    for (const f of ['reply', 'adjacent', 'mention', 'pos', 'neg']) next[f] += Number(row[f]) || 0;
    next.lastAt = Math.max(Number(next.lastAt) || 0, Number(row.lastAt) || 0);
    if (!next.aName) next.aName = forward ? aName : bName;
    if (!next.bName) next.bName = forward ? bName : aName;
    if (existing) merged += 1; else migrated += 1;
    pairs[newKey] = next;
  }
  groups[key] = { ...g, pairs };
}

const nextGraph = { ...graph, groups };
const changed = migrated > 0 || merged > 0;
if (has('--apply') && changed) {
  const backup = graphFile + '.bak-socialid-' + Date.now();
  fs.copyFileSync(graphFile, backup);
  const tmp = graphFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(nextGraph), 'utf8');
  fs.renameSync(tmp, graphFile);
}
const body = {
  apply: has('--apply'),
  graph: graphFile,
  groups: Object.keys(groups).length,
  migrated,
  merged,
  already,
  skipped,
  ambiguousNames: [...ambiguous].slice(0, 20),
  changed,
  sourceRows: Object.values(graph.groups).reduce((n, g) => n + Object.keys(g?.pairs || {}).length, 0),
};
if (asJson) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
else {
  process.stdout.write(`[social-graph-migrate] ${body.sourceRows} 行 / ${body.groups} 组：可迁 ${migrated}，合并 ${merged}，已 canonical ${already}，跳过 ${skipped}\n`);
  if (body.ambiguousNames.length) process.stdout.write(`  同名歧义（不猜）：${body.ambiguousNames.join('、')}\n`);
  process.stdout.write(has('--apply') ? '已写回（已备份）\n' : 'dry-run：加 --apply 才写\n');
}
