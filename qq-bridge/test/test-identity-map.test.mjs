// test-identity-map.test.mjs · 宪章 §5.9/G11：认人不能靠"UIN 精确 + 昵称 includes"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStateHub } from '../src/domain/mind/state-hub.mjs';
import {
  hashExternalId, hashAlias, normalizeAlias, personIdFor,
  buildLink, buildAlias, buildMerge, foldIdentity, resolveIdentity, resolveAlias,
  parseIdentityLedger, peopleToIdentityEvents, identitySummary, createIdentityStore, IdentityError,
} from '../src/domain/social/identity-map.mjs';

const T = Date.UTC(2026, 10, 5, 12);
const qqLink = (uin = '10001', over = {}) => buildLink({ platform: 'qq', externalId: uin, at: T, ...over });

test('隐私：账本只出摘要，不落 QQ 号/昵称明文；personId 稳定', () => {
  const link = qqLink('10001');
  const alias = buildAlias({ personId: link.personId, alias: '示例甲', at: T });
  const raw = JSON.stringify([link, alias]);
  assert.equal(raw.includes('10001'), false, 'QQ 号不得明文');
  assert.equal(raw.includes('示例甲'), false, '昵称不得明文');
  assert.match(link.externalIdHash, /^[0-9a-f]{16}$/);
  assert.match(alias.aliasHash, /^[0-9a-f]{16}$/);
  assert.equal(hashExternalId('QQ', '10001'), hashExternalId('qq', '10001'), '平台归一');
  assert.equal(hashAlias('  示例甲  '), hashAlias('示例甲'), '别名归一');
  assert.equal(normalizeAlias('ＡＢＣ  '), 'abc');
  assert.equal(personIdFor('qq', '10001'), link.personId);
});

test('折叠与解析：同一个人在多个平台归并到同一 personId', () => {
  const qq = qqLink('10001');
  const bili = buildLink({ platform: 'bili', externalId: 'mid-9', personId: qq.personId, at: T });
  const qzone = buildLink({ platform: 'qzone', externalId: 'uin-10001', personId: qq.personId, at: T });
  const folded = foldIdentity([qq, bili, qzone, buildAlias({ personId: qq.personId, alias: '示例甲', at: T })]);
  assert.equal(folded.people.length, 1);
  assert.equal(folded.people[0].links.length, 3);
  assert.equal(folded.people[0].aliases.length, 1);
  assert.equal(resolveIdentity(folded, 'qq', '10001').personId, qq.personId);
  assert.equal(resolveIdentity(folded, 'bili', 'mid-9').personId, qq.personId);
  assert.equal(resolveIdentity(folded, 'phone', 'nope'), null);
  assert.deepEqual(identitySummary(folded), { people: 1, links: 3, aliases: 1, merged: 0, anomalies: 0 });
});

test('合并：from 的链接/别名迁入 into；之后解析仍指向 into；冲突进 anomalies', () => {
  const a = qqLink('10001');
  const b = buildLink({ platform: 'bili', externalId: 'mid-9', at: T });
  const merged = foldIdentity([a, b, buildAlias({ personId: a.personId, alias: '示例甲', at: T }), buildMerge({ from: a.personId, into: b.personId, reason: '同一人', at: T })]);
  assert.equal(merged.people.length, 2);
  const into = merged.people.find((p) => p.personId === b.personId);
  assert.equal(into.links.length, 2);
  assert.equal(into.aliases.length, 1);
  assert.equal(merged.people.find((p) => p.personId === a.personId).mergedInto, b.personId);
  assert.equal(resolveIdentity(merged, 'qq', '10001').personId, b.personId, '合并后解析走 canonical');

  const conflict = foldIdentity([
    qqLink('10001'),
    buildLink({ platform: 'qq', externalId: '10001', personId: 'p_aaaaaaaaaaaa', at: T }),
  ]);
  assert.ok(conflict.anomalies.some((x) => String(x.reason).startsWith('link-conflict')));
  assert.ok(foldIdentity([buildAlias({ personId: 'p_aaaaaaaaaaaa', alias: 'x', at: T })]).anomalies.some((x) => x.reason === 'unknown-person:alias'));
  assert.ok(foldIdentity([buildMerge({ from: 'p_aaaaaaaaaaaa', into: 'p_bbbbbbbbbbbb', at: T })]).anomalies.some((x) => x.reason === 'bad-merge'));
});

test('顺序不敏感：alias 先于 link、merge 先于 link 都不丢', () => {
  const link = qqLink('10001');
  const aliasFirst = foldIdentity([
    buildAlias({ personId: link.personId, alias: '早期别名', at: T }),
    link,
  ]);
  assert.equal(aliasFirst.people[0].aliases.length, 1, '先到的别名要等 link 出现后挂上');
  assert.ok(resolveAlias(aliasFirst, '早期别名'));

  const a = qqLink('10001');
  const b = buildLink({ platform: 'bili', externalId: 'mid-9', at: T });
  const mergeFirst = foldIdentity([
    buildMerge({ from: a.personId, into: b.personId, at: T }),
    a, b,
  ]);
  assert.equal(mergeFirst.people.length, 2);
  assert.equal(mergeFirst.people.find((p) => p.personId === b.personId).links.length, 2, '先到的 merge 要在 link 建人后生效');
});

