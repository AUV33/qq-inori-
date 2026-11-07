// clean-member-names.mjs · 修复 QQ 彩色昵称造成的乱码（2026-10-30）
//
// 现象：群成员名字带控制码/配色码（例："\n\n\n\b&ÿÒUÐ\n \u0012\u001e示例角色"），
// 摘要按 12 字硬截后只剩「&ÿÒUÐ」，写进记忆库、people.json 别名，检索/注入时是噪声。
//
// 本脚本做两件事：
//   ① 存量数据：群成员档案、people 别名、记忆库（含 _archive）里的名字片段 → 可读名字；
//      记忆正文里残留的控制字符/配色码一并清掉。
//   ② 只读预览：默认 dry-run；--apply 才写，写前每个文件备份 .bak-nameclean-<ts>。
//
// 用法：
//   node qq-bridge/scripts/clean-member-names.mjs            # 预览
//   node qq-bridge/scripts/clean-member-names.mjs --apply    # 落盘
import fs from 'node:fs';
import path from 'node:path';
import { cleanMemberName } from '../src/domain/leaves/inori-memory-clean.js';
import { readPeopleFile, peopleWritePayloadForFile } from '../src/domain/shared/people-vault.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const APPLY = process.argv.includes('--apply');
const STATE = path.join(ROOT, 'data', 'state');
const MEM = path.join(ROOT, 'data', 'memory');
const TS = Date.now();
const JUNK = /[\u0000-\u001f\u007f-\u009f\u00ad\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\ue000-\uf8ff\ufffd]/g;
const JUNK_TEST = /[\u0000-\u001f\u007f-\u009f\u00ad\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\ue000-\uf8ff\ufffd]/;

/** 从原始名字生成可能出现在摘要里的片段：完整、12 字截断、去控制码、空白折叠 */
function variantsOf(raw) {
  const base = String(raw || '');
  const out = new Set();
  for (const s of [base, base.slice(0, 12)]) {
    if (s.length < 4) continue;
    out.add(s);
    out.add(s.replace(JUNK, ''));
    out.add(s.replace(JUNK, ' ').replace(/\s+/g, ' ').trim());
    out.add(s.replace(/\s+/g, ' ').trim());
  }
  return [...out].filter((s) => s.length >= 4);
}

function backup(file) {
  const bak = `${file}.bak-nameclean-${TS}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// ── ① 收集 原始名 → 可读名 ───────────────────────────────────────────────
const pairs = [];
const gmFile = path.join(STATE, 'group-members.json');
let gm = {};
try { gm = readPeopleFile(gmFile) || {}; } catch { gm = {}; }
let gmChanged = 0;
for (const g of Object.values(gm)) {
  for (const m of Object.values(g?.members || {})) {
    const raw = String(m?.name || '');
    if (!raw) continue;
    const clean = cleanMemberName(raw, { max: 24 });
    if (clean && clean !== raw) {
      pairs.push({ raw, clean, where: 'group-members', id: m.id });
      m.name = clean;
      gmChanged += 1;
    }
  }
}

const peopleFile = path.join(STATE, 'people.json');
const people = (() => { try { return readPeopleFile(peopleFile) || {}; } catch { return readJson(peopleFile) || {}; } })();
let peopleChanged = 0;
for (const p of Object.values(people)) {
  for (const [gkey, alias] of Object.entries(p?.aliases || {})) {
    const raw = String(alias || '');
    if (!raw) continue;
    const clean = cleanMemberName(raw, { max: 24 });
    if (clean && clean !== raw) {
      pairs.push({ raw, clean, where: 'people', id: p.id, group: gkey });
      p.aliases[gkey] = clean;
      peopleChanged += 1;
    }
  }
}

// 变体按长度降序，先替换长的，避免「12 字截断片段」把完整名字拆坏
const repl = [];
for (const { raw, clean } of pairs) {
  for (const v of variantsOf(raw)) repl.push({ v, clean });
}
repl.sort((a, b) => b.v.length - a.v.length);

// ── ② 记忆正文清洗 ──────────────────────────────────────────────────────
const COLOR_TOKEN = /(^|[\s/：])[&$%][\u0080-\u02ffA-Za-z]{1,8}(?=[\s：:/]|$)/g;
function cleanLine(text) {
  let s = String(text ?? '');
  const before = s;
  for (const { v, clean } of repl) {
    if (s.includes(v)) s = s.split(v).join(clean);
  }
  // 兜底：残控制码 / 配色码（只在确实有控制字符时动，避免误伤正常中英混排）
  if (JUNK_TEST.test(s)) {
    s = s.replace(JUNK, ' ');
    s = s.replace(COLOR_TOKEN, '$1');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/(^|[\/ ])\s*：/g, '$1：');
  }
  return s === before ? null : s;
}

const memFiles = [];
for (const sub of ['', '_archive']) {
  const dir = path.join(MEM, sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl') || f.includes('.bak')) continue;
    memFiles.push(path.join(dir, f));
  }
}

const report = { pairs: pairs.length, gmChanged, peopleChanged, memory: {}, samples: [], residual: 0, leftover: 0 };
for (const file of memFiles) {
  const rel = path.relative(MEM, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let obj;
    try { obj = JSON.parse(line); } catch { return line; }
    if (typeof obj?.text !== 'string') return line;
    const clean = cleanLine(obj.text);
    if (clean == null) return line;
    changed += 1;
    if (report.samples.length < 12) report.samples.push({ file: path.basename(file), before: obj.text.slice(0, 160), after: clean.slice(0, 160) });
    if (/[\u0000-\u001f\u007f-\u009f]/.test(clean)) report.residual += 1;
    if (/[&$%][\u0080-\u02ff]/.test(clean)) report.leftover += 1;
    obj.text = clean;
    return JSON.stringify(obj);
  });
  report.memory[rel] = changed;
  if (changed && APPLY) {
    backup(file);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out.join('\n'), 'utf8');
    fs.renameSync(tmp, file);
  }
}

// ── ③ 落盘元数据文件 ────────────────────────────────────────────────────
if (APPLY) {
  if (gmChanged) { backup(gmFile); writeJson(gmFile, peopleWritePayloadForFile(gmFile, gm)); }
  if (peopleChanged) { backup(peopleFile); writeJson(peopleFile, peopleWritePayloadForFile(peopleFile, people)); }
}

console.log(`[nameclean] ${APPLY ? 'APPLY' : 'DRY-RUN'}  名字对=${report.pairs} 群档案改=${report.gmChanged} people 别名改=${report.peopleChanged}`);
for (const [f, n] of Object.entries(report.memory)) if (n) console.log(`  ${f}: ${n} 条`);
if (report.residual) console.log(`  ⚠️ 仍有控制字符残留：${report.residual} 条`);
if (report.leftover) console.log(`  ⚠️ 疑似配色码残留（&/$/% + 拉丁扩展）：${report.leftover} 条`);
console.log('--- 样例 ---');
for (const s of report.samples) console.log(`[${s.file}]\n  旧: ${JSON.stringify(s.before)}\n  新: ${JSON.stringify(s.after)}`);
if (!APPLY) console.log('（预览模式，未写盘；加 --apply 落盘）');
