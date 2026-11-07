// 门敏感度动态调整（gate_tune）纯函数回归：范围、clamp、生效值、覆盖文档解析。
import assert from 'node:assert';
import {
  GATE_SENSITIVITY_RANGE,
  clampGateSensitivity,
  effectiveGateThreshold,
  parseGateSensitivityOverride,
} from '../src/domain/leaves/inori-gate.js';

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  passed += 1;
}

// 1. 范围本身在合理区间（48h 日志校准：0.40≈全过，0.80≈全堵）
ok(GATE_SENSITIVITY_RANGE.min === 0.4, 'min = 0.40');
ok(GATE_SENSITIVITY_RANGE.max === 0.8, 'max = 0.80');

// 2. clamp：范围内原样、范围外收边、非法值 null
ok(clampGateSensitivity(0.6) === 0.6, '范围内原样');
ok(clampGateSensitivity(0.3) === 0.4, '低于下收成 0.4');
ok(clampGateSensitivity(0.95) === 0.8, '高于上限收成 0.8');
ok(clampGateSensitivity('0.5') === 0.5, '数字字符串可以');
ok(clampGateSensitivity(undefined) === null, 'undefined → null');
ok(clampGateSensitivity('abc') === null, '非数字 → null');

// 3. 生效阈值：合法覆盖优先；空/非法覆盖回基线；都收进范围
ok(effectiveGateThreshold(0.55, 0.5) === 0.5, '合法覆盖优先');
ok(effectiveGateThreshold(0.55, null) === 0.55, '无覆盖用基线');
ok(effectiveGateThreshold(0.55, undefined) === 0.55, 'undefined 覆盖用基线');
ok(effectiveGateThreshold(0.55, '') === 0.55, '空串覆盖用基线');
ok(effectiveGateThreshold(0.55, 'abc') === 0.55, '非法覆盖回基线');
ok(effectiveGateThreshold(0.55, 0.3) === 0.4, '超界覆盖收进范围（不拒绝，收边）');
ok(effectiveGateThreshold(0.2, 0.9) === 0.8, '基线+覆盖都越界时按覆盖收边');

// 4. 覆盖文档解析：合法/带BOM/缺字段/损坏/非对象
ok(parseGateSensitivityOverride('{"cosThreshold":0.5,"by":"agent","reason":"群里太安静了"}').cosThreshold === 0.5, '合法文档');
const bom = parseGateSensitivityOverride('\uFEFF{"cosThreshold":0.45}');
ok(bom?.cosThreshold === 0.45, 'BOM 可剥');
const partial = parseGateSensitivityOverride('{"cosThreshold":"0.5"}');
ok(partial?.cosThreshold === 0.5, '数字字符串归一');
ok(parseGateSensitivityOverride('{"cosThreshold":"0.5"}')?.by === undefined, '缺失字段不带');
ok(parseGateSensitivityOverride('garbage') === null, '损坏 JSON → null');
ok(parseGateSensitivityOverride('[1,2,3]') === null, '顶层数组 → null');
ok(parseGateSensitivityOverride('') === null, '空串 → null');
ok(parseGateSensitivityOverride(null) === null, 'null → null');

console.log(`🎉 gate-tune 纯函数测试通过（${passed} 项）`);
