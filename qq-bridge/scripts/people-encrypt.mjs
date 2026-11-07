#!/usr/bin/env node
// people-encrypt.mjs · 宪章 S6b-5d：people.json 加密迁移/轮换工具（默认不动真实数据）
//
// 用法：
//   node scripts/people-encrypt.mjs status [--json]
//   node scripts/people-encrypt.mjs apply  [--apply] [--json]
//   node scripts/people-encrypt.mjs verify [--json]
//   node scripts/people-encrypt.mjs rotate --new-key=<64hex> [--apply] [--json]
//
// 安全约束：
//   - 没有 --apply 一律 dry-run；
//   - apply 前备份 .bak-peoplecrypt-<ts>，写入后立即用新钥解密校验，校验失败不替换；
//   - 已经加密的文件不再 apply；rotate 必须显式给新钥（不偷偷生成）；
//   - 缺密钥/解密失败一律拒绝，不写空库（S11h/S11i 的同一原则）。
import fs from 'node:fs';
import path from 'node:path';
import { obsPaths } from './lib/observability-paths.mjs';
import {
  readPeopleFile, isPeopleFileEncrypted, encryptPeople, decryptPeople, loadOrCreatePeopleKey, isPeopleEnvelope,
} from '../src/domain/shared/people-vault.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (prefix) => { const row = args.find((a) => a.startsWith(prefix)); return row ? row.slice(prefix.length) : ''; };
const asJson = has('--json');
const apply = has('--apply');
const action = args.find((a) => !a.startsWith('-')) || 'status';
const file = valueOf('--file=') ? path.resolve(valueOf('--file=')) : obsPaths().people;

function keyFromCli({ create = false } = {}) {
  const hex = valueOf('--key=');
  if (hex) { const b = Buffer.from(hex, 'hex'); if (b.length !== 32) throw new Error('--key 需要 64 位 hex'); return b; }
  const keyFile = valueOf('--key-file=');
  // 显式 --key-file 必须压过 env，否则运维指定文件却仍拿 env 旧钥。
  if (keyFile) return loadOrCreatePeopleKey({ env: {}, file: keyFile, create });
  return loadOrCreatePeopleKey({ create });
}
function newKeyFromCli() {
  const hex = valueOf('--new-key=');
  if (hex) { const b = Buffer.from(hex, 'hex'); if (b.length !== 32) throw new Error('--new-key 需要 64 位 hex（32 字节）'); return b; }
  const file = valueOf('--new-key-file=');
  if (file) { const b = Buffer.from(String(fs.readFileSync(file, 'utf8')).trim(), 'hex'); if (b.length !== 32) throw new Error('新密钥文件不是 64 位 hex'); return b; }
  throw new Error('rotate 必须显式提供 --new-key=<64hex> 或 --new-key-file=<file>');
}
function writeAtomic(filePath, value) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, filePath);
}
function backup(filePath, stamp) {
  const bak = `${filePath}.bak-peoplecrypt-${stamp}`;
  fs.copyFileSync(filePath, bak);
  // POSIX 上收紧；Windows 的 ACL 需 owner 手工收敛（见密钥保管.md）。
  try { fs.chmodSync(bak, 0o600); } catch { /* 忽略 */ }
  return bak;
}

/** 轮换后把新钥写回 key-file；旧钥先备份。仅显式给了 --key-file 才写。 */
function persistKeyFile(keyFile, key) {
  const abs = path.resolve(keyFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  if (fs.existsSync(abs)) {
    const oldBak = `${abs}.bak-key-${Date.now()}`;
    fs.copyFileSync(abs, oldBak);
    try { fs.chmodSync(oldBak, 0o600); } catch { /* 忽略 */ }
  }
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, key.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, abs);
  try { fs.chmodSync(abs, 0o600); } catch { /* Windows 上忽略 */ }
  return abs;
}
function summary(payload) {
  if (asJson) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    if (payload.action === 'status') process.stdout.write(`[people-encrypt] ${payload.encrypted ? '已加密' : '明文'} · ${payload.bytes} B · 密钥${payload.keyAvailable ? '可用' : '不可用'}\n`);
    else process.stdout.write(`[people-encrypt] ${payload.action}${payload.applied ? ' 已写入' : '（dry-run）'}${payload.backup ? ' · 备份 ' + payload.backup : ''}${payload.verified ? ' · 解密校验通过' : ''}\n`);
  }
}

