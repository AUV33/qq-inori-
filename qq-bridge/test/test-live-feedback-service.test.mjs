// live-feedback-service 金标：纠正记账、工具失败 streak/hint、设备失败一次性提醒、练手位与活动菜单。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFeedback } from '../src/domain/conversation/live-feedback-service.mjs';

function makeCtx(overrides = {}) {
  const state = { notes: { corrections: [], openLoops: [] }, saves: 0, appended: [], logs: [], files: new Map() };
  const svc = createLiveFeedback({
    fs: {
      appendFileSync: (file, line) => state.appended.push({ file, line }),
      writeFileSync: (file, body) => state.files.set(file, body),
      readFileSync: (file) => {
        if (!state.files.has(file)) throw new Error('ENOENT');
        return state.files.get(file);
      },
      rmSync: (file) => state.files.delete(file),
    },
    cfg: { socialV2: { skills: { file: 'skills.json' } } },
    log: (m) => state.logs.push(String(m)),
    stateDataPath: (name) => name,
    reverse: new Map([['sid-1', 'group:1']]),
    looksLikeCorrection: (t) => String(t).includes('不是'),
    loadSessionNotes: () => state.notes,
    addCorrection: (notes, key, text) => {
      if (notes.corrections.some((c) => c.key === key && c.text === text)) return { ok: true, duplicate: true };
      notes.corrections.push({ key, text });
      return { ok: true, duplicate: false };
    },
    saveSessionNotes: (notes) => { state.saves += 1; state.notes = notes; },
    clearOpenLoops: (notes, key, { prefix }) => {
      const before = notes.openLoops.length;
      notes.openLoops = notes.openLoops.filter((l) => !(l.key === key && String(l.text).startsWith(prefix)));
      return notes.openLoops.length !== before;
    },
    shouldNoteToolFailure: (tool) => tool !== 'noisy_tool',
    classifyToolError: () => ({ kind: 'permission' }),
    renderLiveHint: ({ tool, streak }) => `[${tool} 第 ${streak} 次失败] 换个方式`,
    addOpenLoop: (notes, key, text, hint) => { notes.openLoops.push({ key, text, hint }); return { ok: true }; },
    openLoopText: (tool, error) => `${tool} 报错：${error}`,
    classifyFailure: (text) => (String(text).includes('手机') ? 'device' : 'other'),
    loadSkills: () => ({ items: [{ id: 's1', activity: '玩方舟' }] }),
    pickPracticeSlots: () => ({ stuck: [{ id: 's2' }] }),
    DEFAULT_MAX_INJECTED: 10,
    renderPracticeSlots: () => '【练手位】明日方舟',
    renderActivityMenu: (items, { extraActivities, limit }) => `【活动】${items.length}/${extraActivities.length}/${limit}`,
    ...overrides,
  });
  return { svc, state };
}

test('noteSessionCorrection：只记 owner 的纠正，重复的不再落盘', () => {
  const h = makeCtx();
  h.svc.noteSessionCorrection('group:1', '不是这样', false);
  assert.equal(h.state.notes.corrections.length, 0, '非 owner 不记');
  h.svc.noteSessionCorrection('group:1', '随便聊聊', true);
  assert.equal(h.state.notes.corrections.length, 0, '不像纠正不记');
  h.svc.noteSessionCorrection('group:1', '不是这样', true);
  assert.equal(h.state.notes.corrections.length, 1);
  assert.equal(h.state.saves, 1);
  h.svc.noteSessionCorrection('group:1', '不是这样', true);
  assert.equal(h.state.saves, 1, '重复纠正不重复保存');
});

test('noteLiveToolResult：成功调用清掉 streak 与对应 open loop', () => {
  const h = makeCtx();
  h.svc.noteLiveToolResult('group:1', 'mcp__snowluma__qq_send', '权限不足');
  assert.equal(h.state.notes.openLoops.length, 1);
  h.svc.noteLiveToolResult('group:1', 'mcp__snowluma__qq_send', '');
  assert.equal(h.state.notes.openLoops.length, 0, '成功后要清掉「qq_send 报错：」那条');
});

