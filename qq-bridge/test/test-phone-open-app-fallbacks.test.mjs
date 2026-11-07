import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const phoneSource = path.resolve(here, '../../ai-companion-kit/packages/phone-mcp/src/phone-mcp.js');

test('phone_open_app：包名快路有 monkey 兜底，桌面失败有应用抽屉兜底', () => {
  const src = fs.readFileSync(phoneSource, 'utf8');
  assert.ok(src.includes('resolvePackageActivity'), '缺少 PackageManager 组件解析');
  assert.ok(src.includes('am start -n ${comp}'), '缺少按组件启动');
  assert.ok(src.includes('launchPackageByMonkey'), '缺少 monkey 兜底函数');
  assert.ok(src.includes('monkey -p ${pkg} -c android.intent.category.LAUNCHER 1'), '缺少 monkey 启动命令');
  assert.ok(src.includes('[DRAWER-FALLBACK]'), '缺少应用抽屉兜底标记');
  assert.ok(src.includes('应用抽屉第${page}页'), '缺少抽屉分页扫描');
  assert.ok(src.includes('桌面 5 屏 + 应用抽屉 3 页'), '失败信息没有说明两层扫描');
});