test('alias 超过上限不静默：保留 50 条并记 alias-overflow', () => {
  const link = qqLink('10001');
  const events = [link];
  for (let i = 0; i < 55; i += 1) events.push(buildAlias({ personId: link.personId, alias: `别名${i}`, at: T + i }));
  const folded = foldIdentity(events);
  assert.equal(folded.people[0].aliases.length, 50);
  assert.ok(folded.anomalies.some((x) => x.reason === 'alias-overflow'));
});

test('merge 之后的迟到 link/alias 归到 canonical，不在壳上长新数据', () => {
  const a = qqLink('10001');
  const b = buildLink({ platform: 'bili', externalId: 'mid-9', at: T });
  const folded = foldIdentity([
    a, b,
    buildMerge({ from: a.personId, into: b.personId, reason: '同一人', at: T }),
    buildAlias({ personId: a.personId, alias: '迟到别名', at: T + 1 }),
    buildLink({ platform: 'qzone', externalId: 'late-qzone', personId: a.personId, at: T + 1 }),
  ]);
  const into = folded.people.find((p) => p.personId === b.personId);
  const shell = folded.people.find((p) => p.personId === a.personId);
  assert.equal(into.links.length, 3, '迟到的 qzone 链接必须归 canonical');
  assert.equal(into.aliases.length, 1, '迟到的别名必须归 canonical');
  assert.equal(shell.links.length, 0);
  assert.equal(resolveIdentity(folded, 'qzone', 'late-qzone').personId, b.personId);
});

test('people.json 迁移：UIN 键 → link + 别名摘要，幂等且无明文', () => {
  const people = {
    '10001': { id: '10001', owner: true, aliases: { 'group:1': '示例甲', 'group:2': '示例乙' } },
    '10002': { id: '10002', aliases: { 'group:1': '阿明' } },
    notAUin: { id: 'x', aliases: {} },
  };
  const events = peopleToIdentityEvents(people, { now: T });
  assert.equal(events.filter((e) => e.kind === 'link').length, 2);
  assert.equal(events.filter((e) => e.kind === 'alias').length, 3);
  const raw = JSON.stringify(events);
  assert.equal(/10001|10002|示例甲|示例乙|阿明/.test(raw), false, '不得出现明文 PII');
  const folded = foldIdentity(events);
  assert.equal(folded.people.length, 2);
  assert.equal(resolveIdentity(folded, 'qq', '10001').personId, personIdFor('qq', '10001'));
  assert.deepEqual(peopleToIdentityEvents(people, { now: T }), events, '转换必须确定');
});

test('消费端：state-hub 读得到身份账摘要，并能把 QQ 号解析成 personId', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-view-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const store = createIdentityStore({ file: path.join(root, 'identity-map.jsonl'), now: () => T });
    await store.link({ platform: 'qq', externalId: '10001' });
    const hub = createStateHub({ root, now: () => T, log: () => {} });
    hub.load();
    const view = hub.getIdentityMap();
    assert.equal(view.summary.people, 1);
    assert.equal(view.summary.links, 1);
    assert.equal(hub.status().identity.people, 1);
    assert.equal(hub.resolvePerson('qq', '10001').personId, personIdFor('qq', '10001'));
    assert.equal(hub.resolvePerson('bili', 'nope'), null);
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});

test('迁移脚本：默认 dry-run、--apply 才写、只读 people.json', () => {
  const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const script = fs.readFileSync(path.join(HERE, '..', 'scripts/identity-migrate.mjs'), 'utf8');
  assert.match(script, /--apply/);
  assert.match(script, /peopleToIdentityEvents/);
  assert.match(script, /writer: 'migration'/);
  assert.match(script, /identityMap/);
});

test('存储：append 白名单、去重链接、坏行 corrupt、解析现读', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
  const previous = process.env.LEARNING_TREND;
  process.env.LEARNING_TREND = path.join(root, 'trend.jsonl');
  try {
    const file = path.join(root, 'identity-map.jsonl');
    const store = createIdentityStore({ file, now: () => T });
    const first = await store.link({ platform: 'qq', externalId: '10001', label: '示例甲' });
    assert.equal(first.existing, false);
    const again = await store.link({ platform: 'qq', externalId: '10001' });
    assert.equal(again.existing, true);
    assert.equal(again.personId, first.personId);
    await assert.rejects(() => store.appendEvent(buildAlias({ personId: first.personId, alias: 'x', at: T }), { writer: 'nope' }), /白名单/);
    fs.appendFileSync(file, 'bad-json\n', 'utf8');
    const s = await store.state();
    assert.equal(s.people.length, 1);
    assert.equal(s.corrupt.length, 1);
    assert.equal((await store.resolve('qq', '10001')).personId, first.personId);
    assert.deepEqual(parseIdentityLedger('{"kind":"link"}\nbad\n').corrupt, [{ line: 2, reason: 'bad-json' }]);
    assert.equal(typeof IdentityError, 'function');
  } finally {
    if (previous === undefined) delete process.env.LEARNING_TREND; else process.env.LEARNING_TREND = previous;
  }
});
