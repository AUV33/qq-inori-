// diary-export.js · 把日记导出成桌面上的 txt（按天一个文件）
//
// 为什么单独一个模块：导出逻辑要同时被 MCP 工具和一次性回填脚本复用，
// 放一起会两边各写一份格式，迟早不一致。
//
// 目录：<用户主目录>\Desktop\日记导出\  （可用 DIARY_EXPORT_DIR 覆盖）
// 文件：<day>.txt，例如 2026-10-23.txt
// 格式（纯文本，人直接能读）：
//   # 2026-10-23（日记导出）
//
//   14:50  懒
//   下午拿到一只手机，说随便玩。…
//   ---
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 默认导出到当前用户的桌面；换位置设 DIARY_EXPORT_DIR 即可。
export const DEFAULT_EXPORT_DIR = path.join(os.homedir(), 'Desktop', '日记导出');

export function exportDir() {
  return process.env.DIARY_EXPORT_DIR || DEFAULT_EXPORT_DIR;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fmtEntry(e) {
  const hm = String(e.time ?? '').slice(-5); // "2026-10-23 14:50" → "14:50"
  const mood = e.mood ? `  ${e.mood}` : '';
  return `${hm || '--:--'}${mood}\n${e.text}\n`;
}

/** 一整天的内容 → 文本 */
export function renderDay(day, entries) {
  const head = `# ${day}（日记导出）\n\n`;
  const body = entries.map(fmtEntry).join('---\n');
  return head + body;
}

/** 把一条新日记追加进它那天的 txt（不存在就创建） */
export function appendEntry(entry, dir = exportDir()) {
  try {
    ensureDir(dir);
    const file = path.join(dir, `${entry.day}.txt`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, renderDay(entry.day, [entry]), 'utf8');
      return { ok: true, file, created: true };
    }
    // 已有文件：直接在末尾追加（保持追加语义，不重写历史）
    fs.appendFileSync(file, '---\n' + fmtEntry(entry), 'utf8');
    return { ok: true, file, created: false };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 全量回填：按 jsonl 重建每天的文件（幂等，可重复跑） */
export function exportAll(entries, dir = exportDir()) {
  try {
    ensureDir(dir);
    const byDay = new Map();
    for (const e of entries) {
      if (!e || !e.day) continue;
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day).push(e);
    }
    let written = 0;
    for (const [day, list] of byDay) {
      list.sort((a, b) => String(a.time).localeCompare(String(b.time)));
      fs.writeFileSync(path.join(dir, `${day}.txt`), renderDay(day, list), 'utf8');
      written++;
    }
    return { ok: true, dir, days: written, entries: entries.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