test('noteLiveToolResult：失败按工具+类型累计 streak，且写 live-feedback.jsonl', () => {
  const h = makeCtx();
  h.svc.noteLiveToolResult('group:1', 'qq_send', '权限不足');
  h.svc.noteLiveToolResult('group:1', 'qq_send', '权限不足');
  assert.equal(h.state.notes.openLoops.length, 2);
  assert.equal(h.state.notes.openLoops[1].hint, '[qq_send 第 2 次失败] 换个方式');
  const lines = h.state.appended.map((a) => JSON.parse(a.line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'permission');
  assert.equal(lines[1].streak, 2);
});

test('noteLiveToolResult：不值得记的失败 / 没有 key 都不动状态', () => {
  const h = makeCtx();
  h.svc.noteLiveToolResult('', 'qq_send', '权限不足');
  h.svc.noteLiveToolResult('group:1', 'noisy_tool', '权限不足');
  assert.equal(h.state.notes.openLoops.length, 0);
  assert.equal(h.state.appended.length, 0);
});

test('noteDeviceFailure：连续 3 次手机失败才落一份一次性提醒', () => {
  const h = makeCtx();
  h.svc.noteDeviceFailure('sid-1', '手机没连上');
  h.svc.noteDeviceFailure('sid-1', '手机没连上');
  assert.equal(h.state.files.size, 0);
  h.svc.noteDeviceFailure('sid-1', '手机没连上');
  assert.equal(h.state.files.has('device-blocked.json'), true);
  assert.ok(h.state.logs.some((l) => l.includes('连续 3 次手机失败')));
  const alert = JSON.parse(h.state.files.get('device-blocked.json'));
  assert.equal(alert.key, 'group:1');
  assert.equal(alert.streak, 3);
});

test('noteDeviceFailure：中间插一条非设备失败会重置计数', () => {
  const h = makeCtx();
  h.svc.noteDeviceFailure('sid-1', '手机没连上');
  h.svc.noteDeviceFailure('sid-1', '手机没连上');
  h.svc.noteDeviceFailure('sid-1', '网络抖了一下');
  h.svc.noteDeviceFailure('sid-1', '手机没连上');
  assert.equal(h.state.files.size, 0, '重置后不能算连续 3 次');
});

test('takeDeviceBlockedLine：读过即清，超过 6 小时不再提', () => {
  const h = makeCtx();
  h.state.files.set('device-blocked.json', JSON.stringify({ at: Date.now(), key: 'group:1', streak: 3 }));
  const line = h.svc.takeDeviceBlockedLine();
  assert.ok(line.includes('【手机还是没连上】'));
  assert.equal(h.state.files.has('device-blocked.json'), false, '一次性：说了就清');

  const stale = makeCtx();
  stale.state.files.set('device-blocked.json', JSON.stringify({ at: Date.now() - 7 * 3600_000 }));
  assert.equal(stale.svc.takeDeviceBlockedLine(), '');
  assert.equal(h.svc.takeDeviceBlockedLine(), '', '文件不存在时返回空串');
});

test('practiceSlotLine：卡住的技能要留日志，仍然返回渲染结果', () => {
  const h = makeCtx();
  assert.equal(h.svc.practiceSlotLine(), '【练手位】明日方舟');
  assert.ok(h.state.logs.some((l) => l.includes('跳过 1 条注入过 10+ 次')));
});

test('activityMenuLine：读 activities.json 的 _pool 作为额外活动；文件坏了也照常给菜单', () => {
  const h = makeCtx();
  h.state.files.set('activities.json', JSON.stringify({ _pool: ['发呆', '逛'] }));
  assert.equal(h.svc.activityMenuLine(), '【活动】1/2/3');
  const broken = makeCtx();
  broken.state.files.set('activities.json', '不是 JSON');
  assert.equal(broken.svc.activityMenuLine(), '【活动】1/0/3');
});
