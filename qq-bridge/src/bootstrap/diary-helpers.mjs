// 每日日记的落盘小工具：尝试次数、追加、今日是否已写。
//
// 从 app.mjs 外提（2026-11-02，开放源码架构收敛）。只碰文件，不碰会话/调度；
// 日记正文由 main 捕获后调用 appendDailyDiary。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './fs-utils.mjs';

export function createDiaryHelpers({ dailyFile, desktopDir, attemptsFile, log }) {
  function diaryAttempts(day) {
    try { const o = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')); return Number(o?.[day]) || 0; } catch { return 0; }
  }

  function dropDiaryAttempt(day) {
    try {
      const o = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')) || {};
      o[day] = Math.max(0, (Number(o[day]) || 0) - 1);
      atomicWriteJson(attemptsFile, o);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'diary-helpers.mjs'); }
  }

  function bumpDiaryAttempts(day) {
    try {
      let o = {};
      try { o = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')) || {}; } catch { o = {}; }
      const keep = Object.fromEntries(Object.entries(o).filter(([k]) => k >= new Date(Date.now() - 14 * 86400000).toLocaleDateString('sv-SE')));
      keep[day] = (Number(keep[day]) || 0) + 1;
      fs.mkdirSync(path.dirname(attemptsFile), { recursive: true });
      atomicWriteJson(attemptsFile, keep);
      return keep[day];
    } catch { return 0; }
  }

  function appendDailyDiary(day, text) {
    try {
      fs.mkdirSync(path.dirname(dailyFile), { recursive: true });
      fs.appendFileSync(dailyFile, JSON.stringify({ day, at: new Date().toISOString(), text, source: 'bridge/diary-session' }) + '\n', 'utf8');
    } catch (error) { log(`[diary] 落盘失败: ${error?.message ?? error}`); }
    try {
      fs.mkdirSync(desktopDir, { recursive: true });
      const hm = new Date().toLocaleTimeString('sv-SE').slice(0, 5);
      fs.appendFileSync(path.join(desktopDir, `${day}.txt`), `\n━━━ 完整记录（${hm}）━━━\n${text}\n`, 'utf8');
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'diary-helpers.mjs'); }
  }

  function todayDiaryWritten(day) {
    try { return fs.readFileSync(dailyFile, 'utf8').split('\n').some((l) => l.includes(`"day":"${day}"`)); } catch { return false; }
  }

  return { diaryAttempts, dropDiaryAttempt, bumpDiaryAttempts, appendDailyDiary, todayDiaryWritten };
}
