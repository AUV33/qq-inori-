#!/usr/bin/env node
// config-doctor.mjs · 配置体检（只读）
//
// 回答三个问题：
//   1. config.json 里有没有「写了但加载器不认识」的键？（会被静默丢弃）
//   2. config.example.json 有没有落后于现网？（照 example 新装会丢功能）
//   3. 现网配置有没有语法/结构错误？
//
// 两种模式：
//   · 默认（静态）：只比 config.json / config.example.json 的形状，不需要桥接、不读业务代码。
//   · --runtime：让桥接以 `BRIDGE_CONFIG_CHECK=1` 启动一次（不连 DSH、不抢锁），
//     打印真实 loadConfig() 的结果形状，从而能精确回答"哪些键被白名单丢了"。
//     桥接支持这个钩子时才有意义；不支持会明确告诉你。
//
// 用法：
//   node scripts/config-doctor.mjs
//   node scripts/config-doctor.mjs --runtime --strict
//   node scripts/config-doctor.mjs --json
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QQ_BRIDGE_DIR } from '../src/domain/shared/project-paths.js';
import { compareConfigShape, findDroppedKeys, formatConfigReport } from '../src/config-check.mjs';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const strict = args.has('--strict');
const runtime = args.has('--runtime');
const argValue = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const configPath = path.resolve(argValue('--config', path.join(QQ_BRIDGE_DIR, 'config.json')));
const examplePath = path.resolve(argValue('--example', path.join(QQ_BRIDGE_DIR, 'config.example.json')));

const readJson = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
};

const result = { config: configPath, example: examplePath, dropped: [], missingInExample: [], extraInExample: [], runtimeAvailable: false, errors: [] };

let config;
try { config = readJson(configPath); } catch (error) { result.errors.push(`读取/解析 config.json 失败：${error.message}`); }

let example;
try { example = readJson(examplePath); } catch (error) { result.errors.push(`读取/解析 config.example.json 失败：${error.message}`); }

if (config && example) {
  const shape = compareConfigShape(config, example);
  result.missingInExample = shape.missingInExample;
  result.extraInExample = shape.extraInExample;
}

// 运行时模式：桥接源码里出现过这个钩子才尝试，避免对着旧代码空跑。
// [AUDIT-FIX] 钩子实际在 app.mjs（main 内），bridge.js 只是入口壳。
// 只查 bridge.js 会让 hookPresent 恒 false，--runtime 分支永远只推一条"还没有钩子"。
const sourceForHook = ['app.mjs', 'bridge.js']
  .map((name) => {
    try { return fs.readFileSync(path.join(QQ_BRIDGE_DIR, 'src', name), 'utf8'); } catch { return ''; }
  })
  .join('\n');
const hookPresent = sourceForHook.includes('BRIDGE_CONFIG_CHECK');

if (runtime) {
  const defaultConfig = path.resolve(path.join(QQ_BRIDGE_DIR, 'config.json'));
  if (path.resolve(configPath) !== defaultConfig) {
    result.errors.push('--runtime 只能体检桥接真正加载的 qq-bridge/config.json；--config 指定的文件只参与静态形状比对。');
  } else if (!hookPresent) {
    result.errors.push('桥接源码还没有 BRIDGE_CONFIG_CHECK 钩子（S1 的 loadConfig 接线未执行）；本次只做静态检查。');
  } else {
    const run = spawnSync(process.execPath, [path.join(QQ_BRIDGE_DIR, 'src', 'bridge.js')], {
      cwd: QQ_BRIDGE_DIR,
      env: { ...process.env, BRIDGE_CONFIG_CHECK: '1' },
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    const marker = String(run.stdout ?? '').split('\n').find((line) => line.startsWith('[config-check] '));
    if (!marker) {
      result.errors.push(`运行时检查没有输出结果（exit=${run.status}）：${String(run.stderr ?? '').trim().slice(0, 300)}`);
    } else {
      try {
        const payload = JSON.parse(marker.slice('[config-check] '.length));
        result.runtimeAvailable = true;
        result.dropped = payload.dropped ?? [];
        result.droppedCount = payload.dropped?.length ?? 0;
      } catch (error) {
        result.errors.push(`运行时检查输出无法解析：${error.message}`);
      }
    }
  }
} else if (hookPresent) {
  result.runtimeAvailable = true;
  result.note = '桥接支持 --runtime，可精确检测「被白名单静默丢弃的键」';
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`配置：${path.relative(process.cwd(), configPath)}`);
  console.log(`样例：${path.relative(process.cwd(), examplePath)}`);
  for (const error of result.errors) console.log(`❌ ${error}`);
  for (const line of formatConfigReport(result)) console.log(line);
  if (result.note) console.log(`ℹ️ ${result.note}`);
}

const failed = result.errors.length > 0 || (strict && (result.dropped.length > 0 || result.missingInExample.length > 0));
process.exit(failed ? 1 : 0);
