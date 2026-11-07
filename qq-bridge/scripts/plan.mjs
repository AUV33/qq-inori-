// plan.mjs · 自改进化计划的「一条一个文件」存储 + CLI
//
// 为什么不再都写进 evolution-plan.md：多个会话会同时改同一个文件，
// 全文件替换式编辑会互相覆盖（实际撞过三次 "file changed since read"）。
// 现在每条计划 = data/state/plans/<id>.md，各自独立；完成流水 append 到 plans/DONE.md；
// evolution-plan.md 只留规则、历史与一个指针。
//
// 用法：
//   node scripts/plan.mjs list [--all]        # 默认只看进行中（todo/doing）
//   node scripts/plan.mjs new --title "..." [--body "..."]
//   node scripts/plan.mjs status <id> todo|doing|done|shelved
//   node scripts/plan.mjs show <id>
//
// 程序里 import 这些函数即可（本文件被 import 时不会跑 CLI）。
// 所有函数都接受 { root } 覆盖项目根，测试才能用临时目录跑。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const STATUSES = new Set(['todo', 'doing', 'done', 'shelved']);
const ACTIVE = new Set(['todo', 'doing']);

function paths(root = PROJECT_ROOT) {
  const dir = path.join(root, 'data', 'state', 'plans');
  return { dir, done: path.join(dir, 'DONE.md'), lock: path.join(dir, '.lock') };
}

function ensureDir(root) {
  fs.mkdirSync(paths(root).dir, { recursive: true });
}

/** 简易跨进程锁：wx 排他创建，2s 内重试；超过 10s 的陈旧锁直接清掉 */
export async function withLock(fn, { lockFile, waitMs = 2000, staleMs = 10_000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(lockFile); continue; }
      } catch { /* 锁刚被释放，重试 */ }
      if (Date.now() - started > waitMs) throw new Error(`拿不到计划锁（${lockFile}），稍后再试`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

function todayKey(d = new Date()) {
  return d.toLocaleDateString('sv-SE');
}

function newId() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${todayKey(d)}T${hh}${mm}${ss}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 条目文件：status/title/created/id 四行头 + --- + 正文 */
export function renderEntry({ id, title, status = 'todo', created = new Date().toISOString(), body = '' }) {
  return [
    `status: ${status}`,
    `title: ${String(title).replace(/\s+/g, ' ').trim()}`,
    `created: ${created}`,
    `id: ${id}`,
    '---',
    String(body).trim(),
    '',
  ].join('\n');
}

/** 解析条目文件；坏文件返回 null（不抛） */
export function parseEntry(text) {
  const s = String(text ?? '');
  const sep = s.indexOf('\n---');
  if (sep < 0) return null;
  const head = s.slice(0, sep).split('\n');
  const body = s.slice(sep + 4).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of head) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.title) return null;
  return {
    id: meta.id ?? '',
    title: meta.title,
    status: STATUSES.has(meta.status) ? meta.status : 'todo',
    created: meta.created ?? '',
    body,
  };
}

export function listPlans({ includeDone = false, root = PROJECT_ROOT } = {}) {
  ensureDir(root);
  const { dir } = paths(root);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'DONE.md'); } catch { return []; }
  const items = [];
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const e = parseEntry(text);
    if (!e) continue;
    e.file = path.join(dir, name);
    items.push(e);
  }
  // 默认只列「进行中」；done 与 shelved 都不算在跑，免得搁置项一直挂着当假进度。
  const filtered = includeDone ? items : items.filter((e) => ACTIVE.has(e.status));
  return filtered.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

export async function createPlan({ title, body = '', root = PROJECT_ROOT }) {
  const clean = String(title ?? '').trim();
  if (!clean) throw new Error('title 不能为空');
  ensureDir(root);
  const { dir } = paths(root);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newId();
    const file = path.join(dir, `${id}.md`);
    const text = renderEntry({ id, title: clean, body });
    try {
      fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
      return { id, file, entry: parseEntry(text) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('计划 id 连续撞车，稍后再试');
}

export function readPlan(id, { root = PROJECT_ROOT } = {}) {
  ensureDir(root);
  const safe = String(id ?? '').replace(/[^\w.-]/g, '');
  const file = path.join(paths(root).dir, `${safe}.md`);
  if (!fs.existsSync(file)) return null;
  const e = parseEntry(fs.readFileSync(file, 'utf8'));
  return e ? { ...e, file } : null;
}

export async function setStatus(id, status, { root = PROJECT_ROOT } = {}) {
  if (!STATUSES.has(status)) throw new Error(`status 只能是 ${[...STATUSES].join('/')}`);
  const item = readPlan(id, { root });
  if (!item) throw new Error(`找不到计划 ${id}`);
  const next = renderEntry({ ...item, status });
  const { lock, done } = paths(root);
  await withLock(() => {
    fs.writeFileSync(item.file, next, 'utf8');
    if (status === 'done') {
      // 完成流水是 append-only：不重写历史，谁先写谁在前，不会互相覆盖
      fs.appendFileSync(done, `- ${todayKey()} · ${item.id} · ${item.title}\n`, 'utf8');
    }
  }, { lockFile: lock });
  return { ...item, status };
}

// ── CLI ─────────────────────────────────────────────────────────────────
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function usage() {
  console.log([
    'node scripts/plan.mjs list [--all]        # 默认只看进行中（todo/doing）',
    'node scripts/plan.mjs new --title "..." [--body "..."]',
    'node scripts/plan.mjs status <id> todo|doing|done|shelved',
    'node scripts/plan.mjs show <id>',
  ].join('\n'));
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (isCli) {
  const [cmd, ...rest] = process.argv.slice(2);
  const argOf = (flag) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (cmd === 'list') {
      const items = listPlans({ includeDone: rest.includes('--all') });
      if (!items.length) console.log('（没有进行中的计划）');
      for (const it of items) console.log(`[${it.status}] ${it.id} · ${it.title}`);
    } else if (cmd === 'new') {
      const body = argOf('--body') ?? await readStdin();
      const r = await createPlan({ title: argOf('--title'), body });
      console.log(`已创建 ${r.id}`);
      console.log(r.file);
    } else if (cmd === 'status') {
      const [id, status] = rest;
      const r = await setStatus(id, status);
      console.log(`${r.id} → ${r.status}`);
    } else if (cmd === 'show') {
      const it = readPlan(rest[0]);
      if (!it) { console.error('没有这条计划'); process.exit(1); }
      console.log(`[${it.status}] ${it.id}\n${it.title}\n\n${it.body}`);
    } else {
      usage();
      process.exit(cmd ? 1 : 0);
    }
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
