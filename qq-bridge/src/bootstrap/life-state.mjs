// 她的生活状态：加载/迁移/兴趣/生理 tick/唤醒注入头。
//
// 从 app.mjs 外提（2026-11-02，开放源码架构收敛）。状态由本模块持有，
// app 通过 get()/note()/touchInterest()/startPhysTimer() 使用；inori-lifestate 仍是纯逻辑。
import {
  loadLifeState, saveLifeState, transition as lifeTransition, physTick as lifePhysTick,
  markInterest, renderLifeLine, renderCuriosityDrive, renderTimeLine,
} from '../domain/leaves/inori-lifestate.js';

export function createLifeState({ log, getLastIncomingAt }) {
  let state = loadLifeState();

  function get() { return state; }
  function set(next) { state = next; }

  function note(ev, opts = {}) {
    try {
      state = lifeTransition(state, ev, Date.now());
      saveLifeState(state);
      if (opts.log) log(`[life] ${opts.log}`);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'life-state.mjs'); }
  }

  function touchInterest() {
    try {
      state = markInterest(state);
      saveLifeState(state);
    } catch (error) { /* best-effort */ globalThis.__ignoredCatch?.(error, 'life-state.mjs'); }
  }

  function startPhysTimer() {
    const t = setInterval(() => {
      try {
        const r = lifePhysTick(state, Date.now(), { quietForMs: Date.now() - Number(getLastIncomingAt() || 0) });
        state = r.state;
        for (const e of r.events) {
          if (e.type === 'auto_sleep') {
            const forced = e.origin === 'force';
            log(`[life] 她${forced ? '累到顶了、强制小睡' : '自然睡过去了'}（困意 ${Math.round(e.drowsy * 100)}%，债 ${e.debt}${forced ? '，20 分钟没人找她' : ''}）`);
          }
          if (e.type === 'auto_wake') log(`[life] 她自然醒了（睡了 ${e.hours}h，剩余债 ${e.debt}）`);
          if (e.type === 'day_rollover') log(`[life] 跨天：作息偏移累计 ${e.driftDays} 天`);
        }
        saveLifeState(state);
      } catch (error) { log(`[life] 生理 tick 失败（已忽略）: ${error?.message ?? error}`); }
    }, 5 * 60000);
    if (typeof t.unref === 'function') t.unref();
  }

  /** [LIFE] 唤醒注入的头部：时间段语义 + 她的生活状态（两段一起，缺一段不影响另一段） */
  function lifeTimePre() {
    const t = renderTimeLine();
    let l = '';
    try { l = renderLifeLine(state); } catch { l = ''; }
    let cd = '';
    try { cd = renderCuriosityDrive(state) ?? ''; } catch { cd = ''; }
    return [t, l, cd].filter(Boolean).join('\n');
  }

  return { get, set, note, touchInterest, startPhysTimer, lifeTimePre };
}
