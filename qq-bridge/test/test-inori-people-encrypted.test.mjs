// test-inori-people-encrypted.test.mjs · S11ai：真实读端在“加密 people + 默认 key-file”下能解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encryptPeople } from '../src/domain/shared/people-vault.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('加密 people + 默认 key-file：personOf 仍能解析，不需要 env 密钥', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'people-read-enc-'));
  const state = path.join(root, 'data', 'state');
  fs.mkdirSync(path.join(state, 'secrets'), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(state, 'secrets', 'people.key'), key.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 });
  const people = { '10001': { id: '10001', name: '小明', aliases: { g: '小明' }, profile: [] } };
  fs.writeFileSync(path.join(state, 'people.json'), JSON.stringify(encryptPeople(people, { key })), 'utf8');

  const mod = pathToFileURL(path.join(ROOT, 'src/domain/leaves/inori-people.js')).href;
  const code = "import { personOf } from " + JSON.stringify(mod) + "; const p = personOf('10001'); process.stdout.write(JSON.stringify(p || null));";
  const env = { ...process.env, QQ_INORI_ROOT: root };
  delete env.QQ_INORI_PEOPLE_KEY;
  delete env.QQ_INORI_PEOPLE_KEY_FILE;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env });
  assert.equal(out.status, 0, out.stderr);
  const line = out.stdout.trim().split('\n').filter(Boolean).at(-1);
  const person = JSON.parse(line);
  assert.equal(person.id, '10001');
  assert.equal(person.name, '小明');
});
