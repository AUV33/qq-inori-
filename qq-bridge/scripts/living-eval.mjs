#!/usr/bin/env node
// living-eval.mjs · M4/G10：跑 30 个离线场景（纯策略，不调模型）
//
// 用法：node scripts/living-eval.mjs [--json]
// 退出码：0 全过；1 有失败（策略回归）。
import { perceiveInbound } from '../src/domain/conversation/perception.mjs';
import { chooseMove } from '../src/domain/conversation/move-selector.mjs';
import { runLivingEval, styleFingerprint, styleDrift } from './lib/living-eval.mjs';
import { LIVING_EVAL_SCENARIOS } from './lib/living-eval-scenarios.mjs';

const SELF = '999';
const OWNER = '10001';

function runner(scenario) {
  const input = scenario.input || {};
  const perception = perceiveInbound({
    text: input.text,
    kind: input.kind,
    senderId: input.senderId,
    mentionedIds: input.mentionedIds,
    quoteTargetIsSelf: input.quoteTargetIsSelf,
    selfId: SELF,
    ownerId: OWNER,
  });
  const move = chooseMove({
    perception,
    self: scenario.self || {},
    bond: scenario.bond || {},
    scene: input.kind,
    text: input.text,
    isOwner: String(input.senderId ?? '') === OWNER,
  });
  return { perception, move: move.move, addressee: perception.addressee, speechAct: perception.speechAct, ambiguity: perception.ambiguity };
}

const report = runLivingEval({ scenarios: LIVING_EVAL_SCENARIOS, runner });
// 风格指纹的输入是“期望回复的文本”；本轮只有策略场景，不伪造文本，只报告能力可用性。
const styleAvailable = typeof styleFingerprint === 'function' && typeof styleDrift === 'function';
const body = { ...report, styleAvailable };

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
} else {
  process.stdout.write(`[living-eval] 场景 ${report.total}：通过 ${report.passed}，失败 ${report.failed}（${Math.round(report.passRate * 100)}%）\n`);
  for (const row of report.rows.filter((r) => !r.ok)) {
    process.stdout.write(`  ✖ ${row.id}: ${row.failures.map((f) => `${f.field}=${f.actual ?? ''}（期望 ${f.expected ?? ''}）`).join('；')}\n`);
  }
}
process.exitCode = report.failed === 0 ? 0 : 1;
