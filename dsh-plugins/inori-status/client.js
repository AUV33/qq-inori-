/**
 * Client half of the companion status panel.
 *
 * Registers one sidebar icon (`sidebar.panellist`) and the page it opens
 * (`main`, keyed by the same id). The page follows the classic dashboard rule
 * — one screen, one job, most important thing first — so it is a small rail of
 * five focused views instead of one long wall of cards:
 *
 *   现在   what she is doing right now      (fits one screen)
 *   状态   how she is                        (meters, feelings, voice)
 *   关系   who she is with                   (sessions, groups, wake, slang)
 *   脑子   what she concluded                (cognition, rules, people, goals)
 *   记录   what she wrote and spent          (diary, summary, usage)
 *
 * Nothing is duplicated across views: every concept appears exactly once.
 */
window.__ModuleLoader__.load({
  id: '@local/inori-status',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Must match the panel id `index.js` and the sidebar dispatcher use. */
    const PANEL_ID = 'inori-status'
    const ENDPOINT = '/inori-status/state.json'
    const DEBUG_STATE = '/inori-status/debug.json'
    const DEBUG_ACTION = '/inori-status/debug/action'
    const REFRESH_MS = 15000

    const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'affection', 'curiosity']

    const zh = {
      nav: 'AI 伙伴',
      title: 'AI 伙伴',
      subtitle: '状态面板',
      refresh: '刷新',
      loading: '正在读取…',
      error: '读取失败',
      'error.hint': '请确认桥接在跑，且数据目录可读。',
      updated: '更新于 {time}',
      'bridge.online': '桥接在线',
      'bridge.offline': '桥接离线',
      empty: '暂时没有',
      more: '还有 {n} 条',
      less: '收起',
      expand: '展开全文',

      'nav.now': '现在',
      'nav.state': '状态',
      'nav.social': '关系',
      'nav.mind': '脑子',
      'nav.log': '记录',
      'nav.debug': '调试',

      'debug.model': '当前模型',
      'debug.provider': '供应商',
      'debug.modelname': '模型',
      'debug.effort': '思考强度',
      'debug.runtime': '运行状态',
      'debug.dsh': 'DSH',
      'debug.onebot': 'OneBot',
      'debug.paused': '二代 AI',
      'debug.paused.on': '已暂停',
      'debug.paused.off': '在跑',
      'debug.mode': '运行模式',
      'debug.confirm': '切到 {label}？',
      'debug.confirm.pause': '暂停她？暂停后不再唤醒、不再等待消息。',
      'debug.confirm.resume': '恢复她？会重新开始唤醒和等待。',
      'debug.doConfirm': '确认',
      'debug.cancel': '取消',
      'debug.notModel': '模型和供应商改不了：桥接只在启动时读它们，要换得改 config.json 再重启桥接。思考强度和运行模式是热的。',
      'debug.whitelist': '{groups} 个群 · {private} 个私聊在白名单',
      'debug.consoleDown': '控制台连不上（3100）：{error}',
      'debug.reload': '重新读取',
      'debug.needsRestart': '调试路由还没加载：Host 端改过代码，重启一次 DSH 才会出现。',
      'debug.global': '改思考强度会同时写 DSH 全局默认，影响 Web GUI 新会话。',

      'now.energy': '精力',
      'now.mood': '心情',
      'now.hunger': '想说话',
      'now.warmth': '亲近',
      'now.plan': '今天的安排',
      'now.actions': '最近的动作',
      'now.emptyPlan': '今天没排什么',
      'now.emptyActions': '还没有动作',
      'now.done': '做完了',

      'state.metrics': '状态',
      'state.metrics.meta': '{time} 测的',
      'state.affect': '此刻的情绪',
      'state.style': '说话的样子',
      'state.calm': '现在没什么明显的起伏',
      'state.offline': '她不在的时候',
      'state.away': '离开 {n} 小时',
      'state.recv': '收到 {n}',
      'state.sent': '发出 {n}',

      'm.energy': '精力',
      'm.sleepDebt': '欠的觉',
      'm.socialHunger': '想说话',
      'm.curiosity': '好奇',
      'm.competence': '掌握感',
      'm.stress': '压力',
      'm.mood': '心情',
      'm.valence': '情绪值',
      'm.arousal': '兴奋',
      'f.joy': '喜',
      'f.sadness': '哀',
      'f.anger': '怒',
      'f.fear': '惧',
      'f.affection': '亲',
      'f.curiosity': '奇',

      'style.avg': '平均 {n} 字',
      'style.emoji': '表情 {n}%',
      'style.question': '提问 {n}%',
      'style.samples': '{n} 条样本',
      'style.insufficient': '样本还太少',

      'social.sessions': '会话',
      'social.sessions.meta': '{n} 个',
      'social.groups': '群里的人',
      'social.groups.meta': '{groups} 个群 · {pairs} 对关系',
      'social.pairs': '{n} 对',
      'social.dominant': '此刻',
      'social.nomood': '平静',
      'social.wake': '唤醒',
      'social.wake.meta': '{n} 个在听',
      'social.wake.count': '{n} 次',
      'social.wake.p': '{n}%',
      'social.slang': '群聊黑话',
      'social.slang.meta': '{n} 条 · {c} 条确认',
      'social.anon': '匿名',
      'mode.diving': '潜水',
      'mode.active': '正常',

      'mind.cognition': '最近想明白的',
      'mind.lessons': '攒下来的规矩',
      'mind.lessons.meta': '{n} 条',
      'mind.beliefs': '对人的判断',
      'mind.beliefs.plain': '{n} 个人记到现在，信任和亲近都还停在 0.50——还没有谁特别。',
      'mind.beliefs.meta': '{n} 个人 · {g} 个群',
      'mind.trust': '信任',
      'mind.affinity': '亲近',
      'mind.encounters': '{n} 次',
      'mind.goals': '惦记的事',
      'mind.goals.done': '最近做完的',
      'mind.goals.progress': '{n} 条进展',
      'kind.about-him': '关于他',
      'kind.about-group': '关于群',
      'kind.about-world': '关于外面',
      'kind.general': '一般',

      'log.diary': '日记',
      'log.diary.meta': '最近 {n} 条',
      'log.daily': '今天的小结',
      'log.usage': '今天用了多少',
      'log.usage.meta': '{n} 轮',
      'log.tokens': '输入 {a} · 缓存 {c} · 输出 {o}',
      'log.tools': '常用的工具',
      'log.tools.meta': '{ok} 成 / {fail} 败',
      'log.memory': '{n} 条记忆 · {s} 个来源',

      'act.replied': '回了',
      'act.skipped': '没回',
      'act.cancelled': '半路掐了',
      'act.closed': '说完了',
      'act.check': '主动看了一眼',
      'act.wake': '调了作息',
      'act.diary': '写了日记',
      'act.stash': '先把话存着',
      'act.slang': '理了理黑话库',
      'act.other': '其他',
      'act.private': '私聊',
      'act.group': '群聊',

      'footer.root': '数据来自 {root}',
      'ago.now': '刚刚',
      'ago.min': '{n} 分钟前',
      'ago.hour': '{n} 小时前',
      'ago.day': '{n} 天前',
    }

    const en = {
      nav: 'Companion',
      title: 'Companion',
      subtitle: 'Status',
      refresh: 'Refresh',
      loading: 'Loading…',
      error: 'Could not read the status',
      'error.hint': 'Check that the bridge is running and the data folder is readable.',
      updated: 'Updated {time}',
      'bridge.online': 'Bridge online',
      'bridge.offline': 'Bridge offline',
      empty: 'Nothing yet',
      more: '{n} more',
      less: 'Show less',
      expand: 'Read in full',

      'nav.now': 'Now',
      'nav.state': 'State',
      'nav.social': 'People',
      'nav.mind': 'Mind',
      'nav.log': 'Log',
      'nav.debug': 'Debug',

      'debug.model': 'Current model',
      'debug.provider': 'Provider',
      'debug.modelname': 'Model',
      'debug.effort': 'Reasoning',
      'debug.runtime': 'Runtime',
      'debug.dsh': 'DSH',
      'debug.onebot': 'OneBot',
      'debug.paused': 'Second-gen AI',
      'debug.paused.on': 'paused',
      'debug.paused.off': 'running',
      'debug.mode': 'Mode',
      'debug.confirm': 'Switch to {label}?',
      'debug.confirm.pause': 'Pause her? No more wake-ups or waiting.',
      'debug.confirm.resume': 'Resume her? Wake-ups and waits restart.',
      'debug.doConfirm': 'Confirm',
      'debug.cancel': 'Cancel',
      'debug.notModel': 'Model and provider cannot switch here: the bridge reads them only at startup, so changing them means editing config.json and restarting the bridge. Reasoning effort and mode are hot.',
      'debug.whitelist': '{groups} groups · {private} private chats allowed',
      'debug.consoleDown': 'Console unreachable (3100): {error}',
      'debug.reload': 'Reload',
      'debug.needsRestart': 'The debug route is not loaded yet: the Host changed, restart DSH once.',
      'debug.global': 'Changing effort also writes the DSH global default, so new Web GUI sessions follow it.',

      'now.energy': 'Energy',
      'now.mood': 'Mood',
      'now.hunger': 'Wants to talk',
      'now.warmth': 'Warmth',
      'now.plan': "Today's plan",
      'now.actions': 'Recent actions',
      'now.emptyPlan': 'Nothing planned today',
      'now.emptyActions': 'No actions yet',
      'now.done': 'Done',

      'state.metrics': 'State',
      'state.metrics.meta': 'measured {time}',
      'state.affect': 'Feelings right now',
      'state.style': 'How she talks',
      'state.calm': 'Nothing much moving right now',
      'state.offline': 'While she was away',
      'state.away': 'Away {n} hours',
      'state.recv': 'Received {n}',
      'state.sent': 'Sent {n}',

      'm.energy': 'Energy',
      'm.sleepDebt': 'Sleep debt',
      'm.socialHunger': 'Wants to talk',
      'm.curiosity': 'Curiosity',
      'm.competence': 'Competence',
      'm.stress': 'Stress',
      'm.mood': 'Mood',
      'm.valence': 'Valence',
      'm.arousal': 'Arousal',
      'f.joy': 'Joy',
      'f.sadness': 'Sad',
      'f.anger': 'Anger',
      'f.fear': 'Fear',
      'f.affection': 'Affection',
      'f.curiosity': 'Curious',

      'style.avg': '{n} chars avg',
      'style.emoji': 'emoji {n}%',
      'style.question': 'questions {n}%',
      'style.samples': '{n} samples',
      'style.insufficient': 'Too few samples',

      'social.sessions': 'Sessions',
      'social.sessions.meta': '{n}',
      'social.groups': 'Inside the groups',
      'social.groups.meta': '{groups} groups · {pairs} pairs',
      'social.pairs': '{n} pairs',
      'social.dominant': 'now',
      'social.nomood': 'calm',
      'social.wake': 'Wake-up',
      'social.wake.meta': '{n} listening',
      'social.wake.count': '{n} times',
      'social.wake.p': '{n}%',
      'social.slang': 'Group slang',
      'social.slang.meta': '{n} terms · {c} confirmed',
      'social.anon': 'anonymous',
      'mode.diving': 'diving',
      'mode.active': 'active',

      'mind.cognition': 'Worked out lately',
      'mind.lessons': 'Rules she keeps',
      'mind.lessons.meta': '{n}',
      'mind.beliefs': 'What she thinks of people',
      'mind.beliefs.plain': '{n} people tracked so far, all still at the same 0.50 — nobody stands out yet.',
      'mind.beliefs.meta': '{n} people · {g} groups',
      'mind.trust': 'trust',
      'mind.affinity': 'affinity',
      'mind.encounters': '{n}',
      'mind.goals': 'On her mind',
      'mind.goals.done': 'Recently finished',
      'mind.goals.progress': '{n} updates',
      'kind.about-him': 'About him',
      'kind.about-group': 'About groups',
      'kind.about-world': 'About the world',
      'kind.general': 'General',

      'log.diary': 'Diary',
      'log.diary.meta': 'last {n}',
      'log.daily': 'Latest summary',
      'log.usage': 'Usage today',
      'log.usage.meta': '{n} turns',
      'log.tokens': 'in {a} · cache {c} · out {o}',
      'log.tools': 'Tools used',
      'log.tools.meta': '{ok} ok / {fail} failed',
      'log.memory': '{n} memories · {s} sources',

      'act.replied': 'Replied',
      'act.skipped': 'Stayed quiet',
      'act.cancelled': 'Cut short',
      'act.closed': 'Wrapped up',
      'act.check': 'Checked in',
      'act.wake': 'Adjusted wake-up',
      'act.diary': 'Wrote the diary',
      'act.stash': 'Stashed a message',
      'act.slang': 'Tidied the slang list',
      'act.other': 'Other',
      'act.private': 'Private',
      'act.group': 'Group',

      'footer.root': 'Data from {root}',
      'ago.now': 'just now',
      'ago.min': '{n} min ago',
      'ago.hour': '{n} h ago',
      'ago.day': '{n} d ago',
    }

    /** Bound in `apply`; components live in factory scope and close over it. */
    let t = (key) => key

    const CSS = `
.isi-root { display: flex; height: 100%; min-height: 0; box-sizing: border-box; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.isi-rail { flex: none; width: 168px; box-sizing: border-box; padding: 20px 10px; border-right: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 1px; }
.isi-rail-brand { padding: 0 8px 16px; font-size: 16px; font-weight: 600; }
.isi-rail-note { padding: 0 8px 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); letter-spacing: 0.06em; text-transform: uppercase; }
.isi-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 16px; text-align: left; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.isi-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.isi-tab.on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }
.isi-rail-foot { margin-top: auto; padding: 12px 8px 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.isi-page { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 24px 30px 64px; box-sizing: border-box; }
.isi-wrap { max-width: 820px; margin: 0 auto; }
.isi-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.isi-title { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.25; }
.isi-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 7px; font-size: 14px; color: var(--dsw-alias-label-secondary); }
.isi-pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; font-size: 12px; }
.isi-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.isi-dot.on { background: var(--dsw-alias-state-success-primary); }
.isi-btn { flex: none; appearance: none; cursor: pointer; font: inherit; font-size: 14px; padding: 4px 11px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); }
.isi-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.isi-btn:disabled { opacity: 0.5; cursor: default; }

.isi-strip { display: flex; align-items: stretch; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; margin-bottom: 26px; }
.isi-stat { flex: 1 1 0; padding: 11px 14px; min-width: 0; }
.isi-stat + .isi-stat { border-left: 1px solid var(--dsw-alias-border-l1); }
.isi-stat-k { font-size: 12px; letter-spacing: 0.05em; color: var(--dsw-alias-label-secondary); }
.isi-stat-v { margin-top: 5px; font-size: 24px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }

.isi-block { margin-bottom: 30px; }
.isi-block-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding-bottom: 7px; border-bottom: 1px solid var(--dsw-alias-border-l1); margin-bottom: 6px; }
.isi-block-h h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
.isi-block-h span { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }

.isi-row { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; font-size: 16px; line-height: 1.6; }
.isi-row + .isi-row { border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent); }
.isi-t { flex: none; width: 88px; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.isi-cell { flex: 1 1 auto; min-width: 0; }
.isi-meta { flex: none; font-size: 14px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.isi-sub2 { font-size: 14px; color: var(--dsw-alias-label-secondary); }
.isi-term { font-weight: 600; margin-right: 6px; }
.isi-done { color: var(--dsw-alias-label-secondary); }
.isi-strong { color: var(--dsw-alias-label-primary); font-weight: 600; }

.isi-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 16px; }
.isi-meter { min-width: 0; }
.isi-meter-k { font-size: 12px; color: var(--dsw-alias-label-secondary); display: flex; justify-content: space-between; gap: 6px; }
.isi-meter-bar { height: 3px; margin-top: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.isi-meter-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); }

.isi-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; }
.isi-chip { display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; font-size: 14px; }
.isi-chip b { font-weight: 600; font-variant-numeric: tabular-nums; }

.isi-pre { white-space: pre-wrap; font-size: 16px; line-height: 1.75; padding: 6px 0; }
.isi-clamped { display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.isi-clamped2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.isi-morebtn { appearance: none; border: 0; background: transparent; padding: 2px 0; font: inherit; font-size: 14px; color: var(--dsw-alias-label-secondary); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.isi-morebtn:hover { color: var(--dsw-alias-label-primary); }
.isi-empty { padding: 7px 0; font-size: 16px; color: var(--dsw-alias-label-secondary); }
.isi-err { margin-bottom: 18px; padding: 9px 12px; border-radius: 8px; font-size: 15px; line-height: 1.5; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.isi-grouphead { margin-top: 10px; font-size: 14px; color: var(--dsw-alias-label-secondary); }
.isi-grouphead:first-child { margin-top: 2px; }
.isi-opt { appearance: none; cursor: pointer; font: inherit; font-size: 13px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); }
.isi-opt:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.isi-opt.on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); font-weight: 600; }
.isi-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 8px; margin-bottom: 22px; font-size: 14px; }
`

    function StatusIcon(props) {
      const size = props && Number.isFinite(props.size) && props.size > 0 ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 9, y: 2.5, width: 6, height: 10, rx: 3, fill: 'currentColor' }),
        h('path', { d: 'M6 11.5a6 6 0 0 0 12 0', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { d: 'M12 17.5V21', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
      )
    }

    /* ------------------------------------------------------------- primitives */

    function Block(props) {
      return h(
        'section',
        { className: 'isi-block' },
        h('header', { className: 'isi-block-h' }, h('h2', null, props.title), props.meta ? h('span', null, props.meta) : null),
        props.children,
      )
    }

    function Row(props) {
      return h(
        'div',
        { className: 'isi-row' },
        props.time ? h('span', { className: `isi-t${props.strong ? ' isi-strong' : ''}` }, props.time) : null,
        h('div', { className: 'isi-cell' }, props.children),
        props.meta ? h('span', { className: 'isi-meta' }, props.meta) : null,
      )
    }

    function Meter(props) {
      const ratio = typeof props.ratio === 'number' ? Math.max(0, Math.min(1, props.ratio)) : 0
      return h(
        'div',
        { className: 'isi-meter' },
        h('div', { className: 'isi-meter-k' }, h('span', null, props.label), h('span', null, `${Math.round(ratio * 100)}%`)),
        h('div', { className: 'isi-meter-bar' }, h('i', { style: { width: `${Math.round(ratio * 100)}%` } })),
      )
    }

    /** Progressive disclosure: the first N rows stay put, the rest wait here. */
    function Fold(props) {
      const [open, setOpen] = React.useState(false)
      const items = props.items || []
      if (!items.length) return null
      return h(
        'div',
        null,
        open ? items.map(props.render) : null,
        h(
          'button',
          { type: 'button', className: 'isi-morebtn', onClick: () => setOpen(!open) },
          open ? t('less') : t('more', { n: items.length }),
        ),
      )
    }

    function Clamp(props) {
      const [open, setOpen] = React.useState(false)
      const text = typeof props.text === 'string' ? props.text : ''
      if (!text.trim()) return null
      return h(
        'div',
        null,
        h('div', { className: `isi-pre${open ? '' : ` isi-${props.lines || 'clamped'}`}` }, text),
        text.length > (props.threshold || 160)
          ? h('button', { type: 'button', className: 'isi-morebtn', onClick: () => setOpen(!open) }, open ? t('less') : t('expand'))
          : null,
      )
    }

    /* ---------------------------------------------------------------- helpers */

    function pct(value) {
      return typeof value === 'number' ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : '—'
    }

    function num(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`
      return String(Math.round(value))
    }

    function clock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** HH:mm today, MM-DD HH:mm before that, so an old log stays readable. */
    function stamp(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const date = new Date(ms)
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
      return sameDay ? hhmm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`
    }

    function ago(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const diff = Date.now() - ms
      if (diff < 60000) return t('ago.now')
      const minutes = Math.floor(diff / 60000)
      if (minutes < 60) return t('ago.min', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('ago.hour', { n: hours })
      return t('ago.day', { n: Math.floor(hours / 24) })
    }

    function displayKey(key, t) {
      if (typeof key !== 'string' || !key) return t('empty')
      if (key.indexOf('group:') === 0) return `${t('act.group')} ${key.slice(6)}`
      if (key.indexOf('private:') === 0) return `${t('act.private')} ${key.slice(8)}`
      if (key.indexOf('internal:') === 0) return key.slice(9)
      return key
    }

    function actionLabel(action, t) {
      const key = action && typeof action.key === 'string' ? action.key : ''
      const id = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : ''
      const kind = key.indexOf('group:') === 0 ? t('act.group') : t('act.private')
      let verb = t('act.other')
      if (!action) verb = t('act.other')
      else if (action.t === 'turn') {
        if (action.outcome === 'sent') verb = t('act.replied')
        else if (action.outcome === 'closed') verb = t('act.closed')
        else verb = t('act.skipped')
      } else if (action.t === 'turn_cancel') verb = t('act.cancelled')
      else if (action.t === 'proactive_check') verb = t('act.check')
      else if (action.t === 'wake_config') verb = t('act.wake')
      else if (action.t === 'diary') verb = t('act.diary')
      else if (action.t === 'busy_stash') verb = t('act.stash')
      else if (action.t === 'slang') verb = t('act.slang')
      return id ? `${verb} · ${kind} ${id}` : verb
    }

    function kindLabel(kind, t) {
      const key = `kind.${kind}`
      const label = t(key)
      return label === key ? kind : label
    }

    function modeLabel(mode, t) {
      if (!mode) return ''
      const key = `mode.${mode}`
      const label = t(key)
      return label === key ? mode : label
    }

    /** Loudest of the six feelings; below this it reads as calm. */
    function dominantEmotion(row) {
      let best = null
      for (const emotion of EMOTIONS) {
        const value = row && row[emotion]
        if (typeof value === 'number' && (!best || value > best.value)) best = { emotion, value }
      }
      return best && best.value >= 0.02 ? best : null
    }

    /** People whose judgement moved off the 0.50 seed; the rest is noise. */
    function notablePeople(beliefs) {
      const rows = (beliefs && beliefs.topPeople) || []
      return rows.filter((person) => Math.abs((person.trust || 0.5) - 0.5) > 0.001 || Math.abs((person.affinity || 0.5) - 0.5) > 0.001)
    }

    function nextPlanItem(plan) {
      if (!plan || !plan.items) return null
      return plan.items.find((item) => !item.done) || null
    }

    /* ------------------------------------------------------------- view bodies */

    function nowBody(data, t) {
      const self = data.self || {}
      const talk = data.talk || {}
      const strip = h(
        'div',
        { className: 'isi-strip', key: 'strip' },
        h('div', { className: 'isi-stat' }, h('div', { className: 'isi-stat-k' }, t('now.energy')), h('div', { className: 'isi-stat-v' }, pct(self.energy))),
        h('div', { className: 'isi-stat' }, h('div', { className: 'isi-stat-k' }, t('now.mood')), h('div', { className: 'isi-stat-v' }, pct(self.mood))),
        h('div', { className: 'isi-stat' }, h('div', { className: 'isi-stat-k' }, t('now.hunger')), h('div', { className: 'isi-stat-v' }, pct(self.socialHunger))),
        h('div', { className: 'isi-stat' }, h('div', { className: 'isi-stat-k' }, t('now.warmth')), h('div', { className: 'isi-stat-v' }, pct(talk.warmth))),
      )

      const plan = data.plan
      const items = plan && Array.isArray(plan.items) ? plan.items.slice(0, 6) : []
      const next = nextPlanItem(plan)
      const planBlock = h(
        Block,
        { key: 'plan', title: t('now.plan'), meta: plan && plan.date ? plan.date : '' },
        items.length
          ? items.map((item, index) => h(
            Row,
            {
              key: `plan-${index}`,
              time: item.at,
              strong: item === next,
              meta: item.done ? t('now.done') : item.mood,
            },
            h('span', { className: item.done ? 'isi-done' : '' }, item.what),
          ))
          : h('div', { className: 'isi-empty' }, t('now.emptyPlan')),
      )

      const actions = Array.isArray(data.actions) ? data.actions.slice().reverse().slice(0, 6) : []
      const actionsBlock = h(
        Block,
        { key: 'actions', title: t('now.actions') },
        actions.length
          ? actions.map((action, index) => h(
            Row,
            { key: `act-${index}`, time: stamp(action.at) },
            actionLabel(action, t),
          ))
          : h('div', { className: 'isi-empty' }, t('now.emptyActions')),
      )

      return [strip, planBlock, actionsBlock]
    }

    function stateBody(data, t) {
      const self = data.self
      if (!self) return [h('div', { className: 'isi-empty', key: 'empty' }, t('empty'))]

      const metrics = [
        ['energy', self.energy],
        ['sleepDebt', self.sleepDebt],
        ['socialHunger', self.socialHunger],
        ['curiosity', self.curiosity],
        ['competence', self.competence],
        ['stress', self.stress],
        ['mood', self.mood],
        ['valence', self.valence],
        ['arousal', self.arousal],
      ]
      const metricsBlock = h(
        Block,
        { key: 'metrics', title: t('state.metrics'), meta: self.at ? t('state.metrics.meta', { time: ago(self.at, t) }) : '' },
        h('div', { className: 'isi-grid3' }, metrics.map(([key, value]) => h(Meter, {
          key,
          label: t(`m.${key}`),
          ratio: value,
        }))),
      )

      const affect = self.affect
      const affectBlock = h(
        Block,
        { key: 'affect', title: t('state.affect') },
        affect
          ? (EMOTIONS.every((emotion) => (affect[emotion] || 0) < 0.01)
            ? h('div', { className: 'isi-empty' }, t('state.calm'))
            : h('div', { className: 'isi-grid3' }, EMOTIONS.map((emotion) => h(Meter, {
              key: emotion,
              label: t(`f.${emotion}`),
              ratio: affect[emotion],
            }))))
          : h('div', { className: 'isi-empty' }, t('empty')),
      )

      const style = data.style
      const styleBlock = h(
        Block,
        { key: 'style', title: t('state.style'), meta: style && style.samples != null ? t('style.samples', { n: style.samples }) : '' },
        style
          ? h('div', { className: 'isi-chips' },
            style.insufficient ? h('span', { className: 'isi-chip' }, t('style.insufficient')) : null,
            typeof style.avgChars === 'number' ? h('span', { className: 'isi-chip' }, t('style.avg', { n: style.avgChars.toFixed(1) })) : null,
            typeof style.emojiRate === 'number' ? h('span', { className: 'isi-chip' }, t('style.emoji', { n: Math.round(style.emojiRate * 100) })) : null,
            typeof style.questionRate === 'number' ? h('span', { className: 'isi-chip' }, t('style.question', { n: Math.round(style.questionRate * 100) })) : null,
          )
          : h('div', { className: 'isi-empty' }, t('empty')),
      )

      const offline = data.offline
      const offlineBlock = offline
        ? h(
          Block,
          { key: 'offline', title: t('state.offline'), meta: typeof offline.gapHours === 'number' ? t('state.away', { n: offline.gapHours.toFixed(1) }) : '' },
          h(Clamp, { text: offline.text, lines: 'clamped2', threshold: 120 }),
          h('div', { className: 'isi-chips' },
            offline.received != null ? h('span', { className: 'isi-chip' }, t('state.recv', { n: offline.received })) : null,
            offline.sent != null ? h('span', { className: 'isi-chip' }, t('state.sent', { n: offline.sent })) : null,
          ),
        )
        : null

      return [metricsBlock, affectBlock, styleBlock, offlineBlock].filter(Boolean)
    }

    function socialBody(data, t) {
      const sessions = Array.isArray(data.sessions) ? data.sessions : []
      const moodRows = (data.mood && data.mood.rows) || []
      const moodByKey = new Map(moodRows.map((row) => [row.key, row]))

      const sessionsBlock = h(
        Block,
        { key: 'sessions', title: t('social.sessions'), meta: sessions.length ? t('social.sessions.meta', { n: sessions.length }) : '' },
        sessions.length
          ? sessions.map((session) => {
            const dominant = dominantEmotion(moodByKey.get(session.key))
            const meta = dominant
              ? `${t(`f.${dominant.emotion}`)} ${dominant.value.toFixed(2)}`
              : t('social.nomood')
            return h(Row, {
              key: session.key,
              time: session.kind === 'group' ? t('act.group') : t('act.private'),
              meta,
            }, session.key.slice(session.key.indexOf(':') + 1))
          })
          : h('div', { className: 'isi-empty' }, t('empty')),
      )

      const social = data.social
      const groups = (social && social.groups) || []
      const groupsBlock = groups.length
        ? h(
          Block,
          {
            key: 'groups',
            title: t('social.groups'),
            meta: t('social.groups.meta', { groups: groups.length, pairs: social.totalPairs || 0 }),
          },
          groups.slice(0, 3).map((group) => h(
            'div',
            { key: group.key },
            h('div', { className: 'isi-grouphead' }, `${displayKey(group.key, t)} · ${t('social.pairs', { n: group.pairs })}`),
            group.top.slice(0, 3).map((pair, index) => h(
              Row,
              { key: `${group.key}-${index}`, meta: `${pair.ab}/${pair.ba}` },
              `${pair.a} ⇄ ${pair.b}`,
            )),
          )),
        )
        : null

      const wake = Array.isArray(data.wake) ? data.wake : []
      const wakeBlock = wake.length
        ? h(
          Block,
          {
            key: 'wake',
            title: t('social.wake'),
            meta: [t('social.wake.meta', { n: wake.length }), modeLabel(wake[0].mode, t)].filter(Boolean).join(' · '),
          },
          wake.slice(0, 4).map((row) => h(
            Row,
            {
              key: row.key,
              time: row.key.indexOf('group:') === 0 ? t('act.group') : t('act.private'),
              meta: [
                row.wakeCount != null ? t('social.wake.count', { n: row.wakeCount }) : '',
                row.probability != null ? t('social.wake.p', { n: Math.round(row.probability * 100) }) : '',
              ].filter(Boolean).join(' · '),
            },
            row.key.slice(row.key.indexOf(':') + 1),
          )),
        )
        : null

      const slang = data.slang
      const slangRows = (slang && slang.sample) || []
      const slangBlock = slang && slangRows.length
        ? h(
          Block,
          {
            key: 'slang',
            title: t('social.slang'),
            meta: t('social.slang.meta', { n: slang.total, c: slang.status ? slang.status.confirmed : 0 }),
          },
          slangRows.slice(0, 3).map((row, index) => h(
            Row,
            { key: `slang-${index}`, meta: row.status === 'confirmed' ? '✓' : '' },
            h('span', { className: 'isi-term' }, row.content),
            h('span', { className: 'isi-sub2' }, row.meaning || t('empty')),
          )),
          h(Fold, {
            items: slangRows.slice(3),
            render: (row, index) => h(
              Row,
              { key: `slang-more-${index}` },
              h('span', { className: 'isi-term' }, row.content),
              h('span', { className: 'isi-sub2' }, row.meaning || t('empty')),
            ),
          }),
        )
        : null

      return [sessionsBlock, groupsBlock, wakeBlock, slangBlock].filter(Boolean)
    }

    function mindBody(data, t) {
      const mind = data.mind || {}
      const thoughts = (Array.isArray(data.thoughts) ? data.thoughts : []).slice().reverse()

      const cognitionBlock = thoughts.length
        ? h(
          Block,
          { key: 'cognition', title: t('mind.cognition') },
          thoughts.slice(0, 3).map((thought, index) => h(
            Row,
            { key: `thought-${index}`, time: ago(thought.at, t), meta: thought.kind ? kindLabel(thought.kind, t) : '' },
            thought.text,
          )),
          h(Fold, {
            items: thoughts.slice(3),
            render: (thought, index) => h(
              Row,
              { key: `thought-more-${index}`, time: ago(thought.at, t) },
              thought.text,
            ),
          }),
        )
        : null

      const lessons = mind.lessons
      const lessonRows = (lessons && lessons.recent) || []
      const lessonsBlock = lessonRows.length
        ? h(
          Block,
          { key: 'lessons', title: t('mind.lessons'), meta: t('mind.lessons.meta', { n: lessons.total }) },
          lessonRows.slice(0, 3).map((lesson, index) => h(
            Row,
            { key: `lesson-${index}`, meta: lesson.confidence != null ? lesson.confidence.toFixed(2) : '' },
            lesson.rule,
          )),
        )
        : null

      const beliefs = mind.beliefs
      const notable = notablePeople(beliefs)
      const beliefsBlock = beliefs
        ? h(
          Block,
          { key: 'beliefs', title: t('mind.beliefs'), meta: t('mind.beliefs.meta', { n: beliefs.people, g: beliefs.groups }) },
          notable.length
            ? notable.slice(0, 4).map((person) => h(
              Row,
              { key: person.id, time: person.id, meta: t('mind.encounters', { n: num(person.interactions) }) },
              h('span', { className: 'isi-sub2' }, `${t('mind.trust')} ${person.trust.toFixed(2)} · ${t('mind.affinity')} ${person.affinity.toFixed(2)}`),
            ))
            : h('div', { className: 'isi-empty' }, t('mind.beliefs.plain', { n: beliefs.people })),
        )
        : null

      const goals = data.goals || { active: [], done: [] }
      const activeGoals = goals.active || []
      const goalRows = activeGoals.length ? activeGoals : goals.done || []
      const goalsBlock = goalRows.length
        ? h(
          Block,
          { key: 'goals', title: activeGoals.length ? t('mind.goals') : t('mind.goals.done') },
          goalRows.slice(0, 3).map((goal, index) => h(
            Row,
            {
              key: `goal-${index}`,
              meta: goal.progressCount ? t('mind.goals.progress', { n: goal.progressCount }) : ago(goal.touchedAt, t),
            },
            goal.text,
          )),
        )
        : null

      return [cognitionBlock, lessonsBlock, beliefsBlock, goalsBlock].filter(Boolean)
    }

    function logBody(data, t) {
      const diary = Array.isArray(data.diary) ? data.diary.slice().reverse() : []
      const diaryBlock = h(
        Block,
        { key: 'diary', title: t('log.diary'), meta: diary.length ? t('log.diary.meta', { n: diary.length }) : '' },
        diary.length
          ? diary.map((entry, index) => h(
            Row,
            {
              key: `diary-${index}`,
              time: entry.time ? entry.time.slice(5, 10) : entry.day,
              meta: entry.time ? entry.time.slice(11) : '',
            },
            h('div', { className: 'isi-clamped2' }, entry.text),
            entry.mood ? h('div', { className: 'isi-sub2' }, entry.mood) : null,
          ))
          : h('div', { className: 'isi-empty' }, t('empty')),
      )

      const daily = data.daily
      const dailyBlock = daily && daily.text
        ? h(
          Block,
          { key: 'daily', title: t('log.daily'), meta: daily.day || '' },
          h(Clamp, { text: daily.text, lines: 'clamped', threshold: 220 }),
        )
        : null

      const usage = data.usage
      const tools = data.tools
      const usageRows = []
      if (usage) {
        usageRows.push(h(
          Row,
          { key: 'tokens', time: t('log.usage.meta', { n: usage.today.turns }), meta: usage.model || '' },
          t('log.tokens', { a: num(usage.today.cacheMiss), c: num(usage.today.cacheHit), o: num(usage.today.output) }),
        ))
      }
      if (tools) {
        usageRows.push(h(
          Row,
          { key: 'tools', time: t('log.tools.meta', { ok: tools.ok, fail: tools.fail }) },
          (tools.top || []).slice(0, 3).map((row) => `${row.name.replace(/^mcp__/, '')} ${row.ok}/${row.fail}`).join(' · '),
        ))
      }
      if (data.memory) {
        usageRows.push(h(
          Row,
          { key: 'memory' },
          t('log.memory', { n: data.memory.total, s: data.memory.sources }),
        ))
      }
      const usageBlock = usageRows.length
        ? h(Block, { key: 'usage', title: t('log.usage') }, usageRows)
        : null

      return [diaryBlock, dailyBlock, usageBlock].filter(Boolean)
    }

    /**
     * Debug view: everything here is either read-only or one of the three hot
     * switches the console already exposes. Every write needs a second click.
     */
    function DebugView(props) {
      const { debug, pending, busy, onPick, onConfirm, onCancel, onReload } = props
      const data = debug && debug.data

      if (!debug) {
        return [h('div', { className: 'isi-empty', key: 'empty' }, t('loading'))]
      }
      if (!data) {
        return [
          debug.phase === 'error' ? h('div', { className: 'isi-err', key: 'err' }, debug.error) : null,
          h('div', { className: 'isi-empty', key: 'empty' }, debug.phase === 'error' ? t('error') : t('loading')),
        ]
      }

      const model = data.model
      const status = data.status
      const consoleOk = Boolean(data.console && data.console.ok)

      const confirmBar = pending
        ? h(
          'div',
          { className: 'isi-confirm', key: 'confirm' },
          h('span', null, pending.question),
          h('button', { type: 'button', className: 'isi-btn', onClick: () => onConfirm(pending), disabled: busy }, t('debug.doConfirm')),
          h('button', { type: 'button', className: 'isi-btn', onClick: onCancel, disabled: busy }, t('debug.cancel')),
        )
        : null

      const modelRows = model
        ? [
          h(Row, { key: 'provider', time: t('debug.provider') }, model.provider || '—'),
          h(Row, { key: 'model', time: t('debug.modelname') }, model.model || '—'),
          h(Row, { key: 'effort', time: t('debug.effort'), meta: model.catalogSource || '' }, model.reasoningEffort || '—'),
        ]
        : [h('div', { className: 'isi-empty', key: 'down' }, t('debug.consoleDown', { error: (data.console && data.console.error) || '' }))]

      const effortChips = h(
        'div',
        { className: 'isi-chips', key: 'efforts' },
        (data.efforts || []).map((value) => h('button', {
          key: value,
          type: 'button',
          className: `isi-opt${model && model.reasoningEffort === value ? ' on' : ''}`,
          onClick: () => onPick({ action: 'effort', value, question: t('debug.confirm', { label: value }) }),
        }, value)),
      )

      const modeChips = h(
        'div',
        { className: 'isi-chips', key: 'modes' },
        (data.modes || []).map((value) => h('button', {
          key: value,
          type: 'button',
          className: `isi-opt${status && status.mode === value ? ' on' : ''}`,
          onClick: () => onPick({ action: 'mode', value, question: t('debug.confirm', { label: value }) }),
        }, value)),
      )

      const paused = Boolean(status && status.paused)
      const pauseChip = h(
        'div',
        { className: 'isi-chips', key: 'pause' },
        h('button', {
          type: 'button',
          className: `isi-opt${paused ? ' on' : ''}`,
          onClick: () => onPick({
            action: 'pause',
            value: !paused,
            question: paused ? t('debug.confirm.resume') : t('debug.confirm.pause'),
          }),
        }, paused ? t('debug.paused.on') : t('debug.paused.off')),
        h('button', { type: 'button', className: 'isi-btn', onClick: onReload, disabled: busy }, t('debug.reload')),
      )

      const runtimeRows = status
        ? [
          h(Row, { key: 'dsh', time: t('debug.dsh'), meta: status.dshReady ? 'ready' : 'down' }, status.role || '—'),
          h(Row, { key: 'onebot', time: t('debug.onebot'), meta: status.onebotConnected ? 'connected' : 'offline' }, status.onebotUrl || '—'),
          h(Row, { key: 'mode', time: t('debug.mode') }, status.mode || '—'),
          status.allowGroups != null
            ? h(Row, { key: 'allow' }, t('debug.whitelist', { groups: status.allowGroups, private: status.allowPrivate || 0 }))
            : null,
        ].filter(Boolean)
        : []

      return [
        confirmBar,
        debug.error ? h('div', { className: 'isi-err', key: 'err' }, debug.error) : null,
        h(Block, { key: 'model', title: t('debug.model'), meta: consoleOk ? '' : t('debug.consoleDown', { error: (data.console && data.console.error) || '' }) },
          modelRows,
          model ? h('div', { className: 'isi-sub2', style: { padding: '6px 0' } }, t('debug.notModel')) : null),
        h(Block, { key: 'effort', title: t('debug.effort') },
          effortChips,
          model && model.globalSideEffect ? h('div', { className: 'isi-sub2', style: { padding: '0 0 6px' } }, t('debug.global')) : null),
        h(Block, { key: 'mode', title: t('debug.mode') }, modeChips),
        h(Block, { key: 'pause', title: t('debug.paused') }, pauseChip),
        status ? h(Block, { key: 'runtime', title: t('debug.runtime') }, runtimeRows) : null,
      ]
    }

    const BODIES = {
      now: nowBody,
      state: stateBody,
      social: socialBody,
      mind: mindBody,
      log: logBody,
    }

    /* -------------------------------------------------------------------- page */

    function StatusPage() {
      const [view, setView] = React.useState({ phase: 'loading', data: null, error: '', at: 0 })
      const [tab, setTab] = React.useState('now')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(`${ENDPOINT}?t=${Date.now()}`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setView({ phase: 'ready', data, error: '', at: Date.now() })
        } catch (error) {
          setView((prev) => ({
            phase: prev.data ? 'stale' : 'error',
            data: prev.data,
            error: String((error && error.message) || error),
            at: prev.at,
          }))
        }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      /* 调试视图：只在打开时读一次，动作成功后重新读 */
      const [debug, setDebug] = React.useState(null)
      const [pending, setPending] = React.useState(null)

      const loadDebug = React.useCallback(async () => {
        try {
          const response = await fetch(`${DEBUG_STATE}?t=${Date.now()}`, { cache: 'no-store' })
          if (response.status === 404) throw new Error(t('debug.needsRestart'))
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          setDebug({ phase: 'ready', data: payload, error: '', busy: false })
        } catch (error) {
          setDebug((prev) => ({ phase: 'error', data: prev ? prev.data : null, error: String((error && error.message) || error), busy: false }))
        }
      }, [])

      React.useEffect(() => {
        if (tab === 'debug' && !debug) loadDebug()
      }, [tab, debug, loadDebug])

      const runAction = React.useCallback(async (action) => {
        setDebug((prev) => ({ ...(prev || {}), busy: true, error: '' }))
        try {
          const response = await fetch(DEBUG_ACTION, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action.action, value: action.value }),
          })
          const result = await response.json().catch(() => ({}))
          if (!response.ok || !result.ok) throw new Error((result && result.error) || `HTTP ${response.status}`)
          setPending(null)
          await loadDebug()
          await load()
        } catch (error) {
          setDebug((prev) => ({ ...(prev || {}), busy: false, error: String((error && error.message) || error) }))
        }
      }, [loadDebug, load])

      const data = view.data
      const bridgeOnline = Boolean(data && data.identity && data.identity.bridge && data.identity.bridge.alive)

      const rail = h(
        'nav',
        { className: 'isi-rail' },
        h('div', { className: 'isi-rail-brand' }, (data && data.identity && data.identity.role) || t('nav')),
        h('div', { className: 'isi-rail-note' }, t('subtitle')),
        ['now', 'state', 'social', 'mind', 'log', 'debug'].map((id) => h(
          'button',
          { key: id, type: 'button', className: `isi-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) },
          t(`nav.${id}`),
        )),
        h('div', { className: 'isi-rail-foot' }, t('footer.root', { root: data && data.root ? data.root : '' })),
      )

      const head = h(
        'div',
        { className: 'isi-head' },
        h(
          'div',
          null,
          h('h1', { className: 'isi-title' }, (data && data.identity && data.identity.role) || t('title')),
          h(
            'div',
            { className: 'isi-sub' },
            h('span', { className: 'isi-pill' }, h('i', { className: `isi-dot${bridgeOnline ? ' on' : ''}` }), bridgeOnline ? t('bridge.online') : t('bridge.offline')),
            data && data.identity && data.identity.mode ? h('span', { className: 'isi-pill' }, data.identity.mode) : null,
            view.at ? h('span', null, t('updated', { time: clock(view.at) })) : null,
          ),
        ),
        h('button', { className: 'isi-btn', type: 'button', onClick: load, disabled: view.phase === 'loading' }, t('refresh')),
      )

      let body
      if (tab === 'debug') {
        body = h(DebugView, {
          debug,
          pending,
          busy: Boolean(debug && debug.busy),
          onPick: setPending,
          onConfirm: runAction,
          onCancel: () => setPending(null),
          onReload: loadDebug,
        })
      } else if (!data) {
        body = [
          view.phase === 'error' ? h('div', { className: 'isi-err', key: 'err' }, `${t('error')} · ${t('error.hint')}`) : null,
          h('div', { className: 'isi-empty', key: 'empty' }, view.phase === 'error' ? t('error') : t('loading')),
        ]
      } else {
        const build = BODIES[tab] || BODIES.now
        body = [
          view.phase === 'error' || view.phase === 'stale'
            ? h('div', { className: 'isi-err', key: 'err' }, `${t('error')} · ${view.error}`)
            : null,
          ...build(data, t),
        ]
      }

      return h(
        'div',
        { className: 'isi-root' },
        h('style', { key: 'css' }, CSS),
        rail,
        h('div', { className: 'isi-page' }, h('div', { className: 'isi-wrap' }, head, body)),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(PANEL_ID, 'zh', zh), 'inori-status: zh dictionary')
        ctx.effect(() => ctx.locale.register(PANEL_ID, 'en', en), 'inori-status: en dictionary')
        t = ctx.locale.bind(PANEL_ID)

        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, StatusPage)),
          'inori-status: main panel',
        )

        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('nav'),
          }, StatusIcon)),
          'inori-status: sidebar entry',
        )
      },
    }
  },
})
