#!/usr/bin/env node
// self-anchor.mjs · 宪章「锚定」：身份事实账初始化/查看/她自己的定义追加（默认 dry-run）
//
// 用法：
//   node scripts/self-anchor.mjs show --json
//   node scripts/self-anchor.mjs init --self-qq=<QQ> [--name=<角色名>] [--apply]
//   node scripts/self-anchor.mjs define --text='...' --writer=her [--apply]
//
// 只记录事实：self/owner personId、名字来源、角色卡 hash、创建时间；不写评价、不碰 selfTrust。
import fs from 'node:fs';
import path from 'node:path';
import { obsPaths } from './lib/observability-paths.mjs';
import { personIdFor } from '../src/domain/social/identity-map.mjs';
import { buildAnchorFacts, buildSelfDefinition, foldSelfAnchor, roleCardHash, renderSelfAnchorLine } from '../src/domain/mind/self-anchor.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (prefix, fallback = '') => { const row = args.find((a) => a.startsWith(prefix)); return row ? row.slice(prefix.length) : fallback; };
const asJson = has('--json');
const apply = has('--apply');
const action = args.find((a) => !a.startsWith('-')) || 'show';
const root = obsPaths().root;
const state = obsPaths().state;
const file = path.join(state, 'mind', 'self-anchor.jsonl');

function readRows() {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

function summary(payload) {
  if (asJson) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else if (payload.ok) process.stdout.write('[self-anchor] ' + (payload.line || 'ok') + '\n');
  else process.stderr.write('[self-anchor] 失败：' + (payload.error || 'unknown') + '\n');
}

try {
  if (action === 'show') {
    const folded = foldSelfAnchor(readRows());
    summary({ ok: true, file, anchor: folded.anchor, definitions: folded.definitions, anomalies: folded.anomalies, line: renderSelfAnchorLine(folded) });
    process.exit(0);
  }
  if (action === 'init') {
    const selfQQ = String(valueOf('--self-qq=')).trim();
    if (!/^\d{5,12}$/.test(selfQQ)) throw new Error('init 需要 --self-qq=<QQ>');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'qq-bridge', 'config.json'), 'utf8'));
    const name = String(valueOf('--name=', cfg.roleName || cfg.workspaceTitle || '')).trim();
    if (!name) throw new Error('缺少名字（--name 或 config.workspaceTitle）');
    const roleFile = path.join(root, 'qq-bridge', 'roles', name + '.md');
    let roleText = '';
    try { roleText = fs.readFileSync(roleFile, 'utf8'); } catch { roleText = ''; }
    if (!roleText.trim()) throw new Error('角色卡不存在或为空：' + roleFile);
    const facts = buildAnchorFacts({
      selfPersonId: personIdFor('qq', selfQQ),
      ownerPersonId: cfg.ownerQQ != null ? personIdFor('qq', String(cfg.ownerQQ)) : null,
      name,
      nameSource: 'qq-bridge/roles/' + name + '.md',
      roleCardHash: roleCardHash(roleText),
      createdAt: Date.now(),
    });
    const folded = foldSelfAnchor(readRows());
    const same = folded.anchor && folded.anchor.selfPersonId === facts.selfPersonId && folded.anchor.roleCardHash === facts.roleCardHash && folded.anchor.name === facts.name;
    if (same) { summary({ ok: true, anchored: false, reason: 'already-anchored', anchor: folded.anchor }); process.exit(0); }
    if (!apply) { summary({ ok: true, anchored: false, dryRun: true, anchor: facts }); process.exit(0); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(facts) + '\n', 'utf8');
    summary({ ok: true, anchored: true, anchor: facts });
    process.exit(0);
  }
  if (action === 'define') {
    const text = String(valueOf('--text='));
    const writer = String(valueOf('--writer=', 'operator')) || 'operator';
    const row = buildSelfDefinition({ text, writer, at: Date.now() });
    if (!apply) { summary({ ok: true, applied: false, dryRun: true, row }); process.exit(0); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    summary({ ok: true, applied: true, row });
    process.exit(0);
  }
  summary({ ok: false, error: '未知动作（show/init/define）' });
  process.exit(2);
} catch (error) {
  summary({ ok: false, error: String(error?.message ?? error) });
  process.exit(1);
}