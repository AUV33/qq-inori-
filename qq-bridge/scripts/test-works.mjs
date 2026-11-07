// 分身工作台 + 五件套辅助：状态机/进度/注入块/重要度/条件注入 纯函数自检
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORK_STATUS, newWork, findWork, activeWorks, runningWorks, queuedWorks,
  addProgress, setWorkStatus, summarizeWorkerText, renderWorksLine,
  loadWorks, saveWorks, importanceOf, conditionedRoleText,
} from '../src/domain/leaves/inori-works.js';

let passed = 0;
function ok(name, fn) { fn(); passed += 1; console.log('✅ ' + name); }

ok('新建的活是 queued 且带 id/title', () => {
  const w = newWork({ title: '查三角洲倒子弹', goal: '给出路线', acceptance: '有来源' });
  assert.ok(w.id.startsWith('w'));
  assert.equal(w.status, WORK_STATUS.QUEUED);
  assert.equal(w.title, '查三角洲倒子弹');
});

ok('进度追加 + 上限先进先出', () => {
  let w = newWork({ title: 'x' });
  for (let i = 0; i < 25; i++) w = addProgress(w, `p${i}`);
  assert.equal(w.progress.length, 20);
  assert.equal(w.progress[w.progress.length - 1].note, 'p24');
});

ok('终态不可再变（done 后改 failed 无效）', () => {
  let w = newWork({ title: 'x' });
  w = setWorkStatus(w, WORK_STATUS.RUNNING);
  w = setWorkStatus(w, WORK_STATUS.DONE, Date.now(), '做完了');
  const after = setWorkStatus(w, WORK_STATUS.FAILED);
  assert.equal(after.status, WORK_STATUS.DONE);
});

ok('非法状态被拒绝', () => {
  let w = newWork({ title: 'x' });
  w = setWorkStatus(w, 'bogus');
  assert.equal(w.status, WORK_STATUS.QUEUED);
});

ok('active/running/queued 过滤', () => {
  const a = newWork({ title: 'a' });
  const b = newWork({ title: 'b' });
  const c = setWorkStatus(newWork({ title: 'c' }), WORK_STATUS.RUNNING);
  const d = setWorkStatus(newWork({ title: 'd' }), WORK_STATUS.DONE);
  const list = [a, b, c, d];
  assert.equal(activeWorks(list).length, 3);
  assert.equal(runningWorks(list).length, 1);
  assert.equal(queuedWorks(list).length, 2);
});

ok('findWork 按 id 找 / 找不到返回 null', () => {
  const w = newWork({ title: 'x' });
  assert.equal(findWork([w], w.id), w);
  assert.equal(findWork([w], 'nope'), null);
});

ok('renderWorksLine：空池返回空串、有活带标题和最近进度', () => {
  assert.equal(renderWorksLine([]), '');
  const w = setWorkStatus(newWork({ title: '查资料' }), WORK_STATUS.RUNNING, Date.now(), '已搜到两篇');
  const line = renderWorksLine([w]);
  assert.ok(line.includes('查资料'));
  assert.ok(line.includes('已搜到两篇'));
});

ok('summarizeWorkerText 归一化截断', () => {
  assert.equal(summarizeWorkerText('  a\n\tb   c ', 10), 'a b c');
  assert.equal(summarizeWorkerText('x'.repeat(50), 5).length, 5);
});

ok('saveWorks/loadWorks 往返（临时文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'works-test-'));
  const file = path.join(dir, 'works.json');
  const w = newWork({ title: '往返' });
  assert.equal(saveWorks(file, [w]), true);
  const back = loadWorks(file);
  assert.equal(back.length, 1);
  assert.equal(back[0].title, '往返');
});

ok('重要度：fact=4 / group-digest=2 / day-digest=1 / 显式优先', () => {
  assert.equal(importanceOf({ kind: 'fact' }), 4);
  assert.equal(importanceOf({ kind: 'group-digest' }), 2);
  assert.equal(importanceOf({ kind: 'day-digest' }), 1);
  assert.equal(importanceOf({ kind: 'fact', importance: 5 }), 5);
  assert.equal(importanceOf({ kind: 'event' }), 3);
});

ok('条件注入：命中才保留、无标记原样返回', () => {
  const card = '核心设定\n[[?三角洲|方舟]]游戏话题块[[/?]]\n尾巴';
  assert.ok(!conditionedRoleText(card, '今天天气不错').includes('游戏话题块'));
  assert.ok(conditionedRoleText(card, '一起打三角洲？').includes('游戏话题块'));
  assert.equal(conditionedRoleText('无标记卡片', '任意上下文'), '无标记卡片');
});

console.log(`🎉 分身工作台/五件套辅助测试通过（${passed} 项）`);
