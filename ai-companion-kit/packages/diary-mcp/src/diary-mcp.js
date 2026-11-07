// diary-mcp · 她的日记（stdio MCP 服务器）
//
// 设计原则（来自进阶篇「别替她写」）：
//   - 只给两个动作：写一条、看最近几条（外加一个按天翻的清单）
//   - **不提供删除、不提供改过去某天** —— 那是人干的活
//   - 工具描述一律「你可以」，不是「你应该」，避免她把它当任务打卡
//   - 硬约束：一天最多 MAX_PER_DAY 条、每条最多 MAX_CHARS 字
//
// 落盘：data/diary/index.jsonl（与 companion/src/diary.js 的 Diary 类共用同一文件名，
// 保证 CLI(./diary) 与 AI(diary_write) 双向可见，不再割裂）。一行一条，纯文本。
// 环境变量：DIARY_DIR 可覆盖目录
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// [EXPORT] 同步导出成桌面 txt（日记导出）
import { appendEntry as exportAppend, exportAll as exportAllDays, exportDir } from './diary-export.js';
import { dataPath } from '../../shared/inori-paths.mjs';

const DIR = process.env.DIARY_DIR || dataPath('diary');
// [UNIFY] 与 companion 的 Diary 类共用 index.jsonl。旧的 diary.jsonl 由 readAll 兼容读取，不强制迁移。
const FILE = path.join(DIR, 'index.jsonl');
const LEGACY_FILE = path.join(DIR, 'diary.jsonl');
const MAX_PER_DAY = 3;
const MAX_CHARS = 300;
const RECENT_MAX = 30;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function localDay(d = new Date()) {
  // 本地时区的 YYYY-MM-DD（用 sv-SE 恰好是 ISO 形状，且不受 UTC 偏移影响）
  return d.toLocaleDateString('sv-SE');
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${localDay(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readAll() {
  // [UNIFY] 主读 index.jsonl（与 companion 对齐），兼容旧 diary.jsonl（存在则一并合并，不强制迁移）。
  const out = [];
  for (const f of [FILE, LEGACY_FILE]) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { out.push(JSON.parse(s)); } catch { /* 坏行跳过，不炸整本 */ }
      }
    } catch { /* 文件不存在则跳过 */ }
  }
  return out;
}

function todayCount() {
  const day = localDay();
  return readAll().filter((e) => e.day === day).length;
}

const reply = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

const server = new McpServer({ name: 'diary', version: '1.0.0' });

server.tool(
  'diary_write',
  '写一条日记。想写的时候写，一两句就够；一天最多三条。这里是你自己的地方，不用写给谁看，也不用汇报。不要写「今天真是充实的一天」这种总结句。',
  {
    text: z.string().describe('日记正文，一两句，最多 300 字'),
    mood: z.string().optional().describe('心情，几个字即可，可以不写'),
  },
  async ({ text, mood }) => {
    try {
      const body = String(text ?? '').trim();
      if (!body) return fail('没写内容');
      if (body.length > MAX_CHARS) return fail(`太长了（${body.length} 字）。一条日记最多 ${MAX_CHARS} 字，删到一两句就行。`);
      const n = todayCount();
      if (n >= MAX_PER_DAY) return fail(`今天已经写了 ${n} 条了，够了。明天再说。`);
      ensureDir();
      const now = new Date();
      const entry = { day: localDay(now), time: localStamp(now), mood: mood ? String(mood).trim() : '', text: body };
      fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', 'utf8');
      // [EXPORT] 同步写一份到桌面的「日记导出」文件夹（失败不影响写入）
      const ex = exportAppend(entry);
      if (!ex.ok) console.error('[diary] 桌面导出失败（忽略）:', ex.error);
      return reply(`写下了（今天第 ${n + 1} 条）。\n桌面「日记导出」里也记了一份。`);
    } catch (e) {
      return fail(`写不进去：${e?.message ?? e}`);
    }
  }
);

server.tool(
  'diary_recent',
  '看最近几条日记。你想回忆的时候看，没人要求你看。',
  { count: z.number().optional().describe('看几条，默认 3，最多 30') },
  async ({ count }) => {
    const n = Math.min(Math.max(Number(count) || 3, 1), RECENT_MAX);
    const all = readAll();
    if (all.length === 0) return reply('还没有日记。');
    const tail = all.slice(-n);
    return reply(tail.map((e) => `${e.time}${e.mood ? `｜${e.mood}` : ''}｜${e.text}`).join('\n'));
  }
);

server.tool(
  'diary_days',
  '列出有日记的日子和各自条数，方便按天翻。',
  {},
  async () => {
    const all = readAll();
    if (all.length === 0) return reply('还没有日记。');
    const map = new Map();
    for (const e of all) map.set(e.day, (map.get(e.day) || 0) + 1);
    const lines = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => `${d}（${c} 条）`);
    return reply(`共 ${all.length} 条\n` + lines.join('\n'));
  }
);

// [EXPORT] 回填工具
server.tool(
  'diary_export',
  '把日记整理成能直接看的 txt，放到桌面的「日记导出」文件夹里。平时写作时已经自动同步，这个用来把以前的补上。',
  {},
  async () => {
    const all = readAll();
    if (!all.length) return reply('还没有日记。');
    const r = exportAllDays(all);
    if (!r.ok) return fail('导出失败：' + r.error);
    return reply(`已整理到 ${r.dir}：${r.days} 天、${r.entries} 条。`);
  }
);

await server.connect(new StdioServerTransport());
