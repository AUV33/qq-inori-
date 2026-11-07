#!/usr/bin/env node
// smoke-bridge.mjs · bridge.js 加载冒烟测试（比 node --check 严一层）
//
// 用法：node qq-bridge/scripts/smoke-bridge.mjs
// 退出码 0 = SMOKE_OK（整文件顶层可加载，main 未启动、不抢锁、不连 DSH）
// 退出码 1 = SMOKE_FAIL（输出原因）
//
// 为什么必须有它：顶层裸标识符（MARKER-LIFE-TEST 这类）语法解析通过、
// 运行时才 ReferenceError 崩掉 24/7 进程——node --check 拦不住。
// 改完 bridge.js 之后必须跑一次这个，再交给主人重启。

import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/domain/shared/project-paths.js';

const FILE = `${PROJECT_ROOT}/qq-bridge/src/bridge.js`;

try {
  const out = String(execFileSync(process.execPath, [FILE], {
    cwd: `${PROJECT_ROOT}/qq-bridge`,
    stdio: 'pipe',
    timeout: 30000,
    env: { ...process.env, BRIDGE_SMOKE_TEST: '1' },
  }));
  if (out.includes('SMOKE_OK')) {
    console.log('✅ SMOKE_OK：bridge.js 顶层完整可加载（未启动 main，不影响在跑的桥接）');
    process.exit(0);
  }
  console.error('❌ SMOKE_FAIL：输出里没有 SMOKE_OK：\n' + out.slice(0, 500));
  process.exit(1);
} catch (error) {
  console.error('❌ SMOKE_FAIL：\n'
    + String(error?.stdout ?? '').slice(0, 300)
    + '\n' + String(error?.stderr ?? error?.message ?? error).slice(0, 300));
  process.exit(1);
}