try {
  if (!fs.existsSync(file)) { summary({ action, ok: false, error: 'people.json 不存在' }); process.exit(2); }
  const encrypted = isPeopleFileEncrypted(file);
  if (action === 'doctor') {
    const keyFileArg = valueOf('--key-file=');
    const keyFile = path.resolve(keyFileArg || process.env.QQ_INORI_PEOPLE_KEY_FILE || path.join(path.dirname(file), 'secrets', 'people.key'));
    const keyFileExists = fs.existsSync(keyFile);
    let keyMode = null;
    try { keyMode = fs.statSync(keyFile).mode & 0o777; } catch { /* no key file */ }
    let keyAvailable = false;
    let people = null;
    try {
      const key = keyFromCli();
      people = Object.keys(decryptPeople(JSON.parse(fs.readFileSync(file, 'utf8')), { key })).length;
      keyAvailable = true;
    } catch { /* key/file 不可用 */ }
    const dir = path.dirname(file);
    let backups = [];
    try { backups = fs.readdirSync(dir).filter((n) => n.startsWith('people.json.bak-peoplecrypt-')); } catch { /* ignore */ }
    const envKeySet = !!String(process.env.QQ_INORI_PEOPLE_KEY ?? '').trim();
    const warnings = [];
    if (!encrypted) warnings.push('plaintext');
    if (!keyAvailable) warnings.push('key-unavailable');
    if (envKeySet) warnings.push('env-key-overrides-file');
    if (backups.length) warnings.push('plaintext-backup-exists');
    if (process.platform !== 'win32' && keyMode !== null && (keyMode & 0o077)) warnings.push('key-file-too-open');
    summary({ action: 'doctor', ok: encrypted && keyAvailable, encrypted, keyAvailable, people, keyFile, keyFileExists, keyMode: keyMode === null ? null : keyMode.toString(8), backups: backups.length, envKeySet, warnings });
    process.exit(encrypted && keyAvailable ? 0 : 1);
  }
  if (action === 'status') {
    let keyAvailable = false; try { keyFromCli(); keyAvailable = true; } catch { keyAvailable = false; }
    summary({ action, ok: true, encrypted, keyAvailable, bytes: fs.statSync(file).size });
    process.exit(0);
  }
  if (action === 'verify') {
    if (!encrypted) { summary({ action, ok: false, encrypted: false }); process.exit(1); }
    const key = keyFromCli();
    const db = decryptPeople(JSON.parse(fs.readFileSync(file, 'utf8')), { key });
    summary({ action, ok: true, encrypted: true, people: Object.keys(db).length });
    process.exit(0);
  }
  if (action === 'apply') {
    if (encrypted) { summary({ action, ok: false, error: '已经是密文，未做任何写入' }); process.exit(1); }
    const db = readPeopleFile(file);
    if (!apply) {
      // [AUDIT-FIX] dry-run 不得生成密钥文件：先证明“能跑”，再决定是否落钥。
      summary({ action, ok: true, applied: false, dryRun: true, people: Object.keys(db).length });
      process.exit(0);
    }
    const key = keyFromCli({ create: true });
    const envelope = encryptPeople(db, { key });
    // 写入前先自检：同一把钥能解回来才算数
    decryptPeople(envelope, { key });
    const stamp = Date.now();
    const bak = backup(file, stamp);
    writeAtomic(file, envelope);
    assertDecrypts(file, key);
    // [AUDIT-FIX] 显式 --key-file 会忽略 env；若 env 旧钥仍在，运行时仍解不开，必须提示。
    const applyEnvKeySet = !!String(process.env.QQ_INORI_PEOPLE_KEY ?? '').trim();
    const applyKeyFileArg = valueOf('--key-file=');
    summary({ action, ok: true, applied: true, backup: bak, verified: true, envKeySet: applyEnvKeySet, keyFile: applyKeyFileArg ? path.resolve(applyKeyFileArg) : '' });
    if (!asJson && applyKeyFileArg && applyEnvKeySet) {
      console.error('[people-encrypt] ⚠️ 本次用 --key-file 加密，但 QQ_INORI_PEOPLE_KEY 仍优先；运行时会拿旧 env 钥，请更新/移除 env。');
    }
    process.exit(0);
  }
  if (action === 'rotate') {
    if (!encrypted) { summary({ action, ok: false, error: '当前是明文，先 apply' }); process.exit(1); }
    const oldKey = keyFromCli();
    const newKey = newKeyFromCli();
    const db = decryptPeople(JSON.parse(fs.readFileSync(file, 'utf8')), { key: oldKey });
    const envelope = encryptPeople(db, { key: newKey });
    decryptPeople(envelope, { key: newKey });
    if (!apply) { summary({ action, ok: true, applied: false, dryRun: true, people: Object.keys(db).length }); process.exit(0); }
    const stamp = Date.now();
    const bak = backup(file, stamp);
    writeAtomic(file, envelope);
    assertDecrypts(file, newKey);
    const keyFileArg = valueOf('--key-file=');
    let keyFile = '';
    try {
      keyFile = keyFileArg ? persistKeyFile(keyFileArg, newKey) : '';
    } catch (error) {
      // 密钥没写成功 = 运行时仍拿旧钥；必须把数据回滚到旧钥版本，不能留下“新数据+旧钥”的死局。
      fs.copyFileSync(bak, file);
      summary({ action, ok: false, error: `密钥写回失败，people 已回滚：${error?.message ?? error}`, rolledBack: true });
      process.exit(1);
    }
    const envKeySet = !!String(process.env.QQ_INORI_PEOPLE_KEY ?? '').trim();
    const envKeyFile = String(process.env.QQ_INORI_PEOPLE_KEY_FILE ?? '').trim();
    const envKeyFileMismatch = !!envKeyFile && !!keyFileArg && path.resolve(envKeyFile) !== path.resolve(keyFileArg);
    summary({ action, ok: true, applied: true, backup: bak, verified: true, keyPersisted: !!keyFile, keyFile, envKeySet, envKeyFile });
    if (!asJson && (!keyFile || envKeySet || envKeyFileMismatch)) {
      console.error('[people-encrypt] ⚠️ 运行时密钥来源仍未指向新钥：' + (envKeySet ? 'QQ_INORI_PEOPLE_KEY 仍优先' : envKeyFileMismatch ? 'QQ_INORI_PEOPLE_KEY_FILE 指向另一个文件' : '新钥未持久化') + '，请更新/移除对应 env 或写回 key-file。');
    }
    process.exit(0);
  }
  summary({ action, ok: false, error: '未知动作（status/verify/apply/rotate）' }); process.exit(2);
} catch (error) {
  if (asJson) process.stdout.write(JSON.stringify({ action, ok: false, error: String(error?.message ?? error) }, null, 2) + '\n');
  else console.error(`[people-encrypt] 失败：${error?.message ?? error}`);
  process.exit(1);
}

function assertDecrypts(filePath, key) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isPeopleEnvelope(parsed)) throw new Error('写回后不是信封');
  decryptPeople(parsed, { key });
}
