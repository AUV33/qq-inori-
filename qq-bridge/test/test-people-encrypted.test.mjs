// test-people-encrypted.test.mjs · G11/G12：inori-people 在开关下写加密信封，读端仍可正常工作。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'people-enc-'));
process.env.QQ_INORI_ROOT = ROOT;
process.env.QQ_INORI_OWNER_QQ = '99999';
process.env.QQ_INORI_PEOPLE_ENCRYPT = '1';
process.env.QQ_INORI_PEOPLE_KEY = Buffer.alloc(32, 9).toString('hex');

const pp = await import('../src/domain/leaves/inori-people.js');
const vault = await import('../src/domain/shared/people-vault.mjs');
const peopleFile = path.join(ROOT, 'data', 'state', 'people.json');

test('启用加密：落盘是 v2 信封、无 UIN 明文；读回仍能按 id/别名找人', () => {
  pp.upsertFromGroup('group:1', { id: '10001', name: '小明', count: 3, firstSeen: 1, lastSeen: 2 });
  const raw = fs.readFileSync(peopleFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(vault.isPeopleEnvelope(parsed), true, '应写加密信封');
  assert.equal(raw.includes('10001'), false, '不得出现 QQ 号明文');
  assert.equal(raw.includes('小明'), false, '不得出现昵称明文');

  assert.equal(pp.personOf('10001')?.id, '10001');
  assert.equal(pp.personOf('小明')?.id, '10001');
});

test('密钥丢失：不得用空库覆盖现有密文，也不得偷偷生成新钥', () => {
  const before = fs.readFileSync(peopleFile, 'utf8');
  const oldKey = process.env.QQ_INORI_PEOPLE_KEY;
  delete process.env.QQ_INORI_PEOPLE_KEY;
  pp.noteImpression('10001', { text: '这条写不进去', at: 456 });
  const after = fs.readFileSync(peopleFile, 'utf8');
  assert.equal(after, before, '密钥缺失时磁盘必须原样保留');
  assert.equal(vault.isPeopleEnvelope(JSON.parse(after)), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'data', 'state', 'secrets', 'people.key')), false, 'force 模式不得生成新钥');
  process.env.QQ_INORI_PEOPLE_KEY = oldKey;
});

test('密钥不匹配：拒绝用错误密钥覆盖旧密文', () => {
  const before = fs.readFileSync(peopleFile, 'utf8');
  const good = process.env.QQ_INORI_PEOPLE_KEY;
  process.env.QQ_INORI_PEOPLE_KEY = Buffer.alloc(32, 11).toString('hex');
  pp.noteImpression('10001', { text: '用错钥匙也写不进去', at: 789 });
  assert.equal(fs.readFileSync(peopleFile, 'utf8'), before, '错误密钥不得覆盖');
  process.env.QQ_INORI_PEOPLE_KEY = good;
});

test('粘性加密：开关误关也不把既有密文降级成明文', () => {
  delete process.env.QQ_INORI_PEOPLE_ENCRYPT;
  pp.noteImpression('10001', { text: '变了点', at: 123 });
  const raw = fs.readFileSync(peopleFile, 'utf8');
  assert.equal(vault.isPeopleEnvelope(JSON.parse(raw)), true, '已有密文必须继续加密');
  assert.equal(raw.includes('10001'), false);
  assert.equal(pp.personOf('10001')?.impressions?.length, 1);
});
