#!/usr/bin/env node
// env-referee-demo.mjs · S9c 可复现 demo：动作-观察-判据三元组 + 空转熔断
//
// 用**模拟的** adb/UI（不启动游戏、不连设备、不调用视觉模型）复现宪章 §5.8 的故障与修复：
//   1) 盲操作（只 tap、不观察不判据）→ invalid，禁止；
//   2) 同一个错误动作连续 3 次 → not_met/unknown，detectStuck=true；
//   3) 正确动作 + 观察 + 判据 → met，mastery 的原料第一次出现。
//
// 用法：node scripts/env-referee-demo.mjs [--json]
// 退出码：0（demo 自检通过）；1（自检失败，说明编排回归）。
import { runAtomicStep, detectStuck, createPhoneReferee } from '../src/domain/leaves/action-observe.mjs';

function createFakeGame() {
  const state = { screen: 'home', sanity: 36, deployed: 0 };
  return {
    state,
    tapDeploy() { state.deployed += 1; return { tapped: 'deploy' }; },
    tapWrongSpot() { state.deployed += 0; return { tapped: 'wrong' }; },
    confirm() { if (state.deployed > 0) state.screen = 'result'; },
    snapshot() { return { screen: state.screen, sanity: state.sanity, deployed: state.deployed }; },
  };
}

async function scenario() {
  const game = createFakeGame();
  // 适配器只做“读屏文字 + 读状态”；真实 adb/视觉模型在运行时注入。
  const judges = createPhoneReferee({
    captureScreen: async () => ({ hash: JSON.stringify(game.state), text: `${game.state.screen} 理智${game.state.sanity} 部署${game.state.deployed}` }),
    readState: async (area) => (area === '理智' ? game.state.sanity : (area === '部署' ? game.state.deployed : undefined)),
  });
  const attempts = [];
  const steps = [];

  // 1) 盲操作：只有 action，没有 observe → invalid
  const blind = await runAtomicStep({ action: async () => game.tapWrongSpot(), criteria: ['画面: result'], judges });
  steps.push({ name: 'blind-action', result: blind.result, reason: blind.reason });

  // 2) 连续三次错误动作：点错 + 观察 + 判据 → not_met；再次 → stuck
  for (let i = 0; i < 3; i += 1) {
    const r = await runAtomicStep({
      action: async () => game.tapWrongSpot(),
      observe: async () => game.snapshot(),
      criteria: ['画面: result', '状态: 理智=36'],
      judges,
      meta: { signature: 'tap:wrong', i },
    });
    attempts.push({ signature: 'tap:wrong', result: r.result, at: Date.now() + i });
    steps.push({ name: `wrong-${i + 1}`, result: r.result });
  }
  const stuck = detectStuck({ attempts, maxAttempts: 3, windowMs: 60 * 1000 });

  // 3) 正确动作：点部署 → 确认 → 观察 → 判据 met
  const ok1 = await runAtomicStep({
    action: async () => game.tapDeploy(),
    observe: async () => game.snapshot(),
    criteria: ['状态: 部署=1'],
    judges,
    meta: { signature: 'tap:deploy' },
  });
  const ok2 = await runAtomicStep({
    action: async () => game.confirm(),
    observe: async () => game.snapshot(),
    criteria: ['画面: result', '状态: 理智=36'],
    judges,
    meta: { signature: 'tap:confirm' },
  });
  steps.push({ name: 'deploy', result: ok1.result }, { name: 'confirm', result: ok2.result });

  const met = steps.filter((s) => s.result === 'met').length;
  const passed = blind.result === 'invalid' && stuck.stuck === true && ok1.result === 'met' && ok2.result === 'met' && met === 2;
  return {
    v: 1,
    scenario: 'adb-deploy-referee',
    simulated: true,
    steps,
    stuck,
    summary: { met, invalid: steps.filter((s) => s.result === 'invalid').length, stuck: stuck.stuck, passed },
  };
}

const result = await scenario();
const asJson = process.argv.includes('--json');
if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write('[env-referee-demo] 模拟 adb 部署（不连设备）\n');
  for (const s of result.steps) process.stdout.write(`  - ${s.name}: ${s.result}${s.reason ? '（' + s.reason + '）' : ''}\n`);
  process.stdout.write(`  空转：${result.stuck.stuck ? '是' : '否'}（${result.stuck.reason}）\n`);
  process.stdout.write(`  结果：met=${result.summary.met} / invalid=${result.summary.invalid} / 自检=${result.summary.passed ? '通过' : '失败'}\n`);
}
process.exitCode = result.summary.passed ? 0 : 1;
