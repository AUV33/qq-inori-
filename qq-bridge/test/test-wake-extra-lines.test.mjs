// [WAKE-EXTRA] 唤醒附加行的回归锁。
//
// 这三行以前埋在 app.mjs 的 main() 里，只能靠线上日志看「到底递没递」。搬出来后钉住：
//   1) 没有材料时绝不占字（空串，不是空标题）；
//   2) 冷却时间写在 st 上，字段名不变（否则每次唤醒都重复递）；
//   3) 生词只给群聊，bootstrap 轮不塞。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWakeExtraLines } from '../src/domain/persona/wake-extra-lines.mjs';

function makeLines() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-extra-'));
  const lessonsFile = path.join(dir, 'lessons.jsonl');
  const slangFile = path.join(dir, 'slang.json');
  const episodesFile = path.join(dir, 'language-episodes.jsonl');
  fs.writeFileSync(lessonsFile, '');
  let clock = 1_700_000_000_000;
  let failures = { events: [] };
  let interest = { items: [] };
  const logs = [];
  const lines = createWakeExtraLines({
    getCfg: () => ({ socialV2: { lessons: { file: lessonsFile } } }),
    loadFailures: () => failures,
    loadInterestEncounters: () => interest,
    log: (...args) => logs.push(args.join(' ')),
    slangFile,
    languageEpisodesFile: episodesFile,
    now: () => clock,
  });
  return {
    ...lines,
    lessonsFile,
    logs,
    setFailures: (v) => { failures = v; },
    setInterest: (v) => { interest = v; },
    advance: (ms) => { clock += ms; },
  };
}

test('wakeFailureLine：失败在 30 分钟窗口内会渲染，冷却 20 分钟', () => {
  const w = makeLines();
  // 取模块时钟：advance(0) 不改变值；这里用一个明确落在窗口内的时间戳
  const now = 1_700_000_000_000;
  w.setFailures({ events: [{ at: now - 60_000, tool: 'qq_send_message', cause: 'network', text: '连接超时' }] });
  const st = {};
  const line = w.wakeFailureLine(st, 'group:1', 'message');
  assert.match(line, /^【最近卡在哪】/);
  assert.match(line, /连接超时/);
  assert.equal(st.lastFailureShownAt, now);

  w.advance(5 * 60_000);
  assert.equal(w.wakeFailureLine(st, 'group:1', 'message'), '');
  w.advance(20 * 60_000);
  assert.match(w.wakeFailureLine(st, 'group:1', 'message'), /^【最近卡在哪】/);
});

test('wakeGlossLine：群里出现 ≥2 次的生词会递；私聊/bootstrap/冷却期不递', () => {
  const w = makeLines();
  const st = { recentMessages: [{ text: 'xswl 这操作' }, { text: 'xswl 真的' }] };
  assert.equal(w.wakeGlossLine(st, 'private:1', 'message'), '');
  assert.equal(w.wakeGlossLine(st, 'group:1', 'bootstrap'), '');

  const line = w.wakeGlossLine(st, 'group:1', 'message');
  assert.match(line, /^【群里冒出的生词】/);
  assert.match(line, /xswl/);
  assert.equal(st.lastGlossShownAt, 1_700_000_000_000);

  w.advance(5 * 60_000);
  assert.equal(w.wakeGlossLine(st, 'group:1', 'message'), '');
  w.advance(30 * 60_000);
  assert.match(w.wakeGlossLine(st, 'group:1', 'message'), /^【群里冒出的生词】/);
});

test('wakeGlossLine：lessons 里已有的词不算生词', () => {
  const w = makeLines();
  fs.writeFileSync(w.lessonsFile, JSON.stringify({ text: 'xswl 是笑死了' }) + '\n');
  const st = { recentMessages: [{ text: 'xswl 这操作' }, { text: 'xswl 真的' }] };
  assert.equal(w.wakeGlossLine(st, 'group:1', 'message'), '');
});

test('wakeEncounterLine：有「遇到的东西」才递，30 分钟冷却，bootstrap 不递', () => {
  const w = makeLines();
  const st = {};
  assert.equal(w.wakeEncounterLine(st, 'group:1', 'message'), '');
  w.setInterest({ items: [{ kind: 'unknown', what: '一个新梗', at: 1_700_000_000_000 - 60_000 }] });
  assert.equal(w.wakeEncounterLine(st, 'group:1', 'bootstrap'), '');
  const line = w.wakeEncounterLine(st, 'group:1', 'message');
  assert.match(line, /^【你遇到的东西】/);
  assert.match(line, /一个新梗/);
  assert.equal(st.lastEncounterShownAt, 1_700_000_000_000);

  w.advance(10 * 60_000);
  assert.equal(w.wakeEncounterLine(st, 'group:1', 'message'), '');
});
