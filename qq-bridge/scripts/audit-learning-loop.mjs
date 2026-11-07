// audit-learning-loop.mjs · 学习闭环“接线锁”
//
// 只做静态检查：新模块有没有被主链路真正调用；哪条接缝又断了会在这里红。
// 不替代行为测试（test-learning-loop-v2），只防“模块存在但没人 import”的老毛病。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p, s, msg) => assert.ok(read(p).includes(s), msg || `${p} 缺少 ${s}`);

const app = read('src/app.mjs');
const mux = read('src/mux-bus.mjs');
const wake = read('src/domain/conversation/wake-sender.mjs');
const intake = read('src/domain/conversation/message-intake.mjs');
const mem = read('../ai-companion-kit/packages/memory-mcp/src/memory-mcp.js');
const ledger = read('src/domain/leaves/inori-taskledger.js');
const skills = read('src/inori-skills.js');
const practiceSlot = read('src/practice-slot.mjs');
const learningWrites = read('src/inori-learning-writes.js');
const host = read('src/mcp-host-server.js');
const consoleSrc = read('src/adapters/console-server.mjs');

// 1. app 真的把新块接进唤醒
for (const s of ['loadLearningItems', 'loadSkillDrafts', 'loadSessionNotes', 'renderSessionNotesBlock', 'renderLearningItems', 'renderSkillDrafts']) {
  assert.ok(app.includes(s), `app.mjs 缺少 ${s}`);
}
assert.ok(app.includes('noteSessionCorrection'), 'app.mjs 缺少纠正捕获');
assert.ok(app.includes('noteLiveToolResult'), 'app.mjs 缺少工具失败实时笔记');

// 2. mux 真的做任务结果解析、工具反馈、成功轨迹
for (const s of ['parseTaskResult', 'noteLiveToolResult', 'appendTrace', 'TASK-TRUTH', 'WORK-BRIDGE', 'TASK-ACCEPT', 'checkVerify']) {
  assert.ok(mux.includes(s), `mux-bus.mjs 缺少 ${s}`);
}

// 3. message-intake 收到纠正就写
assert.ok(intake.includes('noteCorrection'), 'message-intake.mjs 没有 noteCorrection');

// 4. wake 真的轮换经验 + 技能带 mastery/nextDrill
assert.ok(wake.includes('rotate: true'), 'wake-sender.mjs 经验没有轮换');
assert.ok(wake.includes('nextDrill') && wake.includes('mastery'), 'wake-sender.mjs 技能块没有 mastery/nextDrill');

// 5. 任务真账/续跑
for (const s of ['outcome', 'evidence', 'nextAction', 'fingerprint', 'resumeTask', 'resumableTasks', 'parseTaskResult']) {
  assert.ok(ledger.includes(s), `task-ledger 缺少 ${s}`);
}

// 6. 技能只认 verify
assert.ok(skills.includes('verifiedBy'), 'skills 缺少 verifiedBy');
assert.ok(skills.includes("source === 'turn'") || skills.includes("['turn', 'activity']"), 'skills 没有对 turn/activity 做 gating');

// 7. 练手位有 polish
assert.ok(practiceSlot.includes('polish'), 'practice-slot 没有 polish');

// 8. 学习写入桶
for (const s of ['learning-items', 'practice-sessions', 'skill-drafts']) {
  assert.ok(learningWrites.includes(s), `learning-writes 没有 ${s} 桶`);
}

// 9. memory-mcp 工具面
for (const s of ['learning_item', 'practice_start', 'practice_note', 'practice_result', 'skill_draft']) {
  assert.ok(mem.includes(s), `memory-mcp 缺少工具 ${s}`);
}

// 10. 报告脚本
assert.ok(fs.existsSync(path.join(ROOT, 'scripts/learning-report.mjs')), '缺少 learning-report.mjs');

// 11. 画画进轨迹
const activity = read('src/inori-activity.js');
assert.ok(activity.includes('phone_sketch'), '活动轨迹没接 phone_sketch');
assert.ok(activity.includes("act: 'sketch'"), '活动轨迹没记 sketch');

// 12. 目标完成状态不能从候选池漏回来 / 学习项 done 要有证据
const candidates = read('src/inori-intention-candidates.js');
assert.ok(candidates.includes("'promoted'") && candidates.includes("['done', 'dropped', 'promoted']"), '候选池没有过滤 goals 的 done/dropped/promoted 状态');
const items = read('src/inori-learning-items.js');
assert.ok(items.includes('evidence-required'), '学习项 done 没有证据门');

// 13. intention → task → outcome 链
assert.ok(host.includes('intentionId'), 'handoff_task 没接 intentionId');
assert.ok(consoleSrc.includes('intentionId'), 'handoff HTTP 没接 intentionId');
assert.ok(ledger.includes('intentionId'), 'task-ledger 没接 intentionId');
const works = read('src/inori-works.js');
assert.ok(works.includes('intentionId'), 'works 没接 intentionId');

// 14. 证据强度 / 练习历史 / 硬预算
assert.ok(ledger.includes('evidenceQuality') && ledger.includes('strong'), 'task-ledger 没有证据分级');
assert.ok(mem.includes('practice_list'), 'memory-mcp 没有 practice_list');
assert.ok(wake.includes('enforceInjectionBudget'), 'wake-sender 没有硬预算');

console.log('✅ 学习闭环接线锁：16/16');
