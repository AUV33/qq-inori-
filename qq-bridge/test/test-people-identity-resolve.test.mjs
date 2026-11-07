// test-people-identity-resolve.test.mjs · S6b-4：people 读端兼容身份账（历史别名/改名不失联/共名不误并）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'people-identity-'));
process.env.QQ_INORI_ROOT = ROOT;
process.env.QQ_INORI_OWNER_QQ = '99999';

const pp = await import('../src/domain/leaves/inori-people.js');
const { createIdentityStore } = await import('../src/domain/social/identity-map.mjs');

const stateDir = path.join(ROOT, 'data', 'state');
const peopleFile = path.join(stateDir, 'people.json');
const ledgerFile = path.join(stateDir, 'mind', 'identity-map.jsonl');

function seedPeople(db) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(peopleFile, JSON.stringify(db), 'utf8');
}
function reset() {
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
}
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('历史别名（不在 people.aliases 里）也能解析到 UIN', async () => {
  reset();
  seedPeople({
    '10001': { id: '10001', aliases: { 'group:1': '小明' }, groups: ['group:1'], count: 1, firstSeen: 1, lastSeen: 2 },
  });
  const store = createIdentityStore({ file: ledgerFile, now: () => 1 });
  await store.link({ platform: 'qq', externalId: '10001' });
  await store.addAlias((await store.resolve('qq', '10001')).personId, '很久以前的名字');

  assert.equal(pp.personOf('10001')?.id, '10001');
  assert.equal(pp.personOf('小明')?.id, '10001', '当前群昵称仍走旧路径');
  assert.equal(pp.personOf('很久以前的名字')?.id, '10001', '身份账历史别名兜底');
  assert.equal(pp.personOf('查无此人'), null);
});

test('共昵称歧义不猜：两个 person 都有同一别名 → 原样返回，不误并', async () => {
  reset();
  seedPeople({
    '10001': { id: '10001', aliases: {}, groups: [], count: 0, firstSeen: 1, lastSeen: 2 },
    '10002': { id: '10002', aliases: {}, groups: [], count: 0, firstSeen: 1, lastSeen: 2 },
  });
  const store = createIdentityStore({ file: ledgerFile, now: () => 2 });
  const a = await store.link({ platform: 'qq', externalId: '10001' });
  const b = await store.link({ platform: 'qq', externalId: '10002' });
  await store.addAlias(a.personId, '同名');
  await store.addAlias(b.personId, '同名');
  assert.equal(pp.personOf('同名'), null, '歧义时不得随便并到某个人');
});

test('缓存按 mtime 失效：新别名写入后立即可解析', async () => {
  reset();
  seedPeople({ '10001': { id: '10001', aliases: {}, groups: [], count: 0, firstSeen: 1, lastSeen: 2 } });
  const store = createIdentityStore({ file: ledgerFile, now: () => 3 });
  const link = await store.link({ platform: 'qq', externalId: '10001' });
  assert.equal(pp.personOf('新名字'), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.addAlias(link.personId, '新名字');
  assert.equal(pp.personOf('新名字')?.id, '10001', 'mtime 变化后缓存应失效');
});
