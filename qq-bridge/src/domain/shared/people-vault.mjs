// people-vault.mjs · 宪章 G11/G12：people.json 的静态加密（AES-256-GCM，opt-in）
//
// 干什么：把「QQ 号 → 人物档案」的明文 JSON 包成 v2 信封；读端自动识别信封；
//   密钥从 env（QQ_INORI_PEOPLE_KEY，hex/base64）或 data/state/secrets/people.key 读取，
//   缺失时按需生成（0600）。默认不启用——只有 QQ_INORI_PEOPLE_ENCRYPT=1 才写加密。
// 为什么：people.json 是运行时最大的明文 PII 面（UIN 键 + 昵称 + 印象）。加密不等于匿名，
//   但能让"拿到文件但没有密钥"的人读不到；密钥单独存放，可轮换/备份。
// 输入输出：纯编解码 + 文件读；不联网、不写日志里的密钥。
// 失败模式：信封损坏/密钥不对 → 抛错（调用方决定 fail-open/fail-closed）；明文文件照常读。
// 不做什么：不做字段级加密、不做 KMS、不自动把已有明文改成密文（需显式脚本 + 备份）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDataPath } from './project-paths.js';

export const PEOPLE_VAULT_VERSION = 2;
export const PEOPLE_VAULT_ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const AAD = Buffer.from('people:v2', 'utf8');

export function peopleEncryptionEnabled(env = process.env) {
  return String(env?.QQ_INORI_PEOPLE_ENCRYPT ?? '') === '1';
}

function parseKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return buf.length === KEY_BYTES ? buf : null;
}

/** 读或生成密钥；仅加密启用时需要。 */
export function loadOrCreatePeopleKey({ env = process.env, file = '', create = true } = {}) {
  const envRaw = String(env?.QQ_INORI_PEOPLE_KEY ?? '').trim();
  if (envRaw) {
    const fromEnv = parseKey(envRaw);
    // 配了 env 但长度/格式不对：必须报错，不能悄悄改用文件/新钥。
    if (!fromEnv) throw new Error('people-vault: QQ_INORI_PEOPLE_KEY 格式无效（需要 64 位 hex 或 32 字节 base64）');
    return fromEnv;
  }
  const keyFile = path.resolve(String(file || env?.QQ_INORI_PEOPLE_KEY_FILE || stateDataPath('secrets', 'people.key')));
  let raw = null;
  try { raw = fs.readFileSync(keyFile, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (raw !== null) {
    const existing = parseKey(raw);
    // [AUDIT-FIX] 密钥文件存在但损坏时绝不能生成新钥覆盖——那会把旧密文永久锁死。
    if (existing) return existing;
    throw new Error('people-vault: 密钥文件损坏（拒绝覆盖）');
  }
  if (!create) throw new Error('people-vault: 密钥缺失');
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  // [AUDIT-FIX] wx 独占创建：两个进程同时首加密时只有一把钥胜出；后到者读已有的。
  try {
    const fd = fs.openSync(keyFile, 'wx', 0o600);
    try { fs.writeSync(fd, key.toString('hex') + '\n'); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows 上 chmod 可能无效 */ }
    return key;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // 并发首加密：胜出者 open 后还要 write，EEXIST 方可能读到空文件；短暂重试几次再判定损坏。
    for (let i = 0; i < 20; i += 1) {
      const existing = parseKey(fs.readFileSync(keyFile, 'utf8'));
      if (existing) return existing;
    }
    throw new Error('people-vault: 密钥文件并发写入损坏（拒绝覆盖）');
  }
}

export function isPeopleEnvelope(value) {
  return !!value && typeof value === 'object' && Number(value.v) === PEOPLE_VAULT_VERSION && value.alg === PEOPLE_VAULT_ALG
    && typeof value.iv === 'string' && typeof value.tag === 'string' && typeof value.data === 'string';
}

export function encryptPeople(db, { key } = {}) {
  if (!key || key.length !== KEY_BYTES) throw new Error('people-vault: 需要 32 字节密钥');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(PEOPLE_VAULT_ALG, key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(db ?? {}), 'utf8'), cipher.final()]);
  return {
    v: PEOPLE_VAULT_VERSION,
    alg: PEOPLE_VAULT_ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptPeople(envelope, { key } = {}) {
  if (!isPeopleEnvelope(envelope)) throw new Error('people-vault: 不是 v2 信封');
  if (!key || key.length !== KEY_BYTES) throw new Error('people-vault: 需要 32 字节密钥');
  const decipher = crypto.createDecipheriv(PEOPLE_VAULT_ALG, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  const parsed = JSON.parse(plain);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * 读 people 文件：明文对象直接返回；v2 信封自动解密（密钥按需加载）。
 * 缺失文件返回 {}；损坏/密钥缺失抛出（调用方决定是否阻塞）。
 */
export function readPeopleFile(file, { env = process.env, key = null } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!isPeopleEnvelope(parsed)) return parsed && typeof parsed === 'object' ? parsed : {};
  return decryptPeople(parsed, { key: key || loadOrCreatePeopleKey({ env, create: false }) });
}

/** 按开关写出：启用加密时写信封，否则写明文。返回实际写入的对象。 */
export function isPeopleFileEncrypted(file) {
  try { return isPeopleEnvelope(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return false; }
}

export function peopleWritePayload(db, { env = process.env, key = null, force = false, createKey = true } = {}) {
  // force=true 用于“文件已经是信封”的粘性：即使开关被误关，也不把密文降级成明文。
  if (!peopleEncryptionEnabled(env) && !force) return db ?? {};
  // [AUDIT-FIX] 已有密文但密钥丢失时，绝不能生成新钥把旧密文覆盖成空库：
  // force 模式下只允许读已有密钥，不做 create。
  const resolved = key || loadOrCreatePeopleKey({ env, create: force ? false : createKey });
  return encryptPeople(db, { key: resolved });
}

/** 按目标文件现状决定写密文还是明文：已是信封就强制加密（维护脚本也不得降级）。 */
export function peopleWritePayloadForFile(file, db, opts = {}) {
  const force = isPeopleFileEncrypted(file);
  return peopleWritePayload(db, { ...opts, force, createKey: !force });
}
