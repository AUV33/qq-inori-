import { readBridgeSource } from './lib/bridge-source.mjs';
// test-self-heal.mjs · 自愈接线锁：会话 400 自动重建 + SnowLuma 网关守护
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.log('  FAIL', n, '—', e.message); } };

const src = readBridgeSource();

check('[SESSION-REBUILD] 存在且识别 400/上下文超限', () => {
  assert.ok(src.includes('[SESSION-REBUILD]'), '没有 [SESSION-REBUILD]');
  assert.ok(/Messages request failed\|request failed \\(400\\)\|context length\|too long/.test(src) || src.includes('Messages request failed'), '没有 400 识别');
  assert.ok(src.includes('retireSession(key);'), '没有退役旧会话');
  assert.ok(src.includes("sendWakePromptV2(key, 'session-rebuilt')"), '没有重建后重试唤醒');
});

check('[SNOWLUMA-WATCHDOG] 存在且会拉起 silent-snowluma.vbs', () => {
  assert.ok(src.includes('[SNOWLUMA-WATCHDOG]'), '没有 [SNOWLUMA-WATCHDOG]');
  assert.ok(src.includes('silent-snowluma.vbs'), '没有拉起脚本');
  assert.ok(/ws(?:CloseStreak|StreakNow) >= 8/.test(src), '没有连续失败阈值');
  // 2026-10-30：脚本必须绝对路径 + 存在性检查，否则 wscript 找不到文件会弹模态框（10 分钟一次，反复弹）
  assert.ok(/path\.resolve\(__dirname[^)]*silent-snowluma\.vbs/.test(src), '没有把脚本路径解析成绝对路径');
  assert.ok(src.includes('fs.existsSync(vbsPath)'), '没有存在性检查');
});

check('连接成功会清零连续失败计数', () => {
  assert.ok(src.includes('wsCloseStreak = 0;') || src.includes('snowLumaNoteOpen()'), '没有清零');
  assert.ok(src.includes('wsLastOkAt = Date.now();'), '没有记活跃时间');
});

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
