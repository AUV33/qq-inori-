// 唤醒时临时递到眼前的几行「附加材料」。
//
// 从 app.mjs 的 main() 搬出（P3-1b，2026-10-31）：失败归纳、群里生词、遇到的东西
// 三块原来和会话调度焊在一起。它们只读状态、拼一段文本，不发送、不改业务状态
// （唯一写入的是 st.lastXxxShownAt 冷却时间戳），搬出来后可以用假状态独立单测。
//
// 纪律：
//   · 本模块不 import app.mjs、不持有桥接状态；
//   · cfg / 兴趣文件读取 / 日志 / 路径全部由调用方注入；
//   · 冷却时间写在传入的 st 上，和原来的字段名保持一致（lastFailureShownAt / lastGlossShownAt / lastEncounterShownAt）。
import { renderReflectDigest } from '../leaves/inori-failure-reflect.js';
import { load as loadLessons } from '../leaves/inori-lessons.js';
import { loadSlang } from '../social/slang-learner.js';
import { readLanguageEpisodes } from '../leaves/inori-language-episodes.js';
import { findUnknown, renderUnknown } from '../leaves/inori-gloss.js';
import { renderEncounterLine } from '../leaves/inori-interest.js';

/**
 * @param {object} deps
 * @param {() => object} deps.getCfg 当前配置（动态读，避免重启后才更新）
 * @param {() => object} deps.loadFailures 读失败账本
 * @param {() => object} deps.loadInterestEncounters 读 state/interest-encounters.json
 * @param {(...args: any[]) => void} deps.log 桥接日志
 * @param {string} deps.slangFile 黑话库路径
 * @param {string} deps.languageEpisodesFile 语言事件路径
 * @param {() => number} [deps.now] 时钟（测试可注入）
 */
export function createWakeExtraLines({
  getCfg,
  loadFailures,
  loadInterestEncounters,
  log,
  slangFile,
  languageEpisodesFile,
  now = () => Date.now(),
}) {
  // [FAIL-DIGEST] 唤醒里递「最近失败归纳」：20 分钟最多一次，没有失败就不占字。
  function wakeFailureLine(st, key, reason) {
    try {
      const at = now();
      if (st.lastFailureShownAt && at - Number(st.lastFailureShownAt) < 20 * 60_000) return '';
      const line = renderReflectDigest(loadFailures(), { now: at });
      if (!line) return '';
      st.lastFailureShownAt = at;
      log(`[fail-digest] ${key} ${line.slice(0, 120)}`);
      return `【最近卡在哪】${line}（不是要你汇报，是让你知道最近失败是不是同一种原因；看着烦就先放着。）\n\n`;
    } catch { return ''; }
  }

  // [GLOSS-ON-ACTIVITY] 有动静时把「群里冒出的生词」递到眼前（模块级 helper：基底不放注入层）。
  function wakeGlossLine(st, key, reason) {
    try {
      const root = String(reason).split(':')[0];
      if (!String(key).startsWith('group:')) return ''; // 私聊里的"生词"多半是主人自己的话/控制台提醒，不是黑话
      const at = now();
      if (root === 'bootstrap') return '';
      if (st.lastGlossShownAt && at - Number(st.lastGlossShownAt) < 30 * 60 * 1000) return '';
      let known = '';
      try { known = loadLessons(getCfg()?.socialV2?.lessons?.file).map((x) => x.text).join('\n'); } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-extra-lines.mjs:57'); }
      try {
        const slang = loadSlang(slangFile).filter((e) => e.content);
        if (slang.length) known += '\n' + slang.map((e) => `${e.content} ${e.meaning ?? ''}`).join('\n');
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-extra-lines.mjs:61'); }
      // [GLOSS-LANGUAGE] qq_language_note 记过的 phrase 也算“认识”：否则同一个词
      // 在语言事件里已经写过含义，gloss 仍会把它当生词再推荐去搜一次。
      try {
        const eps = readLanguageEpisodes(languageEpisodesFile, { limit: 300 });
        const phrases = eps.map((e) => `${e?.phrase ?? ''} ${e?.context ?? ''} ${e?.meaning ?? ''}`).filter((s) => s.trim());
        if (phrases.length) known += '\n' + phrases.join('\n');
      } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'wake-extra-lines.mjs:68'); }
      const unk = findUnknown(Array.isArray(st.recentMessages) ? st.recentMessages : [], known, { minMessages: 2, limit: 6 });
      const line = renderUnknown(unk);
      if (!line) return '';
      st.lastGlossShownAt = at;
      log(`[gloss] ${key} 唤醒里带上 ${unk.length} 个生词：${unk.map((x) => x.term).join(',')}`);
      return '【群里冒出的生词】' + line + '\n\n';
    } catch { return ''; }
  }

  // [INTEREST] 有动静时把「她遇到的东西」递到眼前（模块级 helper：基底不放注入层）。
  function wakeEncounterLine(st, key, reason) {
    try {
      const root = String(reason).split(':')[0];
      if (root === 'bootstrap') return '';
      const at = now();
      if (st.lastEncounterShownAt && at - Number(st.lastEncounterShownAt) < 30 * 60 * 1000) return '';
      const line = renderEncounterLine(loadInterestEncounters(), at);
      if (!line) return '';
      st.lastEncounterShownAt = at;
      return line + '\n\n';
    } catch { return ''; }
  }

  return { wakeFailureLine, wakeGlossLine, wakeEncounterLine };
}
