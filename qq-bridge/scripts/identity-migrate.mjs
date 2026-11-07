#!/usr/bin/env node
// identity-migrate.mjs · 宪章 S6a：people.json（UIN 键）→ 统一身份账（只存摘要）
//
// 用法：
//   node scripts/identity-migrate.mjs            # dry-run（默认）
//   node scripts/identity-migrate.mjs --apply    # 追加缺失的 link/alias 事件
//   node scripts/identity-migrate.mjs --json
//
// 幂等：按 platform:hash（link）与 personId:aliasHash（alias）去重。
// 隐私：账本只写 sha256 摘要；不写 QQ 号、昵称、手机号明文。
// 不做什么：不改 people.json / social-graph；只读旧档、追加新账。
import fs from 'node:fs';
import { obsPaths } from './lib/observability-paths.mjs';
import {
  createIdentityStore, peopleToIdentityEvents, foldIdentity, parseIdentityLedger,
} from '../src/domain/social/identity-map.mjs';
// [PEOPLE-VAULT] people.json 可能是加密信封。
import { readPeopleFile } from '../src/domain/shared/people-vault.mjs';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error && error.code === 'ENOENT') return ''; throw error; }
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const paths = obsPaths();
let people = null;
try { people = readPeopleFile(paths.people); } catch { people = readJson(paths.people); }
if (!people || typeof people !== 'object') {
  console.error('people.json 不存在或不是对象：' + paths.people);
  process.exit(2);
}

const existing = parseIdentityLedger(readText(paths.identityMap));
const foldedExisting = foldIdentity(existing.rows);
const linkKeys = new Set(foldedExisting.people.flatMap((p) => p.links.map((l) => `${l.platform}:${l.hash}`)));
const aliasKeys = new Set(foldedExisting.people.flatMap((p) => p.aliases.map((a) => `${p.personId}:${a}`)));

const all = peopleToIdentityEvents(people, { now: Date.now() });
const fresh = all.filter((event) => {
  if (event.kind === 'link') return !linkKeys.has(`${event.platform}:${event.externalIdHash}`);
  if (event.kind === 'alias') return !aliasKeys.has(`${event.personId}:${event.aliasHash}`);
  return false;
});

let appended = 0;
if (has('--apply')) {
  const store = createIdentityStore({ file: paths.identityMap });
  for (const event of fresh) {
    await store.appendEvent(event, { writer: 'migration' });
    appended += 1;
  }
}

const body = {
  apply: has('--apply'),
  source: { path: paths.people, people: Object.keys(people).length },
  converted: all.length,
  existingEvents: existing.rows.length,
  fresh: fresh.length,
  appended,
  ledger: { path: paths.identityMap, events: existing.rows.length + appended, corrupt: existing.corrupt.length, people: foldedExisting.people.length },
};
if (has('--json')) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
else {
  process.stdout.write(`people.json -> 身份账：${body.source.people} 人，转换 ${body.converted} 事件，已有 ${body.existingEvents} 事件\n`);
  process.stdout.write(has('--apply') ? `已追加 ${appended} 条（摘要，无明文）\n` : `去重后待追加 ${body.fresh} 条（dry-run，加 --apply 才写）\n`);
}
