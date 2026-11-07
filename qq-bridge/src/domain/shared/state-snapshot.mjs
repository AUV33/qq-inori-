// state-snapshot.mjs · 宪章 G4：灾难快照（可验证、可演练、可回滚）
//
// 干什么：把关键状态文件复制成一份带 sha256 清单的快照；verify 逐文件复核；restore 只从
//   通过校验的快照恢复，并在覆盖前留 .bak。快照与恢复都只允许 root 内相对路径。
// 为什么：G4 要求灾难恢复演练通过；没有可验证快照的"备份"只是心理安慰，
//   校验和缺失时会把损坏文件一起恢复回去。
// 输入输出：纯文件操作；{manifest, verify, restored} 结构；不联网、不调用模型。
// 失败模式：缺失文件进 missing（不算失败）；篡改→verify.ok=false；路径穿越→拒绝。
// 不做什么：不加密（快照是本机私有备份）、不压缩、不自动定时（由脚本/宿主决定）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_VERSION = 1;
// [AUDIT-FIX] 实际状态在 data/state/mind/ 下；旧默认值用裸文件名，对 data/state 根跑会全部 missing。
// 同时纳入关系/社交/目标等 G4 关键文件（people.json 含 PII，但快照是本机私有备份）。
export const DEFAULT_STATE_FILES = Object.freeze([
  'mind/self-state.json', 'mind/beliefs.json', 'mind/state-hub.json', 'mind/kernel-state.json',
  'mind/identity-map.jsonl', 'mind/bonds.jsonl', 'mind/lessons-ledger.jsonl',
  'people.json', 'social-graph.json', 'group-members.json', 'goals.json', 'life.json',
]);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function safeJoin(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(rel || ''));
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`快照路径越界：${rel}`);
  return abs;
}

/**
 * @param {{root:string, dest:string, files?:string[], now?:number}} input
 * @returns {{v:number, at:number, root:string, dest:string, files:Array, missing:string[]}}
 */
export function createSnapshot({ root, dest, files = DEFAULT_STATE_FILES, now = Date.now() } = {}) {
  if (!root || !dest) throw new Error('createSnapshot 需要 root 与 dest');
  const srcRoot = path.resolve(root);
  const outDir = path.resolve(dest);
  fs.mkdirSync(outDir, { recursive: true });
  const entries = [];
  const missing = [];
  for (const rel of files) {
    const src = safeJoin(srcRoot, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) { missing.push(rel); continue; }
    const target = safeJoin(outDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, target);
    entries.push({ path: rel, size: fs.statSync(target).size, sha256: sha256(target) });
  }
  const manifest = { v: SNAPSHOT_VERSION, at: Number(now), root: srcRoot, files: entries, missing };
  const manifestFile = path.join(outDir, 'manifest.json');
  const tmpManifest = manifestFile + '.tmp';
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmpManifest, manifestFile);
  return { ...manifest, dest: outDir };
}

/** 只校验清单里列出的文件；missing 不进 mismatched（快照时可缺，恢复时提示）。 */
export function verifySnapshot({ dir } = {}) {
  const outDir = path.resolve(String(dir || ''));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  if (!manifest || manifest.v !== SNAPSHOT_VERSION) throw new Error('快照清单版本不支持');
  const mismatched = [];
  const missing = [];
  for (const entry of manifest.files || []) {
    const file = safeJoin(outDir, entry.path);
    if (!fs.existsSync(file)) { missing.push(entry.path); continue; }
    if (sha256(file) !== entry.sha256) mismatched.push(entry.path);
  }
  return { ok: mismatched.length === 0 && missing.length === 0, checked: (manifest.files || []).length, mismatched, missing, manifest };
}

/**
 * 从快照恢复；默认 dry-run。只恢复校验通过的文件；覆盖前给现有文件留 .bak-<at>。
 * @returns {{ok:boolean, dryRun:boolean, restored:string[], skipped:string[], verify:object}}
 */
export function restoreSnapshot({ dir, root, dryRun = true, at = Date.now() } = {}) {
  const verify = verifySnapshot({ dir });
  const restored = [];
  const skipped = [...verify.mismatched, ...verify.missing];
  if (!verify.ok) return { ok: false, dryRun, restored, skipped, verify };
  const targetRoot = path.resolve(String(root || ''));
  for (const entry of verify.manifest.files) {
    const src = safeJoin(path.resolve(String(dir)), entry.path);
    const target = safeJoin(targetRoot, entry.path);
    if (dryRun) { restored.push(entry.path); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak-${at}`);
    const tmp = target + '.tmp';
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, target);
    restored.push(entry.path);
  }
  return { ok: true, dryRun, restored, skipped, verify };
}
