// test-people-vault.test.mjs · G11/G12：people.json 静态加密（opt-in），读端自动识别。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  encryptPeople, decryptPeople, isPeopleEnvelope, readPeopleFile, peopleWritePayload,
  peopleWritePayloadForFile, peopleEncryptionEnabled, loadOrCreatePeopleKey,
} from '../src/domain/shared/people-vault.mjs';

const KEY = Buffer.alloc(32, 7);
const db = { '10001': { id: '10001', aliases: { g: '小明' }, count: 3 } };

test('加解密往返；信封不含明文 UIN/昵称；错密钥/篡改失败关闭', () => {
  const env = encryptPeople(db, { key: KEY });
  assert.equal(isPeopleEnvelope(env), true);
  const raw = JSON.stringify(env);
  assert.equal(raw.includes('10001'), false);
  assert.equal(raw.includes('小明'), false);
  assert.deepEqual(decryptPeople(env, { key: KEY }), db);

  assert.throws(() => decryptPeople(env, { key: Buffer.alloc(32, 8) }), /bad decrypt|Unsupported state/i);
  const tampered = { ...env, data: Buffer.from('x').toString('base64') };
  assert.throws(() => decryptPeople(tampered, { key: KEY }));
});

test('开关：未启用写明文；启用写信封；env 可控制', () => {
  assert.equal(peopleEncryptionEnabled({}), false);
  assert.equal(peopleEncryptionEnabled({ QQ_INORI_PEOPLE_ENCRYPT: '1' }), true);
  const plain = peopleWritePayload(db, { env: {} });
  assert.deepEqual(plain, db);
  const encrypted = peopleWritePayload(db, { env: { QQ_INORI_PEOPLE_ENCRYPT: '1', QQ_INORI_PEOPLE_KEY: KEY.toString('hex') } });
  assert.equal(isPeopleEnvelope(encrypted), true);
});

test('env 密钥格式无效：报错，不静默改用文件/新钥', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-key-env-'));
  const file = path.join(dir, 'people.key');
  assert.throws(() => loadOrCreatePeopleKey({ env: { QQ_INORI_PEOPLE_KEY: 'short' }, file, create: true }), /格式无效/);
  assert.equal(fs.existsSync(file), false);
});

test('密钥文件损坏：拒绝生成新钥覆盖，原内容保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-key-bad-'));
  const keyFile = path.join(dir, 'people.key');
  fs.writeFileSync(keyFile, 'not-a-valid-key', 'utf8');
  assert.throws(() => loadOrCreatePeopleKey({ file: keyFile, create: true }), /损坏/);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'not-a-valid-key');
});

test('按文件现状写：已是信封时开关关掉也写密文，明文文件写明文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-vault-write-'));
  const encFile = path.join(dir, 'enc.json');
  fs.writeFileSync(encFile, JSON.stringify(encryptPeople(db, { key: KEY })), 'utf8');
  const env = { QQ_INORI_PEOPLE_KEY: KEY.toString('hex') };
  assert.equal(isPeopleEnvelope(peopleWritePayloadForFile(encFile, db, { env })), true, '维护脚本不得把密文降级');

  const plainFile = path.join(dir, 'plain.json');
  fs.writeFileSync(plainFile, JSON.stringify(db), 'utf8');
  assert.deepEqual(peopleWritePayloadForFile(plainFile, db, { env: {} }), db);
});

test('文件读：明文照常；信封用 env 密钥解密；无密钥失败关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-vault-'));
  const plainFile = path.join(dir, 'plain.json');
  fs.writeFileSync(plainFile, JSON.stringify(db), 'utf8');
  assert.deepEqual(readPeopleFile(plainFile), db);

  const encFile = path.join(dir, 'enc.json');
  fs.writeFileSync(encFile, JSON.stringify(encryptPeople(db, { key: KEY })), 'utf8');
  const env = { QQ_INORI_PEOPLE_KEY: KEY.toString('hex'), QQ_INORI_PEOPLE_KEY_FILE: path.join(dir, 'nope.key') };
  assert.deepEqual(readPeopleFile(encFile, { env }), db);

  assert.throws(() => readPeopleFile(encFile, { env: { QQ_INORI_PEOPLE_KEY_FILE: path.join(dir, 'missing.key') } }), /密钥缺失/);
  assert.deepEqual(readPeopleFile(path.join(dir, 'missing.json')), {});
});
